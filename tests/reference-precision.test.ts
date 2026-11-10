import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {defaultModuleSettings,moduleSettingsSchema,referencePrecisionModules,type ModuleSettings} from '../src/core/module-settings.js';
import {referencePrecisionDefault} from '../src/core/reference-precision.js';
import {loadModuleSettings,saveModuleSettings} from '../src/adapters/module-settings-repository.js';
import {ModuleRegistry} from '../src/core/modules.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {Workspace} from '../src/core/workspace.js';
import {ProjectRepository} from '../src/adapters/project-repository.js';
import {planExecution} from '../src/core/execution-plan.js';
import {normalizeParameters} from '../src/core/generation-parameters.js';
import {GeminiGenerator} from '../src/adapters/gemini-generator.js';
import type {Job,Recipe} from '../src/core/domain.js';

async function directory(){
  const root=path.join(process.cwd(),'.local','test-reference-precision');
  await mkdir(root,{recursive:true});return mkdtemp(path.join(root,'case-'));
}
function defaults():ModuleSettings{return {...structuredClone(defaultModuleSettings),reference_precision:{image_text:'medium',subject:'high',composition:'low',style:'ultra_high',viewpoint:'inherit'}};}

test('五类参考图精度默认值独立保存，旧设置保持跟随全局且拒绝非法值',async()=>{
  const root=await directory(),settings=defaults();
  assert.deepEqual(referencePrecisionModules.map(module=>module.type).sort(),['composition','image_text','style','subject','viewpoint']);
  await saveModuleSettings(root,settings);
  assert.deepEqual(await loadModuleSettings(root),settings);
  const legacy=moduleSettingsSchema.parse({version:1,composition:{max_edge:512},style:{max_edge:1024}});
  for(const module of referencePrecisionModules)assert.equal(referencePrecisionDefault({reference_type:module.type},legacy),'inherit');
  assert.throws(()=>moduleSettingsSchema.parse({...settings,reference_precision:{subject:'maximum'}}));
  assert.throws(()=>moduleSettingsSchema.parse({...settings,reference_precision:{prompt:'high'}}));
  assert.equal(referencePrecisionDefault({reference_type:'subject'},settings,['low','medium']),'inherit');
  assert.equal(referencePrecisionDefault({reference_type:'subject',reference_precision:'low'},settings,['low','high']),'low');
});

test('模块精度随新建、复制、类型切换和工程重开保存，旧模块复制时冻结默认值',async()=>{
  const repository=new ProjectRepository(await directory());
  const models=new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}});
  const workspace=new Workspace(models,{execute:async()=>{throw Error('不得调用模型');}});
  workspace.moduleSettings=defaults();
  await workspace.create(repository,'参考图精度');
  const registry=workspace.registry;
  for(const item of referencePrecisionModules)assert.equal(registry.create(item.type,workspace.moduleSettings).reference_precision,workspace.moduleSettings.reference_precision![item.type]);
  assert.equal(registry.create('prompt',workspace.moduleSettings).reference_precision,undefined);
  const subject=workspace.project!.recipe.modules.find(module=>module.reference_type==='subject')!;
  const subjectId=subject.module_id;
  workspace.moduleSettings.reference_precision!.subject='low';
  await workspace.copyModule(subjectId);
  const copy=workspace.project!.recipe.modules[workspace.project!.recipe.modules.findIndex(module=>module.module_id===subjectId)+1];
  assert.equal(copy.reference_precision,'high');
  await workspace.changeReferenceType(subjectId,'style');
  assert.equal(workspace.project!.recipe.modules.find(module=>module.module_id===subjectId)!.reference_precision,'ultra_high');
  await workspace.open(repository);
  assert.equal(workspace.project!.recipe.modules.find(module=>module.module_id===copy.module_id)!.reference_precision,'high');
  assert.equal(workspace.project!.recipe.modules.find(module=>module.module_id===subjectId)!.reference_precision,'ultra_high');
  const legacy=registry.create('subject');delete legacy.reference_precision;
  const copied=registry.copy(legacy,workspace.moduleSettings);
  workspace.moduleSettings.reference_precision!.subject='medium';
  assert.equal(copied.reference_precision,'low');
  assert.equal(referencePrecisionDefault(legacy,workspace.moduleSettings),'medium');
  await workspace.shutdown();
});

function fixture(strategy:'interleaved'|'numbered_flat'='interleaved'){
  const settings=defaults(),model=seedModels()[2],registry=new ModuleRegistry();
  const subject=registry.create('subject',settings),style=registry.create('style',settings),prompt=registry.create('prompt');
  subject.asset_ids=['asset_shared'];style.asset_ids=['asset_shared'];prompt.user_instruction='保持主体，采用参考风格';
  const recipe:Recipe={recipe_id:'recipe_precision',schema_version:1,input_strategy:strategy,modules:[subject,style,prompt],model_config_id:model.model_config_id,core_parameters:normalizeParameters(model.defaults,model)};
  const plan=planExecution(recipe,[{asset_id:'asset_shared',width:12,height:12}],model,registry);
  const job:Job={task_id:'task_precision',status:'queued',stage:'test',progress:0,created_at:'2026-10-27',recipe_snapshot:plan.recipe,chain_snapshot:plan.chain,adapted_input:plan.adapted,output_geometry:plan.geometry,execution_plan:plan.summary,module_settings_snapshot:structuredClone(settings),model_snapshot:{model_config_id:model.model_config_id,model:model.model,provider:model.provider,adapter_id:model.adapter_id,kind:model.kind,revision:model.revision,title:model.title},output_asset_ids:[]};
  return {settings,model,recipe,job};
}
const image=sharp({create:{width:12,height:12,channels:3,background:'#fff'}}).png().toBuffer();
async function request(f:ReturnType<typeof fixture>){
  const png=await image;let captured:any,calls=0;
  const adapter=new GeminiGenerator(async(_url,init)=>{
    calls++;captured=JSON.parse(init!.body as string);
    return Response.json({candidates:[{content:{parts:f.model.purpose==='understanding'?[{text:'理解结果'}]:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]});
  });
  await adapter.execute({model:f.model,job:f.job,readImage:async()=>png,resolveCredential:async()=>'test'},new AbortController().signal,async()=>{});
  assert.equal(calls,1);return captured;
}
const levels=(body:any)=>body.contents[0].parts.filter((part:any)=>part.inlineData).map((part:any)=>part.mediaResolution?.level);

test('原生与拍平请求按模块解析同一素材的默认精度，逐图覆盖和主动跟随全局优先',async()=>{
  for(const strategy of ['interleaved','numbered_flat'] as const){
    const f=fixture(strategy);
    assert.deepEqual(levels(await request(f)),['MEDIA_RESOLUTION_HIGH','MEDIA_RESOLUTION_ULTRA_HIGH']);
    const options=f.job.recipe_snapshot.core_parameters.extensions![f.model.adapter_id]??={};
    options.reference_precision='medium';options.reference_overrides={asset_shared:'low'};
    const explicit=await request(f);
    assert.deepEqual(levels(explicit),['MEDIA_RESOLUTION_LOW','MEDIA_RESOLUTION_LOW']);
    assert.equal(explicit.generationConfig.mediaResolution,'MEDIA_RESOLUTION_MEDIUM');
    options.reference_overrides={asset_shared:'inherit'};
    const global=await request(f);
    assert.deepEqual(levels(global),[undefined,undefined]);
    assert.equal(global.generationConfig.mediaResolution,'MEDIA_RESOLUTION_MEDIUM');
    options.reference_overrides={};
    assert.deepEqual(levels(await request(f)),['MEDIA_RESOLUTION_HIGH','MEDIA_RESOLUTION_ULTRA_HIGH']);
  }
});

test('任务快照冻结模块默认值，旧模块采用任务内设置，旧任务保持全局行为',async()=>{
  const f=fixture();
  f.settings.reference_precision!.subject='low';
  f.recipe.modules[0].reference_precision='medium';
  assert.deepEqual(levels(await request(f)),['MEDIA_RESOLUTION_HIGH','MEDIA_RESOLUTION_ULTRA_HIGH']);
  delete f.job.recipe_snapshot.modules[0].reference_precision;
  assert.deepEqual(levels(await request(f)),['MEDIA_RESOLUTION_HIGH','MEDIA_RESOLUTION_ULTRA_HIGH']);
  delete f.job.recipe_snapshot.modules[1].reference_precision;
  delete f.job.module_settings_snapshot;
  assert.deepEqual(levels(await request(f)),[undefined,undefined]);
});

test('不支持逐图参数或所选档位时回到全局，理解任务不继承生图模块默认',async()=>{
  const disabled=fixture();
  disabled.model.capabilities.parameter_limits={reference_overrides:{enabled:false}};
  assert.deepEqual(levels(await request(disabled)),[undefined,undefined]);
  const limited=fixture();
  limited.model.capabilities.parameter_limits={reference_overrides:{values:['low','medium','high']}};
  assert.deepEqual(levels(await request(limited)),['MEDIA_RESOLUTION_HIGH',undefined]);
  const understanding=fixture();understanding.model.purpose='understanding';
  assert.deepEqual(levels(await request(understanding)),[undefined,undefined]);
});
