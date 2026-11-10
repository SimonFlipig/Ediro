import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ProjectRepository } from '../src/adapters/project-repository.js';
import { modelForEnrollment } from '../src/protocols/model-catalog.js';
import { snapshotParameters } from '../src/core/model-settings.js';
import { planExecution } from '../src/core/execution-plan.js';
import { planMaskRequest } from '../src/core/mask-request.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { ModelLibrary } from '../src/core/models.js';
import { Workspace } from '../src/core/workspace.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import type { ModelInput } from '../src/core/model-input.js';
import type { Job,ModelConfig,Recipe } from '../src/core/domain.js';

const namespace='gemini-generate-content';
const png=await sharp({create:{width:16,height:16,channels:3,background:'#fff'}}).png().toBuffer();
function fixture(id:string,level?:string,override?:ModelConfig['nano_model_override'],reference=false):CloudExecutionContext{
  const model=modelForEnrollment('nano',namespace,'model_nano','connection_nano',id);
  model.endpoint='https://nano-test.invalid';model.executable=true;
  if(override)model.nano_model_override=override;
  if(level)model.defaults.extensions![namespace].thinking_level=level;
  const registry=new ModuleRegistry(),prompt=registry.create('prompt'),subject=registry.create('subject');
  prompt.user_instruction='绘制白色杯子';if(reference)subject.asset_ids=['asset_reference'];
  const recipe:Recipe={recipe_id:'recipe_nano',schema_version:1,model_config_id:model.model_config_id,modules:[subject,prompt],core_parameters:snapshotParameters(model.defaults,model)};
  const plan=planExecution(recipe,reference?[{asset_id:'asset_reference',width:16,height:16}]:[],model,registry);
  const job:Job={task_id:'task_nano',created_at:'now',status:'running',stage:'test',progress:0,recipe_snapshot:plan.recipe,chain_snapshot:plan.chain,adapted_input:plan.adapted,execution_plan:plan.summary,output_geometry:plan.geometry,model_snapshot:{model_config_id:model.model_config_id,title:model.title,provider:model.provider,model:model.model,adapter_id:model.adapter_id,revision:model.revision,kind:model.kind,nano_model_override:override},output_asset_ids:[]};
  return {model,job,readImage:async()=>png,resolveCredential:async()=>'fixture-only-key'};
}
const imageResponse=()=>Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]},finishReason:'STOP'}]});

test('Nano 生图与参考图请求发送选择的推理强度，捕获正文与发送正文完全相同',async()=>{
  for(const reference of [false,true])for(const [id,levels] of [
    ['gemini-nano-banana-2.1',['minimal','medium','high']],
    ['gemini-3.1-flash-image-preview',['minimal','high']],
    ['gemini-3-pro-image-2k',['high']],
  ] as const)for(const level of levels){
    const context=fixture(id,level,undefined,reference);let captured:ModelInput|undefined,calls=0;
    context.recordModelInput=async input=>{captured=input;};
    const generator=new GeminiGenerator(async(url,init)=>{
      calls++;assert.equal(String(url),`https://nano-test.invalid/v1beta/models/${id}:generateContent`);
      assert.equal(captured?.body.encoding,'json');if(captured?.body.encoding!=='json')throw new Error('missing capture');
      assert.equal(captured.body.json,init?.body);const body=JSON.parse(String(init?.body));
      assert.deepEqual(body.generationConfig.thinkingConfig,{thinkingLevel:level.toUpperCase()});
      assert.deepEqual(body.generationConfig.responseModalities,['TEXT','IMAGE']);
      assert.equal(body.generationConfig.imageConfig.imageSize,'1K');
      assert.equal(body.generationConfig.temperature,undefined);
      assert.equal(body.contents[0].parts.filter((part:any)=>part.inlineData).length,reference?1:0);
      assert.ok(!JSON.stringify(captured).includes('fixture-only-key'));return imageResponse();
    });
    const result=await generator.execute(context,new AbortController().signal,async()=>{});
    assert.equal(calls,1);assert.equal(result.images.length,1);
  }
});

test('模型默认和未知别名均省略 thinkingConfig；手动修正只改变能力，不改调用 ID',async()=>{
  for(const id of ['gemini-nano-banana-2.1','gemini-3.1-flash-image','gemini-3-pro-image','unrecognized-relay']){
    const context=fixture(id);
    await new GeminiGenerator(async(_url,init)=>{assert.equal(JSON.parse(String(init?.body)).generationConfig.thinkingConfig,undefined);return imageResponse();}).execute(context,new AbortController().signal,async()=>{});
  }
  const context=fixture('private-image-route','medium','2.1');
  await new GeminiGenerator(async(url,init)=>{assert.match(String(url),/\/private-image-route:generateContent$/);assert.equal(JSON.parse(String(init?.body)).generationConfig.thinkingConfig.thinkingLevel,'MEDIUM');return imageResponse();}).execute(context,new AbortController().signal,async()=>{});
});

test('不支持的档位在鉴权和发送之前被拒绝，上游拒绝时不静默改档或重试',async()=>{
  let calls=0,credentials=0,captures=0;
  for(const [id,level] of [['gemini-3-pro-image','low'],['gemini-nano-banana-2.1','low'],['gemini-3.1-flash-image','medium'],['unknown','high']]){
    const context=fixture(id);context.job.recipe_snapshot.core_parameters.extensions![namespace].thinking_level=level;
    context.resolveCredential=async()=>{credentials++;return 'fixture-only-key';};context.recordModelInput=async()=>{captures++;};
    await assert.rejects(()=>new GeminiGenerator(async()=>{calls++;return imageResponse();}).execute(context,new AbortController().signal,async()=>{}),/推理强度|thinking_level/);
  }
  assert.equal(calls,0);assert.equal(credentials,0);assert.equal(captures,0);
  const context=fixture('gemini-nano-banana-2.1','high');
  await assert.rejects(()=>new GeminiGenerator(async()=>{calls++;return Response.json({error:'fixture rejection'},{status:400});}).execute(context,new AbortController().signal,async()=>{}),/拒绝请求参数/);
  assert.equal(calls,1);
});

test('黑白区域图编辑沿用模型的推理默认值并发送，图片顺序不变',async()=>{
  const context=fixture('private-edit-route','medium','2.1');
  const plan=planMaskRequest({source_asset_id:'asset_source',width:16,height:16,strokes:[{tool:'paint',size:4,points:[[.5,.5]]}],instruction:'修改杯子的颜色',model_config_id:context.model.model_config_id,quality:'standard',mode:'strict',feather:0},context.model);
  context.job.recipe_snapshot.core_parameters=plan.parameters;
  context.job.mask_edit={method:'guided',request_source_id:'asset_source',guide_asset_id:'asset_guide',crop:{x:0,y:0,width:16,height:16}} as Job['mask_edit'];
  const origin={source_module_id:'module_prompt',reference_type:'mask_edit',reference_id:'ref_prompt'};
  context.job.adapted_input={kind:'native_blocks',blocks:[{type:'image',asset_id:'asset_source',...origin},{type:'image',asset_id:'asset_guide',...origin},{type:'text',text:'修改白色区域',...origin}],adjustments:[]};
  await new GeminiGenerator(async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'MEDIUM');assert.equal(body.contents[0].parts.length,3);assert.ok(body.contents[0].parts[0].inlineData);assert.ok(body.contents[0].parts[1].inlineData);return imageResponse();}).execute(context,new AbortController().signal,async()=>{});
});

test('排队任务和工程重载保留手动型号及强度快照，之后修改后台不会追改任务',async()=>{
  const context=fixture('private-queue-route','medium','2.1');
  const {endpoint,executable,revision,...entry}=context.model;
  const library=new ModelLibrary({schema_version:3,connections:[{connection_id:'connection_nano',title:'fixture',endpoint,enabled:true,revision:1,credential_ref:'credential_fixture'}],models:[{...entry,revision:1}],assignments:{generation_default:entry.model_config_id}},async()=>{},{has:async()=>true,set:async()=>{}},[new GeminiGenerator().description]);
  const root=path.join(process.cwd(),'.local','nano-generation-tests');await mkdir(root,{recursive:true});
  const repository=new ProjectRepository(await mkdtemp(path.join(root,'case-')));
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
  let executedOverride:string|undefined,executedLevel:unknown;
  const workspace=new Workspace(library,{execute:async({model,job})=>{started();await gate;executedOverride=model.nano_model_override;executedLevel=job.recipe_snapshot.core_parameters.extensions![namespace].thinking_level;throw new Error('fixture-stop');}});
  let complete!:()=>void;const completed=new Promise<void>(resolve=>{complete=resolve;});
  workspace.onChange=async()=>{if(workspace.project?.jobs[0]?.status==='failed')complete();};
  await workspace.create(repository,'Nano snapshot');const recipe=structuredClone(workspace.project!.recipe);recipe.modules.at(-1)!.user_instruction='绘制杯子';await workspace.saveRecipe(recipe);
  await workspace.enqueue(false);await began;
  try{
    const saved=library.snapshot().models[0];const defaults=structuredClone(saved.defaults);delete defaults.extensions![namespace].thinking_level;
    await library.saveModel({...saved,nano_model_override:'pro',defaults});
  }finally{release();}
  await completed;await workspace.flush();
  const loaded=await repository.load(),job=loaded.jobs[0];
  assert.equal(executedOverride,'2.1');assert.equal(executedLevel,'medium');assert.match(job.error??'',/fixture-stop/);
  assert.equal(job.model_snapshot.nano_model_override,'2.1');assert.equal(job.model_snapshot.model,'private-queue-route');
  assert.equal(job.recipe_snapshot.core_parameters.extensions![namespace].thinking_level,'medium');
  assert.deepEqual(job.execution_plan?.contract.fields.find(f=>f.key==='thinking_level')?.values,['minimal','medium','high']);
  assert.equal(loaded.recipe.core_parameters.extensions![namespace].thinking_level,'medium');
  assert.equal(library.resolve(entry.model_config_id).nano_model_override,'pro');
});
