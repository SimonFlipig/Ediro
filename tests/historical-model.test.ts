import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {mockDescription} from '../src/core/model-library.js';
import {Workspace} from '../src/core/workspace.js';
import {DocumentRepository} from '../src/adapters/document-repository.js';
import {GeminiGenerator} from '../src/adapters/gemini-generator.js';
import {ImagesGenerator} from '../src/adapters/images-generator.js';
import {modelFromPreset} from '../src/protocols/model-catalog.js';
import {bindHistoricalRecipe,historicalPreset} from '../src/core/historical-model.js';

async function enroll(library:ModelLibrary,id:string,preset='nano-banana-pro',remote='channel-alias'){
  const connection='connection_'+id;
  await library.saveConnection({connection_id:connection,title:connection,endpoint:'https://fixture.invalid',enabled:true},'fixture-key');
  const {endpoint,executable,revision,...model}=modelFromPreset(preset,id,connection,remote);
  await library.saveModel({...model,purpose:'generation',capability_source:'documented'});return library.resolve(id);
}
async function fixture(t:test.TestContext){
  const root=path.join(process.cwd(),'.local','test-historical-model');await mkdir(root,{recursive:true});const base=await mkdtemp(path.join(root,'case-'));
  const library=new ModelLibrary(seedModels().slice(0,1),async()=>{},{has:async()=>true,set:async()=>{}},[mockDescription,new GeminiGenerator().description,new ImagesGenerator().description]);
  await enroll(library,'model_old');
  const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#abc'}}).png().toBuffer();let calls=0;
  const w=new Workspace(library,{execute:async()=>{calls++;return {images:[{bytes,format:'png',width:16,height:16}]};}});
  const repo=await DocumentRepository.prepare(path.join(base,'history.ediro'),path.join(base,'cache'));await w.create(repo,'历史模型');
  t.after(async()=>{await w.shutdown();await repo.close();});
  await w.selectModel('model_old');const recipe=structuredClone(w.project!.recipe);recipe.modules.at(-1)!.user_instruction='历史提示';recipe.core_parameters.aspect_ratio='16:9';await w.saveRecipe(recipe);
  await w.serial(()=>w.enqueue(false));
  for(let i=0;i<200;i++){if(await w.serial(async()=>w.project!.jobs[0].status==='succeeded'))break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(w.project!.jobs[0].status,'succeeded');
  return {w,repo,library,calls:()=>calls,job:structuredClone(w.project!.jobs[0])};
}

test('历史接入删除后按同一具体预设恢复，保留参数、快照和请求次数；预设写入工程',async t=>{
  const {w,repo,library,job,calls}=await fixture(t);
  assert.equal((await repo.load()).jobs[0].model_snapshot.preset_id,'nano-banana-pro');
  await enroll(library,'model_new','nano-banana-pro','another-name');await library.deleteModel('model_old');
  await w.restoreResult(w.project!.project_id,job.output_asset_ids[0]);
  assert.equal(w.project!.recipe.model_config_id,'model_new');assert.deepEqual(w.project!.recipe.core_parameters,job.recipe_snapshot.core_parameters);
  assert.deepEqual(w.project!.recipe.modules,job.recipe_snapshot.modules);assert.deepEqual(w.project!.jobs[0],job);assert.equal(calls(),1);
});

test('无匹配接入仍可恢复、编辑并保存，生成被阻止；后来手动绑定同预设不重置参数',async t=>{
  const {w,repo,library,job,calls}=await fixture(t);await library.deleteModel('model_old');
  await w.restoreResult(w.project!.project_id,job.output_asset_ids[0]);
  const recipe=structuredClone(w.project!.recipe);recipe.modules.at(-1)!.user_instruction='恢复后可编辑';await w.saveRecipe(recipe);
  assert.equal((await repo.load()).recipe.modules.at(-1)!.user_instruction,'恢复后可编辑');
  await assert.rejects(()=>w.enqueue(false),/模型配置不存在/);assert.equal(calls(),1);
  await enroll(library,'model_new');await w.selectModel('model_new');
  assert.equal(w.project!.recipe.core_parameters.aspect_ratio,'16:9');assert.deepEqual(w.project!.jobs[0],job);
});

test('多个同预设不任意切计费渠道；明确默认可匹配，其他型号不能匹配',async t=>{
  const {w,library,job}=await fixture(t);await library.deleteModel('model_old');
  await enroll(library,'model_a');await enroll(library,'model_b');await enroll(library,'model_other','gpt-image-2');
  await w.restoreResult(w.project!.project_id,job.output_asset_ids[0]);assert.equal(w.project!.recipe.model_config_id,'model_old');
  await library.assign('generation','model_b');await w.restoreResult(w.project!.project_id,job.output_asset_ids[0]);assert.equal(w.project!.recipe.model_config_id,'model_b');
  const other=(await library.list()).filter(m=>m.model_config_id==='model_other');
  assert.equal(bindHistoricalRecipe(job.recipe_snapshot,[job],other).model_config_id,'model_old');
});

test('旧记录可通过准确模型 ID 识别预设，不猜自定义别名；局部编辑模型不冒充主模型',async t=>{
  const {library,job}=await fixture(t);const recipe=structuredClone(job.recipe_snapshot);
  delete recipe.model_preset_id;delete recipe.model_channels;delete job.model_snapshot.preset_id;
  job.model_snapshot.model='models/gemini-3-pro-image-preview';assert.equal(historicalPreset(recipe,[job]),'nano-banana-pro');
  await library.deleteModel('model_old');await enroll(library,'model_new');
  assert.equal(bindHistoricalRecipe(recipe,[job],await library.list()).model_config_id,'model_new');
  job.model_snapshot.model='channel-alias';assert.equal(historicalPreset(recipe,[job]),undefined);
  job.model_snapshot.preset_id='gpt-image-2';job.model_snapshot.model_config_id='different_edit_model';assert.equal(historicalPreset(recipe,[job]),undefined);
});

test('存在的原接入优先；缺凭据和停用接入不作自动替代，重开不改历史',async t=>{
  const {w,repo,library,job}=await fixture(t);await enroll(library,'model_new');await library.assign('generation','model_new');
  await w.restoreResult(w.project!.project_id,job.output_asset_ids[0]);assert.equal(w.project!.recipe.model_config_id,'model_old');
  await library.deleteModel('model_old');const entry=library.snapshot().models.find(m=>m.model_config_id==='model_new')!;
  await library.saveModel({...entry,enabled:false});await w.restoreResult(w.project!.project_id,job.output_asset_ids[0]);assert.equal(w.project!.recipe.model_config_id,'model_old');
  await library.saveModel({...entry,enabled:true});await w.open(repo);assert.equal(w.project!.recipe.model_config_id,'model_new');assert.deepEqual(w.project!.jobs[0],job);
  const unavailable=(await library.list()).map(m=>({...m,executable:false}));assert.equal(bindHistoricalRecipe(job.recipe_snapshot,[job],unavailable).model_config_id,'model_old');
});

test('原配置 ID 被改成其他预设时，恢复仍保留历史身份，编辑不偷偷采用新模型',async t=>{
  const {w,library,job,calls}=await fixture(t);
  await enroll(library,'model_old','gpt-image-2','gpt-image-2');
  await w.restoreResult(w.project!.project_id,job.output_asset_ids[0]);
  assert.equal(w.project!.recipe.model_preset_id,'nano-banana-pro');
  const recipe=structuredClone(w.project!.recipe);recipe.modules.at(-1)!.user_instruction='仍可编辑';await w.saveRecipe(recipe);
  assert.equal(w.project!.recipe.model_preset_id,'nano-banana-pro');
  await assert.rejects(()=>w.enqueue(false),/预设不一致/);assert.equal(calls(),1);assert.deepEqual(w.project!.jobs[0],job);
  await w.selectModel('model_old');assert.equal(w.project!.recipe.model_preset_id,'gpt-image-2');
});
