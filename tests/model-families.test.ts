import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Job,ModelConfig,Recipe} from '../src/core/domain.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {Workspace} from '../src/core/workspace.js';
import {mockDescription} from '../src/core/model-library.js';
import {selectWorkflowModel} from '../src/core/model-settings.js';
import {parameterFields,validateGenerationParameters} from '../src/core/generation-parameters.js';
import {bindHistoricalRecipe,historicalPreset} from '../src/core/historical-model.js';
import {GeminiGenerator} from '../src/adapters/gemini-generator.js';
import {ImagesGenerator} from '../src/adapters/images-generator.js';
import {ChatCompletionsAdapter} from '../src/adapters/chat-completions.js';
import {openModelLibrary} from '../src/adapters/model-library-repository.js';
import {ProjectRepository} from '../src/adapters/project-repository.js';
import {familiesForAdapter,familyForModel,findPreset,identifyPreset,modelCatalog,modelFamilies,modelForEnrollment,modelFromPreset,modelIdentity} from '../src/protocols/model-catalog.js';

function library(){return new ModelLibrary(seedModels().slice(0,2),async()=>{}, {has:async()=>true,set:async()=>{}},[mockDescription,new GeminiGenerator().description,new ImagesGenerator().description,new ChatCompletionsAdapter().description]);}
async function save(models:ModelLibrary,model:ModelConfig){
  if(!models.snapshot().connections.some(c=>c.connection_id===model.connection_id))await models.saveConnection({connection_id:model.connection_id!,title:model.connection_id!,adapter_id:model.adapter_id,endpoint:'https://fixture.invalid',enabled:true},'fixture-only');
  const {endpoint,executable,revision,...entry}=model;
  await models.saveModel({...entry,purpose:model.purpose??'generation',capability_source:model.capability_source??'user'});
  return models.resolve(model.model_config_id);
}
function entry(models:ModelLibrary,id:string){return models.snapshot().models.find(m=>m.model_config_id===id)!;}
function recipe(model:ModelConfig):Recipe{return {recipe_id:'recipe_families',schema_version:1,modules:[],model_config_id:model.model_config_id,model_preset_id:model.preset_id,core_parameters:structuredClone(model.defaults)};}

test('新增入口只有三个家族和当前主力配置，退役型号仍可准确读取',()=>{
  assert.deepEqual(modelFamilies.map(f=>f.id),['reasoning','nano','gpt-image']);
  assert.deepEqual(modelCatalog.map(p=>p.id),['nano-banana-pro','gpt-image-2-5-sunburst','gemini-3-1-pro']);
  assert.deepEqual(familiesForAdapter('gemini-generate-content').map(f=>f.id),['reasoning','nano']);
  assert.deepEqual(familiesForAdapter('openai-chat-completions').map(f=>f.id),['reasoning']);
  assert.deepEqual(familiesForAdapter('openai-images').map(f=>f.id),['gpt-image']);
  assert.equal(findPreset('gpt-image-2-5-flare')?.family,'gpt-image');
  assert.equal(identifyPreset('gpt-image-2-2026-04-21')?.id,'gpt-image-2');
});

test('已知模型准确匹配，未知别名复制家族基础配置且不冒充已核对型号',()=>{
  const known=modelForEnrollment('nano','gemini-generate-content','model_known','connection_a','models/gemini-3-pro-image-preview');
  assert.equal(known.model,'models/gemini-3-pro-image-preview');
  assert.equal(known.preset_id,'nano-banana-pro');assert.equal(known.capability_source,'documented');assert.equal(known.independent_defaults,true);
  const unknown=modelForEnrollment('nano','gemini-generate-content','model_unknown','connection_b','  relay-nano-next  ');
  assert.equal(unknown.model,'relay-nano-next');assert.equal(unknown.title,'relay-nano-next');assert.equal(unknown.preset_id,undefined);assert.equal(unknown.capability_source,'user');
  assert.equal(familyForModel(unknown),'nano');assert.deepEqual(unknown.capabilities,findPreset('nano-banana-pro')!.config.capabilities);
  unknown.capabilities.max_images=2;unknown.defaults.aspect_ratio='16:9';
  const another=modelForEnrollment('nano','gemini-generate-content','model_another','connection_c','another-alias');
  assert.equal(another.capabilities.max_images,14);assert.equal(another.defaults.aspect_ratio,'auto');
  assert.equal(findPreset('nano-banana-pro')!.config.capabilities.max_images,14);
  assert.equal(identifyPreset('gpt-image-2.5-sunburst-c'),undefined);
});

test('家族与协议或已知生图型号不匹配时不创建误配置',async()=>{
  assert.throws(()=>modelForEnrollment('nano','openai-images','model_bad','connection_bad','remote'),/不支持/);
  assert.throws(()=>modelForEnrollment('gpt-image','openai-images','model_bad','connection_bad','gemini-3-pro-image'),/不匹配/);
  assert.throws(()=>modelForEnrollment('nano','gemini-generate-content','model_bad','connection_bad','gemini-3.1-pro'),/不匹配/);
  assert.throws(()=>modelForEnrollment('reasoning','gemini-generate-content','model_bad','connection_bad','gemini-3-pro-image'),/不匹配/);
  assert.throws(()=>modelForEnrollment('reasoning','openai-chat-completions','model_bad','connection_bad','gpt-image-2.5-sunburst'),/不匹配/);
  const models=library(),model=modelForEnrollment('nano','gemini-generate-content','model_bad','connection_bad','remote');
  await assert.rejects(()=>save(models,{...model,family:'reasoning'}),/家族与接口协议或用途不匹配/);
});

test('未知推理模型须明确启用看图，Gemini 与 Chat 各自保留推理参数定义',async()=>{
  const models=library();
  const gemini=await save(models,modelForEnrollment('reasoning','gemini-generate-content','model_gemini','connection_gemini','relay-reasoning'));
  assert.equal(gemini.capabilities.max_images,0);assert.equal(gemini.preset_id,undefined);assert.equal(gemini.purpose,'understanding');
  assert.ok(parameterFields(gemini).some(f=>f.key==='thinking_level'));assert.ok(!parameterFields(gemini).some(f=>f.key==='response_mode'));
  validateGenerationParameters(gemini.defaults,gemini);
  const chat=await save(models,modelForEnrollment('reasoning','openai-chat-completions','model_chat','connection_chat','remote-reasoner'));
  assert.equal(chat.capabilities.max_images,0);assert.equal(chat.capability_source,'user');assert.equal(chat.preset_id,undefined);
  assert.ok(!parameterFields(chat).some(f=>f.key==='thinking_level'||f.key==='google_search'));validateGenerationParameters(chat.defaults,chat);
  const visual=modelForEnrollment('reasoning','openai-chat-completions','model_visual','connection_chat','remote-vision',true);
  assert.ok(visual.capabilities.max_images>0);
  assert.equal(modelForEnrollment('reasoning','gemini-generate-content','model_known','connection_gemini','gemini-3.1-pro').capabilities.max_images,64);
  const compatibleGemini=modelForEnrollment('reasoning','openai-chat-completions','model_alias','connection_chat','gemini-3.1-pro');
  assert.equal(compatibleGemini.adapter_id,'openai-chat-completions');assert.equal(compatibleGemini.preset_id,undefined);assert.equal(compatibleGemini.capability_source,'user');
});

test('新增同型号的默认值独立，旧共享配置与新独立配置双向均不串改',async()=>{
  const models=library();
  await save(models,modelFromPreset('nano-banana-pro','model_old_a','connection_old_a','legacy-nano-a'));
  await save(models,modelFromPreset('nano-banana-pro','model_old_b','connection_old_b','legacy-nano-b'));
  await models.saveModel({...entry(models,'model_old_a'),defaults:{...entry(models,'model_old_a').defaults,aspect_ratio:'16:9'}});
  const fresh=await save(models,modelForEnrollment('nano','gemini-generate-content','model_new_a','connection_new_a','gemini-3-pro-image'));
  await save(models,modelForEnrollment('nano','gemini-generate-content','model_new_b','connection_new_b','gemini-3-pro-image'));
  assert.equal(fresh.defaults.aspect_ratio,'auto');
  await models.saveModel({...entry(models,'model_new_a'),defaults:{...entry(models,'model_new_a').defaults,aspect_ratio:'9:16'}});
  assert.equal(models.resolve('model_new_b').defaults.aspect_ratio,'auto');assert.equal(models.resolve('model_old_a').defaults.aspect_ratio,'16:9');assert.equal(models.resolve('model_old_b').defaults.aspect_ratio,'16:9');
  await models.saveModel({...entry(models,'model_old_b'),defaults:{...entry(models,'model_old_b').defaults,aspect_ratio:'4:3'}});
  assert.equal(models.resolve('model_old_a').defaults.aspect_ratio,'4:3');assert.equal(models.resolve('model_new_a').defaults.aspect_ratio,'9:16');assert.equal(models.resolve('model_new_b').defaults.aspect_ratio,'auto');
  await models.saveModel({...entry(models,'model_new_a'),independent_defaults:undefined});
  assert.equal(models.resolve('model_new_a').independent_defaults,true);assert.equal(models.resolve('model_old_b').defaults.aspect_ratio,'4:3');
  const stored=models.snapshot(),reopened=new ModelLibrary(stored,async()=>{},{has:async()=>true,set:async()=>{}},models.adapters);
  assert.deepEqual(reopened.snapshot(),stored);assert.equal(reopened.resolve('model_new_a').defaults.aspect_ratio,'9:16');
});

test('旧接入编辑为独立配置后保留当前默认值，后续旧渠道修改不会覆盖它',async()=>{
  const models=library();
  await save(models,modelFromPreset('nano-banana-pro','model_old_a','connection_old_a','legacy-a'));
  await save(models,modelFromPreset('nano-banana-pro','model_old_b','connection_old_b','legacy-b'));
  await models.saveModel({...entry(models,'model_old_a'),defaults:{...entry(models,'model_old_a').defaults,aspect_ratio:'16:9'}});
  await models.saveModel({...entry(models,'model_old_a'),independent_defaults:true,family:'nano'});
  await models.saveModel({...entry(models,'model_old_b'),defaults:{...entry(models,'model_old_b').defaults,aspect_ratio:'9:16'}});
  assert.equal(models.resolve('model_old_a').defaults.aspect_ratio,'16:9');assert.equal(models.resolve('model_old_b').defaults.aspect_ratio,'9:16');
  assert.equal(modelIdentity(models.resolve('model_old_a')),'model_old_a');assert.equal(modelIdentity(models.resolve('model_old_b')),'nano-banana-pro');
});

test('工作流记住每个新接入的参数，不因同家族或同预设串用设置',()=>{
  const a=modelForEnrollment('nano','gemini-generate-content','model_a','connection_a','gemini-3-pro-image');
  const b=modelForEnrollment('nano','gemini-generate-content','model_b','connection_b','gemini-3-pro-image');
  const c=modelForEnrollment('nano','gemini-generate-content','model_c','connection_c','future-banana');
  let current=recipe(a);current.core_parameters.aspect_ratio='16:9';
  current=selectWorkflowModel(current,b,a);assert.equal(current.core_parameters.aspect_ratio,'auto');
  current.core_parameters.aspect_ratio='9:16';
  current=selectWorkflowModel(current,c,b);assert.equal(current.core_parameters.aspect_ratio,'auto');
  current=selectWorkflowModel(current,a,c);assert.equal(current.core_parameters.aspect_ratio,'16:9');
  current=selectWorkflowModel(current,b,a);assert.equal(current.core_parameters.aspect_ratio,'9:16');
  assert.deepEqual(current.model_channels,{model_a:'model_a',model_b:'model_b',model_c:'model_c','nano-banana-pro':'model_b'});
});

test('旧接入改为独立默认值后仅恢复属于该接入的旧工作流参数',()=>{
  const legacy=modelFromPreset('nano-banana-pro','model_legacy','connection_legacy','gemini-3-pro-image');
  const converted={...legacy,independent_defaults:true,family:'nano' as const};
  const currentModel=modelForEnrollment('gpt-image','openai-images','model_current','connection_current','gpt-image-2.5-sunburst');
  const current=recipe(currentModel);
  current.model_parameters={'nano-banana-pro':{...structuredClone(legacy.defaults),aspect_ratio:'16:9'}};
  current.model_channels={'nano-banana-pro':'model_legacy'};
  const restored=selectWorkflowModel(current,converted,currentModel);
  assert.equal(restored.core_parameters.aspect_ratio,'16:9');assert.equal(restored.model_channels?.model_legacy,'model_legacy');
  const fresh=modelForEnrollment('nano','gemini-generate-content','model_fresh','connection_fresh','gemini-3-pro-image');
  assert.equal(selectWorkflowModel(current,fresh,currentModel).core_parameters.aspect_ratio,'auto');
  const ambiguous=structuredClone(current);delete ambiguous.model_channels;
  assert.equal(selectWorkflowModel(ambiguous,converted,currentModel).core_parameters.aspect_ratio,'auto');
});

test('退役型号历史配方仍只绑定相同具体型号，保存的历史快照不被家族设置改写',async()=>{
  const models=library();
  const old=modelFromPreset('gpt-image-2','model_removed','connection_removed','gpt-image-2');
  const original=recipe(old);original.core_parameters.quality='high';
  const job:Job={task_id:'task_history',status:'succeeded',stage:'done',progress:100,created_at:'2026-09-01',recipe_snapshot:structuredClone(original),chain_snapshot:{mode:'text_to_image',blocks:[]},model_snapshot:{model_config_id:old.model_config_id,preset_id:old.preset_id,title:old.title,provider:old.provider,model:old.model,adapter_id:old.adapter_id,revision:old.revision,kind:old.kind},output_asset_ids:[]};
  const before=structuredClone({original,job});
  await save(models,modelForEnrollment('gpt-image','openai-images','model_sunburst','connection_sunburst','gpt-image-2.5-sunburst'));
  assert.equal(bindHistoricalRecipe(original,[job],await models.list()).model_config_id,'model_removed');
  await save(models,modelForEnrollment('gpt-image','openai-images','model_legacy','connection_legacy','gpt-image-2'));
  const restored=bindHistoricalRecipe(original,[job],await models.list());
  assert.equal(restored.model_config_id,'model_legacy');assert.equal(restored.model_preset_id,'gpt-image-2');assert.equal(restored.core_parameters.quality,'high');
  const noPreset=structuredClone(original);delete noPreset.model_preset_id;
  const noSnapshotPreset=structuredClone(job);delete noSnapshotPreset.model_snapshot.preset_id;
  assert.equal(historicalPreset(noPreset,[noSnapshotPreset]),'gpt-image-2');
  assert.deepEqual({original,job},before);
});

test('历史渠道删除后恢复到最近明确选择的同型号渠道，优先于全局默认且不串用参数',async t=>{
  const models=library();
  const a=await save(models,modelForEnrollment('nano','gemini-generate-content','model_a','connection_a','gemini-3-pro-image'));
  await save(models,modelForEnrollment('nano','gemini-generate-content','model_b','connection_b','gemini-3-pro-image'));
  await save(models,modelForEnrollment('nano','gemini-generate-content','model_c','connection_c','gemini-3-pro-image'));
  await models.saveModel({...entry(models,'model_b'),defaults:{...entry(models,'model_b').defaults,aspect_ratio:'9:16'}});
  const directory=await mkdtemp(path.join(os.tmpdir(),'ediro-family-history-'));
  const repository=new ProjectRepository(directory),workspace=new Workspace(models,{execute:async()=>{throw new Error('历史恢复不应调用模型。');}});
  t.after(()=>workspace.shutdown());
  await workspace.create(repository,'历史渠道恢复');await workspace.selectModel('model_a');
  const historical=structuredClone(workspace.project!.recipe);historical.core_parameters.aspect_ratio='16:9';
  const job:Job={task_id:'task_history',status:'succeeded',stage:'done',progress:100,created_at:'2026-09-01',recipe_snapshot:historical,chain_snapshot:{mode:'text_to_image',blocks:[]},adapted_input:{kind:'native_blocks',blocks:[],adjustments:[]},model_snapshot:{model_config_id:a.model_config_id,preset_id:a.preset_id,title:a.title,provider:a.provider,model:a.model,adapter_id:a.adapter_id,revision:a.revision,kind:a.kind},output_asset_ids:['asset_history']};
  workspace.project!.jobs.push(structuredClone(job));
  workspace.project!.assets.push({asset_id:'asset_history',name:'历史结果',location:{type:'managed',relative_path:'assets/asset_history.png'},thumbnail_path:'assets/asset_history_thumb.webp',width:16,height:9,mime_type:'image/png',created_at:'2026-09-01',kind:'output'});
  await workspace.selectModel('model_b');assert.equal(workspace.project!.recipe.core_parameters.aspect_ratio,'9:16');
  await models.assign('generation','model_c');await models.deleteModel('model_a');
  await workspace.restoreResult(workspace.project!.project_id,'asset_history');
  assert.equal(models.defaultModel(),'model_c');assert.equal(workspace.project!.recipe.model_config_id,'model_b');
  assert.equal(workspace.project!.recipe.core_parameters.aspect_ratio,'16:9');assert.equal(models.resolve('model_b').defaults.aspect_ratio,'9:16');
  assert.deepEqual(workspace.project!.jobs[0],job);
  assert.equal((await repository.load()).recipe.model_config_id,'model_b');
});

test('全新模型库采用 Sunburst 与独立默认值，已有 v3 模型库不被起始配置升级',async()=>{
  const freshDirectory=await mkdtemp(path.join(os.tmpdir(),'ediro-family-fresh-'));
  const fresh=await openModelLibrary(freshDirectory),cloud=fresh.models.filter(m=>m.kind==='cloud');
  assert.equal(cloud.find(m=>m.adapter_id==='openai-images')?.model,'gpt-image-2.5-sunburst');
  assert.ok(cloud.every(m=>m.independent_defaults===true&&!!m.family));
  assert.deepEqual(fresh.defaults_by_model,{});
  assert.deepEqual(await openModelLibrary(freshDirectory),fresh);

  const existingDirectory=await mkdtemp(path.join(os.tmpdir(),'ediro-family-existing-')),models=library();
  await save(models,modelFromPreset('gpt-image-2','model_image_2','connection_old','gpt-image-2'));
  const existing=models.snapshot(),raw=JSON.stringify(existing),filename=path.join(existingDirectory,'model-library.v3.json');
  await writeFile(filename,raw);
  const loaded=await openModelLibrary(existingDirectory);
  assert.deepEqual(loaded,existing);assert.equal(loaded.models.find(m=>m.model_config_id==='model_image_2')?.model,'gpt-image-2');
  assert.equal(await readFile(filename,'utf8'),raw);
});
