import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {DraftRepository} from '../src/adapters/draft-repository.js';
import {DocumentRepository} from '../src/adapters/document-repository.js';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {MockGenerator} from '../src/adapters/mock-generator.js';

async function fixture(){
  const base=path.resolve('.local/test-projects');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'draft-'));
  let calls=0,existedAtCall=false;const mock=new MockGenerator(1);
  const w=new Workspace(new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}}),{execute:async(...args)=>{calls++;existedAtCall=w.repository instanceof DocumentRepository&&!!await stat(w.repository.filename);return mock.execute(...args);}},undefined,undefined,2000);
  const draft=new DraftRepository(path.join(root,'scratch'),path.join(root,'Project'),path.join(root,'cache'),repo=>{w.repository=repo;});
  await w.create(draft,'未命名工作');
  const files=async()=>readdir(path.join(root,'Project')).catch(()=>[]);
  const close=async()=>{await w.shutdown();await (w.repository as DraftRepository|DocumentRepository).close();};
  return {w,root,draft,files,close,calls:()=>calls,existedAtCall:()=>existedAtCall};
}
async function settle(w:Workspace){for(let i=0;i<250;i++){if(await w.serial(async()=>w.project!.jobs.every(j=>['succeeded','failed','cancelled'].includes(j.status))))return;await new Promise(r=>setTimeout(r,20));}throw Error('timeout');}

test('空白编辑、保存与关闭不创建项目或持久预设；新工作恢复初始结构和默认模型',async()=>{
  const f=await fixture(),{w,draft}=f;assert.deepEqual(await f.files(),[]);
  const recipe=structuredClone(w.project!.recipe);recipe.modules.at(-1)!.user_instruction='临时文字';recipe.core_parameters.aspect_ratio='16:9';await w.saveRecipe(recipe);await w.addModule('prompt');await w.flush();
  assert.equal(w.repository,draft);assert.equal((await draft.load()).recipe.modules.at(-2)!.user_instruction,'临时文字');assert.deepEqual(await f.files(),[]);
  await assert.rejects(()=>stat(draft.directory),/ENOENT/);
  await w.models.assign('generation','model_mock_separated');
  await w.create(draft,'新工作');assert.equal(w.project!.recipe.model_config_id,'model_mock_separated');assert.equal(w.project!.recipe.modules.length,4);assert.ok(w.project!.recipe.modules.every(m=>!m.user_instruction));assert.equal(w.project!.recipe.core_parameters.aspect_ratio,'1:1');
  await f.close();assert.deepEqual(await f.files(),[]);
});
test('取消前的无效导入与无效生成不建项目；成功导入收齐素材并保留本次输入和身份',async()=>{
  const f=await fixture(),{w}=f,id=w.project!.project_id;
  const recipe=structuredClone(w.project!.recipe);recipe.modules.at(-1)!.user_instruction='本次生成要求';recipe.core_parameters.aspect_ratio='16:9';await w.saveRecipe(recipe);
  const bad=path.join(f.root,'bad.png');await writeFile(bad,'not an image');
  await assert.rejects(()=>w.serial(()=>w.importFiles([bad])));assert.deepEqual(await f.files(),[]);
  const good=path.join(f.root,'good.png');await writeFile(good,await sharp({create:{width:20,height:20,channels:3,background:'#abc'}}).png().toBuffer());
  await assert.rejects(()=>w.serial(()=>w.importFiles([good,bad])));assert.deepEqual(await f.files(),[]);assert.equal(w.project!.assets.length,0);
  await w.serial(()=>w.importFiles([good],recipe.modules[0].module_id));
  assert.equal((await f.files()).length,1);assert.ok(w.repository instanceof DocumentRepository);assert.equal(w.project!.project_id,id);assert.equal(w.project!.assets[0].location.type,'managed');assert.equal(w.project!.recipe.modules.at(-1)!.user_instruction,'本次生成要求');assert.equal(w.project!.recipe.core_parameters.aspect_ratio,'16:9');
  await w.serial(()=>w.importFiles([good]));assert.equal((await f.files()).length,1);await f.close();
});
test('纯文生图先保存项目与排队快照，再执行模型；空提示不创建项目',async()=>{
  const f=await fixture(),{w}=f,id=w.project!.project_id;
  await assert.rejects(()=>w.serial(()=>w.enqueue(true)),/提示词/);assert.deepEqual(await f.files(),[]);assert.equal(f.calls(),0);
  const recipe=structuredClone(w.project!.recipe);recipe.modules.at(-1)!.user_instruction='仅文字生成';await w.saveRecipe(recipe);
  await w.serial(()=>w.enqueue(true));await settle(w);assert.equal(f.calls(),1);assert.equal(f.existedAtCall(),true);assert.equal(w.project!.jobs[0].status,'succeeded');assert.equal(w.project!.project_id,id);assert.equal((await f.files()).length,1);
  const stored=await w.repository!.load();assert.equal(stored.jobs[0].status,'succeeded');assert.equal(stored.assets[0].kind,'output');await f.close();
});
test('首次建项目写入失败时保留空白输入，不发送生成请求',async()=>{
  const f=await fixture(),{w}=f;
  const recipe=structuredClone(w.project!.recipe);recipe.modules.at(-1)!.user_instruction='必须先落盘';await w.saveRecipe(recipe);
  await writeFile(path.join(f.root,'Project'),'占用目录的文件');
  await assert.rejects(()=>w.serial(()=>w.enqueue(true)));assert.equal(f.calls(),0);assert.equal(w.project!.jobs.length,0);assert.equal(w.project!.recipe.modules.at(-1)!.user_instruction,'必须先落盘');assert.equal(w.repository,f.draft);
  // Do not retry storage from shutdown while the deliberately blocked path remains.
  w.acceptSavedCopy();await f.close();
});
