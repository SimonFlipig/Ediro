import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelCatalog,modelFromPreset,identifyPreset,modelIdentity } from '../src/protocols/model-catalog.js';
import { ModelLibrary,seedModels } from '../src/core/models.js';
import { mockDescription,migrateModels } from '../src/core/model-library.js';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ImagesGenerator } from '../src/adapters/images-generator.js';
import { validateGenerationParameters } from '../src/core/generation-parameters.js';
import { Workspace } from '../src/core/workspace.js';
import { MockGenerator } from '../src/adapters/mock-generator.js';
import { ProjectRepository } from '../src/adapters/project-repository.js';
import { openModelLibrary } from '../src/adapters/model-library-repository.js';
import { planExecution } from '../src/core/execution-plan.js';
import {maskEditMethod,planMaskRequest} from '../src/core/mask-request.js';
import {defaultMaskModel} from '../src/ui/mask-editor-state.js';
import type {MaskDraft} from '../src/core/mask.js';

function fixture(){const library=new ModelLibrary(seedModels().slice(0,2),async()=>{}, {has:async()=>true,set:async()=>{}},[mockDescription,new GeminiGenerator().description,new ImagesGenerator().description]);return library;}
async function enroll(library:ModelLibrary,preset:string,id:string,connection:string,remote?:string){
  if(!library.snapshot().connections.some(c=>c.connection_id===connection))await library.saveConnection({connection_id:connection,title:connection,endpoint:'https://example.com',enabled:true},'test-only');
  const m=modelFromPreset(preset,id,connection,remote??modelCatalog.find(p=>p.id===preset)!.aliases[0]);
  const {endpoint,executable,revision,...entry}=m;await library.saveModel({...entry,purpose:m.purpose!,capability_source:'documented'});return library.resolve(id);
}
test('catalog presets enroll with complete options and validated defaults; ambiguous aliases require a choice',async()=>{
  const library=fixture();
  for(const [i,preset] of modelCatalog.entries()){
    const model=await enroll(library,preset.id,`model_catalog_${i}`,'channel_catalog');validateGenerationParameters(model.defaults,model);
    assert.equal(model.purpose,preset.purpose);
    if(preset.purpose==='generation'){assert.ok(model.capabilities.aspect_ratios.includes('16:9'));assert.ok(model.capabilities.aspect_ratios.includes('9:16'));}
  }
  assert.equal(identifyPreset('models/gemini-3-pro-image')?.id,'nano-banana-pro');
  assert.equal(identifyPreset('gpt-image-2.5-sunburst-c'),undefined);
  assert.equal(identifyPreset('gpt-image-2.5'),undefined);
  assert.equal(library.resolve('model_catalog_4').generation_contract?.fields.some(f=>f.key==='thinking_level'),true);
});
test('a new channel reuses shared defaults, aliases keep their exact IDs, same binding cannot be duplicated',async()=>{
  const library=fixture();await enroll(library,'nano-banana-pro','model_a','channel_a');
  const a=library.snapshot().models.find(m=>m.model_config_id==='model_a')!;
  await library.saveModel({...a,defaults:{...a.defaults,aspect_ratio:'16:9',resolution:{mode:'tier',value:'4K'}}});
  const b=await enroll(library,'nano-banana-pro','model_b','channel_b','custom-alias');
  assert.equal(b.model,'custom-alias');assert.equal(b.defaults.aspect_ratio,'16:9');assert.deepEqual(b.defaults.resolution,{mode:'tier',value:'4K'});
  assert.equal(modelIdentity(library.resolve('model_a')),modelIdentity(b));
  await assert.rejects(()=>enroll(library,'nano-banana-pro','model_c','channel_b','custom-alias'),/已入库/);
});

test('Banana 请求预算按渠道保存和重载，同型号共享参数不会覆盖其他渠道预算',async()=>{
  const library=fixture();await enroll(library,'nano-banana-pro','model_a','channel_a');await enroll(library,'nano-banana-pro','model_b','channel_b');
  let a=library.snapshot().models.find(m=>m.model_config_id==='model_a')!;
  await library.saveModel({...a,gemini_compatibility:{max_request_mb:40}});
  assert.equal(library.resolve('model_a').gemini_compatibility?.max_request_mb,40);assert.equal(library.resolve('model_b').gemini_compatibility,undefined);
  const b=library.snapshot().models.find(m=>m.model_config_id==='model_b')!;
  await library.saveModel({...b,gemini_compatibility:{max_request_mb:80}});
  a=library.snapshot().models.find(m=>m.model_config_id==='model_a')!;
  await library.saveModel({...a,defaults:{...a.defaults,aspect_ratio:'16:9'}});
  const dir=await mkdtemp(path.join(os.tmpdir(),'ediro-gemini-budget-'));
  await writeFile(path.join(dir,'model-library.v3.json'),JSON.stringify(library.snapshot()));
  const reopened=new ModelLibrary(await openModelLibrary(dir),async()=>{},{has:async()=>true,set:async()=>{}},library.adapters);
  assert.equal(reopened.resolve('model_a').gemini_compatibility?.max_request_mb,40);assert.equal(reopened.resolve('model_b').gemini_compatibility?.max_request_mb,80);
  const listed=await reopened.list();assert.equal(listed.find(m=>m.model_config_id==='model_a')?.gemini_compatibility?.max_request_mb,40);
  assert.equal(reopened.resolve('model_b').defaults.aspect_ratio,'16:9');
});

test('所有平台的 Banana 与 Image 按入库预设进入局部编辑，渠道别名、限制和选择保持独立',async()=>{
  const library=fixture();
  const cases=[
    ['nano-banana-pro','model_official','channel_official','gemini-3-pro-image','guided'],
    ['nano-banana-pro','model_relay','channel_relay','relay-banana-vip','guided'],
    ['nano-banana-pro','model_private','channel_private','my-image-alias','guided'],
    ['gpt-image-2-5-sunburst','model_sunburst','channel_relay','gpt-image-2.5-sunburst-c','native'],
    ['gpt-image-2-5-flare','model_flare','channel_private','proxy-image-fast','native'],
    ['gpt-image-2','model_image2','channel_official','gpt-image-2','native'],
  ] as const;
  for(const [preset,id,connection,remote] of cases){
    await enroll(library,preset,id,connection,remote);
    const entry=library.snapshot().models.find(m=>m.model_config_id===id)!;
    await library.saveModel({...entry,capability_source:'user',capabilities:{...entry.capabilities,max_images:2,operations:['generate','referenceEdit']}});
  }
  await enroll(library,'gemini-3-1-pro','model_reasoning','channel_relay');
  const listed=await library.list(),eligible=listed.filter(m=>m.kind==='cloud'&&m.enabled&&maskEditMethod(m));
  assert.deepEqual(eligible.map(m=>m.model_config_id),cases.map(c=>c[1]));
  assert.equal(defaultMaskModel(eligible)?.model_config_id,'model_official');
  assert.equal(defaultMaskModel(eligible.filter(m=>m.connection_id==='channel_relay'))?.model_config_id,'model_relay');
  for(const [,id,connection,remote,method] of cases){
    const resolved=await library.execution(id),listedModel=eligible.find(m=>m.model_config_id===id)!;
    assert.equal(resolved.connection_id,connection);assert.equal(resolved.model,remote);assert.equal(resolved.capabilities.max_images,2);
    assert.equal(maskEditMethod(listedModel),method);
    const draft:MaskDraft={source_asset_id:'asset_test',width:1200,height:1200,strokes:[{tool:'paint',size:30,points:[[.5,.5]]}],instruction:'编辑选区',model_config_id:id,quality:resolved.defaults.quality,mode:'strict',feather:0};
    assert.equal(planMaskRequest(draft,resolved).method,method);
  }
  const entry=library.snapshot().models.find(m=>m.model_config_id==='model_relay')!;
  await library.saveModel({...entry,capabilities:{...entry.capabilities,max_images:1}});
  const restricted=library.resolve(entry.model_config_id);
  assert.throws(()=>planMaskRequest({source_asset_id:'asset_test',width:1200,height:1200,strokes:[{tool:'paint',size:30,points:[[.5,.5]]}],instruction:'编辑选区',model_config_id:entry.model_config_id,quality:restricted.defaults.quality,mode:'strict',feather:0},restricted),/两张参考图/);
});

test('局部编辑明确关闭持久化且只影响当前渠道，重新开启恢复预设能力，缺失协议不虚报支持',async()=>{
  const library=fixture();await enroll(library,'nano-banana-pro','model_a','channel_a');await enroll(library,'nano-banana-pro','model_b','channel_b');await enroll(library,'gpt-image-2-5-flare','model_c','channel_b');
  for(const [id,operation] of [['model_a','guidedMaskEdit'],['model_c','nativeMaskEdit']]){
    const entry=library.snapshot().models.find(m=>m.model_config_id===id)!;
    await library.saveModel({...entry,capability_source:'user',capabilities:{...entry.capabilities,disabled_operations:[operation]}});
    assert.equal(maskEditMethod(library.resolve(id)),undefined);
  }
  const reopened=new ModelLibrary(library.snapshot(),async()=>{},{has:async()=>true,set:async()=>{}},library.adapters);
  assert.equal(maskEditMethod(reopened.resolve('model_a')),undefined);assert.equal(maskEditMethod(reopened.resolve('model_c')),undefined);
  assert.equal(maskEditMethod(reopened.resolve('model_b')),'guided');
  const entry=reopened.snapshot().models.find(m=>m.model_config_id==='model_a')!;
  await reopened.saveModel({...entry,capabilities:{...entry.capabilities,operations:['generate','referenceEdit'],disabled_operations:[]}});
  assert.equal(maskEditMethod(reopened.resolve('model_a')),'guided');
  const unsupported=new ModelLibrary(reopened.snapshot(),async()=>{},{has:async()=>true,set:async()=>{}},reopened.adapters.map(a=>({...a,operations:a.operations.filter(op=>op!=='guidedMaskEdit')})));
  assert.equal(maskEditMethod(unsupported.resolve('model_a')),undefined);
});
test('workflow defaults are copied, switching models restores settings, switching channels preserves them, disk roundtrip retains both',async()=>{
  const library=fixture();await enroll(library,'nano-banana-pro','model_a','channel_a');await enroll(library,'nano-banana-pro','model_b','channel_b');await enroll(library,'gpt-image-2-5-flare','model_c','channel_c');
  await library.assign('generation','model_a');
  let a=library.snapshot().models.find(m=>m.model_config_id==='model_a')!;await library.saveModel({...a,defaults:{...a.defaults,aspect_ratio:'16:9'}});
  const directory=await mkdtemp(path.join(os.tmpdir(),'ediro-settings-work-')),workspace=new Workspace(library,new MockGenerator());await workspace.create(new ProjectRepository(directory),'settings');
  assert.equal(workspace.project!.recipe.core_parameters.aspect_ratio,'16:9');
  let r=structuredClone(workspace.project!.recipe);r.core_parameters.resolution={mode:'tier',value:'4K'};r.core_parameters.aspect_ratio='9:16';await workspace.saveRecipe(r);
  await workspace.selectModel('model_c');assert.equal(workspace.project!.recipe.core_parameters.quality,'auto');
  r=structuredClone(workspace.project!.recipe);r.core_parameters.quality='max';await workspace.saveRecipe(r);
  await workspace.selectModel('model_b');assert.equal(workspace.project!.recipe.core_parameters.aspect_ratio,'9:16');assert.deepEqual(workspace.project!.recipe.core_parameters.resolution,{mode:'tier',value:'4K'});
  a=library.snapshot().models.find(m=>m.model_config_id==='model_a')!;await library.saveModel({...a,defaults:{...a.defaults,aspect_ratio:'1:1',resolution:{mode:'tier',value:'2K'}}});
  await workspace.open(new ProjectRepository(directory));assert.equal(workspace.project!.recipe.core_parameters.aspect_ratio,'9:16');
  await workspace.selectModel('model_c');assert.equal(workspace.project!.recipe.core_parameters.quality,'max');
  await workspace.selectModel('model_a');await workspace.resetParameters();assert.equal(workspace.project!.recipe.core_parameters.aspect_ratio,'1:1');assert.deepEqual(workspace.project!.recipe.core_parameters.resolution,{mode:'tier',value:'2K'});
  const other=await mkdtemp(path.join(os.tmpdir(),'ediro-settings-new-'));await workspace.create(new ProjectRepository(other),'new');assert.equal(workspace.project!.recipe.core_parameters.aspect_ratio,'1:1');
});
test('migration backs up v2, preserves conflicting defaults and credentials, does not auto-resolve them when a channel is added',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ediro-settings-migration-')),old=migrateModels(seedModels());old.schema_version=2;
  const a=old.models[2];old.models.push({...structuredClone(a),model_config_id:'model_other',defaults:{...a.defaults,aspect_ratio:'16:9'}});old.connections[0].credential_ref='credential_preserved';
  const raw=JSON.stringify(old);await writeFile(path.join(dir,'model-library.v2.json'),raw);
  const migrated=await openModelLibrary(dir);assert.equal(migrated.schema_version,3);assert.equal(await readFile(path.join(dir,'model-library.pre-settings-v3.json'),'utf8'),raw);assert.equal(migrated.connections[0].credential_ref,'credential_preserved');
  const library=new ModelLibrary(migrated,async()=>{}, {has:async()=>true,set:async()=>{}},[mockDescription,new GeminiGenerator().description,new ImagesGenerator().description]);
  assert.equal(library.resolve('model_other').legacy_defaults_pending,true);assert.equal(library.resolve('model_other').defaults.aspect_ratio,'16:9');
  await enroll(library,'nano-banana-pro','model_new','channel_new');assert.equal(library.resolve('model_other').legacy_defaults_pending,true);
  const chosen=library.snapshot().models.find(m=>m.model_config_id==='model_other')!;await library.saveModel(chosen);assert.equal(library.resolve(a.model_config_id).defaults.aspect_ratio,'16:9');assert.equal(library.resolve('model_new').defaults.aspect_ratio,'16:9');
  assert.deepEqual(await openModelLibrary(dir),migrated);
});
test('interface-default resolution never reads a later Ediro default during planning',async()=>{
  const library=fixture(),model=await enroll(library,'nano-banana-pro','model_a','channel_a');
  const workspace=new Workspace(library,new MockGenerator());const directory=await mkdtemp(path.join(os.tmpdir(),'ediro-default-plan-'));await library.assign('generation','model_a');await workspace.create(new ProjectRepository(directory),'plan');
  const recipe=structuredClone(workspace.project!.recipe);recipe.modules.at(-1)!.user_instruction='a vase';recipe.core_parameters.resolution={mode:'default'};
  const changed={...model,defaults:{...model.defaults,resolution:{mode:'tier' as const,value:'4K'}}};
  assert.deepEqual(planExecution(recipe,[],changed).recipe.core_parameters.resolution,{mode:'tier',value:'1K'});
});

test('channel restrictions surface a conflict without resetting remembered workflow parameters',async()=>{
  const library=fixture();await enroll(library,'gpt-image-2-5-flare','model_a','channel_a');await enroll(library,'gpt-image-2-5-flare','model_b','channel_b');
  const b=library.snapshot().models.find(m=>m.model_config_id==='model_b')!;await library.saveModel({...b,capabilities:{...b.capabilities,qualities:['auto','low']}});
  await library.assign('generation','model_a');const dir=await mkdtemp(path.join(os.tmpdir(),'ediro-channel-limit-')),workspace=new Workspace(library,new MockGenerator());await workspace.create(new ProjectRepository(dir),'limited');
  const recipe=structuredClone(workspace.project!.recipe);recipe.core_parameters.quality='max';await workspace.saveRecipe(recipe);await workspace.selectModel('model_b');
  assert.equal(workspace.project!.recipe.core_parameters.quality,'max');assert.throws(()=>validateGenerationParameters(workspace.project!.recipe.core_parameters,library.resolve('model_b')),/质量/);
});

test('shared defaults save failure changes neither the source nor peer channels',async()=>{
  const library=fixture();await enroll(library,'nano-banana-pro','model_a','channel_a');await enroll(library,'nano-banana-pro','model_b','channel_b');const before=library.snapshot();
  const failing=new ModelLibrary(before,async()=>{throw new Error('disk full');},{has:async()=>true,set:async()=>{}},[mockDescription,new GeminiGenerator().description]);
  const model=before.models.find(m=>m.model_config_id==='model_a')!;await assert.rejects(()=>failing.saveModel({...model,defaults:{...model.defaults,aspect_ratio:'16:9'}}),/disk full/);assert.deepEqual(failing.snapshot(),before);
});

test('reasoning defaults reach the Gemini request and capture without real network calls',async()=>{
  const library=fixture(),model=await enroll(library,'gemini-3-1-pro','model_reasoning','channel_reasoning');
  const directory=await mkdtemp(path.join(os.tmpdir(),'ediro-reasoning-config-')),workspace=new Workspace(library,new MockGenerator());await workspace.create(new ProjectRepository(directory),'reasoning');
  const recipe=structuredClone(workspace.project!.recipe);recipe.model_config_id=model.model_config_id;recipe.core_parameters=structuredClone(model.defaults);recipe.core_parameters.extensions![model.adapter_id].temperature=0.8;recipe.core_parameters.extensions![model.adapter_id].thinking_level='low';recipe.modules.at(-1)!.user_instruction='test';
  const plan=planExecution(recipe,[],model);let sent:any;const captured:any[]=[];
  const generator=new GeminiGenerator(async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'ok'}]},finishReason:'STOP'}]}),{status:200});});
  const job={task_id:'task_settings',created_at:'now',status:'running' as const,stage:'test',progress:0,recipe_snapshot:plan.recipe,chain_snapshot:plan.chain,adapted_input:plan.adapted,execution_plan:plan.summary,model_snapshot:{model_config_id:model.model_config_id,title:model.title,provider:model.provider,model:model.model,adapter_id:model.adapter_id,revision:model.revision,kind:model.kind},output_asset_ids:[]};
  await generator.execute({job,model,readImage:async()=>{throw new Error('no images');},resolveCredential:async()=>'test-only',recordModelInput:async entry=>{captured.push(entry);}},new AbortController().signal,async()=>{});
  assert.equal(sent.generationConfig.temperature,0.8);assert.equal(sent.generationConfig.thinkingConfig.thinkingLevel,'LOW');assert.deepEqual(sent.generationConfig.responseModalities,['TEXT']);assert.equal(captured.length,1);assert.ok(!JSON.stringify(captured).includes('test-only'));
});
