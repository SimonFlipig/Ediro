import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,readdir,stat,rename,unlink,symlink} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {ProjectLibrary} from '../src/adapters/project-library.js';
import {ProjectRepository,atomicJson,projectFilename} from '../src/adapters/project-repository.js';
import {OutputRecords} from '../src/adapters/output-records.js';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {MockGenerator} from '../src/adapters/mock-generator.js';
import {MaskPixels} from '../src/adapters/mask-pixels.js';
import {projectSummary} from '../src/core/project-summary.js';
import type {MaskDraft} from '../src/core/mask.js';

const png=()=>sharp({create:{width:64,height:64,channels:4,background:'#725643'}}).png().toBuffer();
const workspace=()=>new Workspace(new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}}),new MockGenerator(1),undefined,new MaskPixels());
async function root(){await mkdir('.local/test-projects',{recursive:true});return mkdtemp(path.resolve('.local/test-projects/storage-'));}
async function settle(w:Workspace){for(let i=0;i<500;i++){if(await w.serial(async()=>w.project!.jobs.every(j=>['succeeded','failed','cancelled'].includes(j.status))))return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');}

test('旧目录删除校验拒绝越界、链接及其他工程仍引用的素材',async()=>{
  const base=await root(),library=new ProjectLibrary(base),source=library.repository(await library.createDirectory()),a=workspace();await a.create(source,'被引用的项目');
  const asset=await source.saveInternalImage(await png(),'共享图片','internal');a.project!.assets.push(asset);await a.persist();
  const peer=library.repository(await library.createDirectory()),b=workspace();await b.create(peer,'引用方');await b.importFiles([await source.resolveAssetPath(asset,false)]);
  await assert.rejects(()=>library.trashTarget(path.basename(source.directory)),/仍引用/);
  b.project!.assets=[];await b.persist();assert.equal((await library.trashTarget(path.basename(source.directory))).filename,source.directory);
  await assert.rejects(()=>library.trashTarget('../outside'));
  const outside=path.join(base,'outside');await mkdir(outside);await symlink(outside,path.join(library.directory,'work-LINKED'),'junction');await assert.rejects(()=>library.trashTarget('work-LINKED'),/链接/);assert.ok((await stat(outside)).isDirectory());
});

test('已删除的旧项目不会在下次迁移时从旧备份重新创建',async()=>{
  const base=await root(),library=new ProjectLibrary(base),id='work-ABC123',old=path.join(library.runtimeDirectory,'workspaces',id),w=workspace();await w.create(new ProjectRepository(old),'旧项目');
  assert.equal(await library.migrate(old,new Set([id])),undefined);await assert.rejects(()=>stat(path.join(library.directory,id)),/ENOENT/);assert.ok(await stat(path.join(old,projectFilename)));
});
async function edit(w:Workspace,base:string){
  const file=path.join(base,'original.png');await writeFile(file,await png());await w.importFiles([file]);
  const d:MaskDraft={source_asset_id:w.project!.assets[0].asset_id,width:64,height:64,strokes:[{tool:'paint',size:12,points:[[.5,.5]]}],instruction:'修改选区',model_config_id:'model_mock_native',quality:'standard',mode:'strict',feather:0};
  await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);
  assert.equal(w.project!.jobs[0].status,'succeeded',w.project!.jobs[0].error);
  const task=w.project!.jobs[0],strokes=[...d.strokes,{tool:'erase' as const,size:3,points:[[.5,.5] as [number,number]]}];
  await w.saveCompositeMask(w.project!.project_id,task.task_id,strokes);
  const output=await w.reprocessMask(w.project!.project_id,task.task_id,'strict',2,strokes);
  return {d,task,strokes,output};
}

test('新目录分离输入、原始返回和成品，按图片恢复蒙版，重命名图片仍可找回记录',async()=>{
  const base=await root(),library=new ProjectLibrary(base),directory=await library.createDirectory(),repo=library.repository(directory),w=workspace();
  await w.create(repo,'目录测试');const {task,strokes,output}=await edit(w,base),p=w.project!;
  const mask=p.assets.find(a=>a.asset_id===task.mask_edit!.mask_asset_id)!,raw=p.assets.find(a=>a.asset_id===task.mask_edit!.raw_asset_ids[0])!;
  assert.equal(mask.location.type,'managed');assert.ok((await repo.resolveAssetPath(mask,false)).startsWith(path.join(base,'input')));
  assert.ok((await repo.resolveAssetPath(raw,false)).startsWith(path.join(directory,'internal')));
  assert.deepEqual((await readdir(library.outputDirectory)).map(n=>path.extname(n)),['.png']);
  const asset=p.assets.find(a=>a.asset_id===output)!;if(asset.location.type!=='external')throw Error('external');
  const moved=path.join(library.outputDirectory,'客户改名.png');await rename(asset.location.path,moved);
  const recoveredRepo=library.repository(await library.createDirectory()),recovered=await recoveredRepo.recoverOutput(moved);
  assert.deepEqual(recovered.jobs[0].mask_edit!.composite_strokes,strokes);
  assert.equal(recovered.jobs[0].mask_edit!.variants[0].asset_id,output);
  for(const a of recovered.assets)assert.ok((await recoveredRepo.readAsset(a)).length);
  const cachedIndex=path.join(library.records.directory,'index.json');await unlink(cachedIndex);
  assert.equal(await new OutputRecords(library.records.directory).find(moved),library.records.filename(output,asset.name));
  await writeFile(moved,await sharp({create:{width:64,height:64,channels:4,background:'red'}}).png().toBuffer());
  await assert.rejects(()=>library.repository(path.join(base,'Project','work-broken')).recoverOutput(moved),/恢复记录/);
});

test('旧工作目录和同名恢复记录复制迁移，跨项目素材与补画保留，原数据可回退且迁移幂等',async()=>{
  const base=await root(),library=new ProjectLibrary(base),legacy=path.join(base,'.local/runtime/workspaces/work-old123'),old=new ProjectRepository(legacy,library.outputDirectory),w=workspace();
  await w.create(old,'旧项目');const {task,strokes,output}=await edit(w,base);
  const originalManifest=await readFile(path.join(legacy,projectFilename));
  const asset=w.project!.assets.find(a=>a.asset_id===output)!;if(asset.location.type!=='external')throw Error('external');
  const sidecar=asset.location.path.replace(/\.[^.]+$/,'.json'),originalRecord=await readFile(sidecar);
  const other=path.join(base,'.local/runtime/workspaces/work-new456'),fork=new ProjectRepository(other,library.outputDirectory);
  const restored=await fork.recoverOutput(asset.location.path); // external links to work-old123/assets
  await atomicJson(path.join(library.runtimeDirectory,'active-workspace.json'),{directory:other});
  const active=await library.migrate(other);assert.equal(active,library.forId('work-new456').directory);
  assert.deepEqual(await readFile(path.join(legacy,projectFilename)),originalManifest);
  assert.deepEqual(await readFile(path.join(library.directory,'migration-backup/output',path.basename(sidecar))),originalRecord);
  assert.deepEqual((await readdir(library.outputDirectory)).map(n=>path.extname(n)),['.png']);
  const repo=library.forId('work-new456'),project=await repo.load();assert.equal(project.project_id,restored.project_id);
  assert.deepEqual(project.jobs[0].mask_edit!.composite_strokes,strokes);
  for(const a of project.assets){assert.ok((await repo.readAsset(a)).length);if(a.location.type==='managed')assert.ok(!(await repo.resolveAssetPath(a,false)).includes('workspaces'));}
  const response=await repo.loadModelInput(task.task_id);assert.equal(response,null); // this legacy recovered workspace never owned a request capture
  assert.ok(await library.forId('work-old123').loadModelInput(task.task_id));
  const next=await library.repository(await library.createDirectory()).recoverOutput(asset.location.path);assert.deepEqual(next.jobs[0].mask_edit!.composite_strokes,strokes);
  const before=await readFile(path.join(repo.directory,projectFilename));await library.migrate(active);assert.deepEqual(await readFile(path.join(repo.directory,projectFilename)),before);
});

test('打包保持自包含并带实际请求，打开包进入新目录；删除仅回收成品与它的恢复记录',async()=>{
  const base=await root(),library=new ProjectLibrary(base),repo=library.repository(await library.createDirectory()),w=workspace();await w.create(repo,'打包测试');
  const {task,output}=await edit(w,base),pack=path.join(base,'package');await repo.packageProject(w.project!,pack);
  const archived=new ProjectRepository(pack),p=await archived.load();assert.ok(p.assets.every(a=>a.location.type==='managed'&&a.location.relative_path.startsWith('assets/')));assert.ok(await archived.loadModelInput(task.task_id));
  const fresh=library.repository(await library.createDirectory());await archived.forkWorkspace(p,fresh.directory,fresh);const opened=await fresh.load();
  assert.notEqual(opened.project_id,p.project_id);for(const a of opened.assets)assert.ok((await fresh.readAsset(a)).length);
  const forkOutput=opened.assets.find(a=>a.asset_id===output)!;if(forkOutput.location.type!=='external')throw Error('external');assert.ok(await fresh.findOutputRecord(forkOutput.location.path));
  const originalOutput=w.project!.assets.find(a=>a.asset_id===output)!;if(originalOutput.location.type!=='external')throw Error('external');
  const originalRecord=await repo.findOutputRecord(originalOutput.location.path),forkRecord=await fresh.findOutputRecord(forkOutput.location.path);
  assert.notEqual(originalRecord,forkRecord);assert.equal(JSON.parse(await readFile(originalRecord!,'utf8')).project.project_id,w.project!.project_id);assert.equal(JSON.parse(await readFile(forkRecord!,'utf8')).project.project_id,opened.project_id);
  const targets:string[]=[];await repo.trashResult(w.project!,output,async filename=>{targets.push(filename);await unlink(filename);});
  assert.equal(targets.length,2);assert.ok(targets.some(p=>p.startsWith(library.outputDirectory)));assert.ok(targets.includes(library.records.filename(output,w.project!.assets.find(a=>a.asset_id===output)!.name)));
  assert.ok(await fresh.findOutputRecord(forkOutput.location.path));
  const mask=w.project!.assets.find(a=>a.asset_id===task.mask_edit!.mask_asset_id)!;assert.ok(await repo.readAsset(mask));
});

test('项目记录列出超过 50 项、封面与草稿状态可辨识，改名保持自动命名和恢复身份',async()=>{
  const base=await root(),library=new ProjectLibrary(base),repo=library.repository(await library.createDirectory()),w=workspace();await w.create(repo,'未命名工作');
  const {task,output}=await edit(w,base),p=w.project!;
  assert.equal(p.name,'original');assert.equal(projectSummary(p).cover_asset_id,output);assert.equal(projectSummary(p).status,'saved');
  await w.saveCompositeMask(p.project_id,task.task_id,[...task.mask_edit!.composite_strokes!,{tool:'paint',size:2,points:[[.1,.1]]}]);assert.equal(projectSummary(p).status,'draft');
  for(let i=0;i<54;i++){const dir=await library.createDirectory();await library.repository(dir).save({...p,name:`项目 ${i}`,assets:[],jobs:[],mask_drafts:[],revisions:[],recipe:{...p.recipe,modules:p.recipe.modules.map(m=>({...m,asset_ids:[]}))}});}
  const records=await library.list();assert.equal(records.length,55);
  const id=path.basename(repo.directory);assert.ok(await stat(await library.cover(id,output)));
  await library.rename(id,'自定义项目名');assert.equal((await repo.load()).name,'自定义项目名');assert.equal((await repo.load()).project_id,p.project_id);
  assert.equal((await library.list(new Set([id]))).length,54);
  assert.throws(()=>library.forId('../outside'));
});

test('同一存放位置可打包多个快照，同秒重名不覆盖，已有文件和源项目保持不变',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-23T12:00:00Z')});
  const base=await root(),library=new ProjectLibrary(base),repo=library.repository(await library.createDirectory()),w=workspace();await w.create(repo,'边柜 / 方案: A');
  const {task}=await edit(w,base),destination=path.join(base,'archives');await mkdir(destination);
  const marker=path.join(destination,'客户文件.txt');await writeFile(marker,'保留');
  const before=await readFile(path.join(repo.directory,projectFilename)),first=await repo.packageInto(w.project!,destination);
  const manifest=await readFile(path.join(first,projectFilename)),archived=new ProjectRepository(first),initial=await archived.load();
  assert.ok(path.basename(first).startsWith('边柜 _ 方案_ A_'));assert.equal(path.dirname(first),destination);
  for(const asset of initial.assets)assert.ok((await archived.readAsset(asset)).length);
  assert.ok(await archived.loadModelInput(task.task_id));
  assert.deepEqual(await readFile(path.join(repo.directory,projectFilename)),before);
  const next=structuredClone(w.project!);next.mask_drafts![0].instruction='第二个版本的修改';
  const second=await repo.packageInto(next,destination);
  assert.equal(second,`${first}_2`);assert.equal((await readdir(destination)).length,3);
  assert.equal(await readFile(marker,'utf8'),'保留');assert.deepEqual(await readFile(path.join(first,projectFilename)),manifest);
  assert.equal((await new ProjectRepository(second).load()).mask_drafts![0].instruction,'第二个版本的修改');
  assert.deepEqual(await readFile(path.join(repo.directory,projectFilename)),before);
  await assert.rejects(()=>repo.packageInto(next,path.join(repo.directory,'model-inputs')),/打包位置/);
});

test('旧工具参考图离开 output 前先更新跨项目引用，失败后可重跑，备份可还原',async()=>{
  const base=await root(),library=new ProjectLibrary(base),legacy=path.join(library.runtimeDirectory,'workspaces/work-tool01'),repo=new ProjectRepository(legacy,library.outputDirectory),w=workspace();await w.create(repo,'旧工具');
  const tool=await repo.saveOutput(await png(),'旧工具.png','png');tool.kind='generated';w.project!.assets.push(tool);await w.persist();
  if(tool.location.type!=='external')throw Error('external');const file=tool.location.path;
  const other=path.join(library.runtimeDirectory,'workspaces/work-tool02'),otherRepo=new ProjectRepository(other,library.outputDirectory),second=workspace();await second.create(otherRepo,'引用工具');await second.importFiles([file]);
  const blocker=path.join(library.directory,'migration-backup/output',path.basename(file));await mkdir(path.dirname(blocker),{recursive:true});await writeFile(blocker,'错误备份');
  await assert.rejects(()=>library.migrate(legacy),/备份/);assert.ok(await stat(file));
  await unlink(blocker);await library.migrate(legacy);await assert.rejects(()=>stat(file),{code:'ENOENT'});
  assert.deepEqual(await readFile(blocker),await png());
  const migrated=library.forId('work-tool02'),p=await migrated.load();assert.ok((await migrated.readAsset(p.assets[0])).length);
  assert.ok(p.assets[0].location.type==='external'&&!p.assets[0].location.path.includes('output'));
  await library.migrate(library.forId('work-tool01').directory);
});
