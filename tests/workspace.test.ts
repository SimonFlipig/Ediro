import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Workspace } from '../src/core/workspace.js';
import { ModelLibrary, seedModels } from '../src/core/models.js';
import { ProjectRepository, projectFilename } from '../src/adapters/project-repository.js';
import { MockGenerator } from '../src/adapters/mock-generator.js';
import type { CloudExecutionPort } from '../src/core/ports.js';
import { compileRecipe } from '../src/core/compiler.js';

async function fixture(delay=10,executor?:CloudExecutionPort){
  const base=path.join(process.cwd(),'.local','test-projects');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'case-'));
  const library=new ModelLibrary(seedModels(),async()=>{}, {has:async()=>false,set:async()=>{}});
  const workspace=new Workspace(library,executor??new MockGenerator(delay));await workspace.create(new ProjectRepository(directory),'测试项目');
  const recipe=structuredClone(workspace.project!.recipe);recipe.modules.at(-1)!.user_instruction='生成一个电商产品图';await workspace.saveRecipe(recipe);
  return {workspace,directory};
}
async function settle(workspace:Workspace){
  for(let i=0;i<200;i++){if(await workspace.serial(async()=>workspace.project!.jobs.every(j=>['succeeded','failed','cancelled'].includes(j.status))))return;await new Promise(resolve=>setTimeout(resolve,20));}
  throw new Error('任务等待超时');
}

test('失败重试保留冻结输入与历史，不覆盖当前编辑；切换工程和模型变更时拒绝重试',async()=>{
  let calls=0;const mock=new MockGenerator(1);
  const {workspace:w}=await fixture(1,{execute:async(...args)=>{if(++calls===1)throw new Error('模拟失败');return mock.execute(...args);}});
  await w.serial(()=>w.enqueue(false));await settle(w);
  const old=structuredClone(w.project!.jobs[0]);assert.equal(old.status,'failed');
  const current=structuredClone(w.project!.recipe);current.modules.at(-1)!.user_instruction='失败后修改的新提示';await w.saveRecipe(current);
  await assert.rejects(()=>w.retry('project_other',old.task_id),/工程已切换/);
  const model=w.models.snapshot().models.find(m=>m.model_config_id===old.model_snapshot.model_config_id)!;
  w.project!.jobs[0].model_snapshot.revision=-1;
  await assert.rejects(()=>w.retry(w.project!.project_id,old.task_id),/模型配置已改变/);
  w.project!.jobs[0].model_snapshot.revision=model.revision;
  await w.serial(()=>w.retry(w.project!.project_id,old.task_id));await settle(w);
  assert.equal(calls,2);assert.equal(w.project!.jobs[1].status,'succeeded');
  assert.deepEqual(w.project!.jobs[0],old);assert.deepEqual(w.project!.recipe,current);
  assert.deepEqual(w.project!.jobs[1].recipe_snapshot,old.recipe_snapshot);
  assert.deepEqual(w.project!.jobs[1].chain_snapshot,old.chain_snapshot);
  assert.deepEqual(w.project!.jobs[1].adapted_input,old.adapted_input);
  await w.shutdown();
});

test('重开与历史配方复用更新当前核心语义，新任务使用最新快照，历史任务不变',async()=>{
  const {workspace,directory}=await fixture();
  workspace.project!.recipe.modules[0].user_instruction='保留标识';
  await workspace.enqueue(false);await settle(workspace);
  const project=structuredClone(workspace.project!);
  project.recipe.modules[0].base_instruction='旧核心语义';
  project.recipe.modules[0].numbered_instruction='旧{images}';
  project.jobs[0].recipe_snapshot.modules[0].base_instruction='历史核心语义';
  const history=structuredClone(project.jobs[0]);
  await workspace.repository!.save(project);
  await workspace.open(new ProjectRepository(directory));
  const current=workspace.registry.get('subject').base_instruction;
  assert.equal(workspace.project!.recipe.modules[0].base_instruction,current);
  assert.deepEqual(workspace.project!.jobs[0],history);
  await workspace.restore(history.task_id);
  assert.equal(workspace.project!.recipe.modules[0].base_instruction,current);
  assert.deepEqual(workspace.project!.jobs[0],history);
  await workspace.enqueue(false);await settle(workspace);
  assert.equal(workspace.project!.jobs[1].recipe_snapshot.modules[0].base_instruction,current);
  assert.deepEqual(workspace.project!.jobs[0],history);
});

test('重开后按结果切换参数和模块，继续生成使用所选版本，历史快照不变',async()=>{
  const {workspace:w,directory}=await fixture();
  const source=path.join(directory,'reference.png');
  await writeFile(source,await sharp({create:{width:12,height:12,channels:3,background:'#334455'}}).png().toBuffer());
  await w.importFiles([source],w.project!.recipe.modules[0].module_id);
  await w.enqueue(false);await settle(w);
  const second=structuredClone(w.project!.recipe);
  second.core_parameters.aspect_ratio='16:9';
  second.modules.reverse();second.modules[0].user_instruction='第二版文字';second.modules.at(-1)!.enabled=false;
  await w.saveRecipe(second);await w.enqueue(false);await settle(w);
  await w.open(new ProjectRepository(directory));
  const history=structuredClone(w.project!.jobs),projectId=w.project!.project_id;
  for(const job of [history[0],history[1],history[0]]){
    await w.restoreResult(projectId,job.output_asset_ids[0]);
    assert.deepEqual(w.project!.recipe,w.registry.resolveRecipe(job.recipe_snapshot));
    assert.deepEqual((await w.repository!.load()).recipe,w.project!.recipe);
    assert.deepEqual(w.project!.jobs,history);
  }
  const selected=structuredClone(w.project!.recipe);
  await assert.rejects(()=>w.restoreResult('project_other',history[1].output_asset_ids[0]),/工作记录已切换/);
  await assert.rejects(()=>w.restoreResult(projectId,'asset_unknown'),/没有可恢复/);
  assert.deepEqual(w.project!.recipe,selected);
  const save=w.repository!.save;
  w.repository!.save=async()=>{throw new Error('disk failure');};
  try{await assert.rejects(()=>w.restoreResult(projectId,history[1].output_asset_ids[0]),/disk failure/);}
  finally{w.repository!.save=save;}
  assert.deepEqual(w.project!.recipe,selected);
  await w.enqueue(false);await settle(w);
  assert.deepEqual(w.project!.jobs[2].recipe_snapshot,history[0].recipe_snapshot);
  assert.deepEqual(w.project!.jobs.slice(0,2),history);
});

test('移除备选素材只隐藏入口，模块引用、历史身份及源文件不变；重新导入可显示',async()=>{
  const {workspace,directory}=await fixture();const source=path.join(directory,'source.png');
  const bytes=await sharp({create:{width:12,height:12,channels:3,background:'#334455'}}).png().toBuffer();await writeFile(source,bytes);
  const module=workspace.project!.recipe.modules[0];await workspace.importFiles([source],module.module_id);
  const id=workspace.project!.assets[0].asset_id;await workspace.hideMaterial(id);
  assert.deepEqual(module.asset_ids,[]); // save/import replace the Recipe rather than mutate old views.
  assert.deepEqual(workspace.project!.recipe.modules[0].asset_ids,[id]);
  assert.equal((await new ProjectRepository(directory).load()).assets[0].hidden_from_materials,true);
  assert.deepEqual(await readFile(source),bytes);await workspace.importFiles([source]);
  assert.equal(workspace.project!.assets[0].hidden_from_materials,false);
});

test('产出图片与同名 JSON 可独立恢复生成时配方，缺失参考仍保留身份',async()=>{
  const {workspace,directory}=await fixture();const source=path.join(directory,'source.png');
  await sharp({create:{width:12,height:12,channels:3,background:'#abcdef'}}).png().toFile(source);
  await workspace.importFiles([source],workspace.project!.recipe.modules[0].module_id);
  await workspace.enqueue(false);await settle(workspace);
  const original=structuredClone(workspace.project!),output=original.assets.find(a=>a.kind==='output')!;
  assert.equal(output.location.type,'external');if(output.location.type!=='external')throw new Error('expected external');
  assert.match(output.name,/^Ediro_\d{8}_\d{6}_[a-zA-Z0-9]+\.png$/);
  const jsonFile=output.location.path.replace(/\.[^.]+$/,'.json');const json=JSON.parse(await readFile(jsonFile,'utf8'));
  assert.equal(json.format,'ediro-output');assert.equal(JSON.stringify(json).includes('credential_ref'),false);
  await rename(source,`${source}.away`);
  const recovery=new ProjectRepository(path.join(directory,'recovery'));
  const restored=await recovery.recoverOutput(output.location.path);
  assert.deepEqual(restored.recipe,original.jobs[0].recipe_snapshot);
  assert.notEqual(restored.project_id,original.project_id);
  assert.equal(await recovery.sourceStatus(restored.assets.find(a=>a.kind==='import')!),'missing');
  assert.deepEqual((await recovery.load()).recipe,restored.recipe);
});

test('从产出恢复只保留当前结果，旧结果作为输入时保留引用但隐藏版本入口',async()=>{
  const {workspace,directory}=await fixture();
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);
  const first=workspace.project!.assets.find(a=>a.kind==='output')!;
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);
  const unrelated=workspace.project!.assets.filter(a=>a.kind==='output').at(-1)!;
  const recipe=structuredClone(workspace.project!.recipe);recipe.modules[0].asset_ids=[first.asset_id];await workspace.serial(()=>workspace.saveRecipe(recipe));
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);
  assert.equal(workspace.project!.jobs.at(-1)!.status,'succeeded',workspace.project!.jobs.at(-1)!.error);
  const current=workspace.project!.assets.filter(a=>a.kind==='output').at(-1)!;
  if(current.location.type!=='external')throw new Error('expected external');
  const jsonFile=current.location.path.replace(/\.[^.]+$/,'.json'),before=await readFile(jsonFile);
  const repo=new ProjectRepository(path.join(directory,'single-recovery')),restored=await repo.recoverOutput(current.location.path);
  assert.deepEqual(restored.jobs.map(j=>j.output_asset_ids),[[current.asset_id]]);
  assert.equal(restored.assets.some(a=>a.asset_id===unrelated.asset_id),false);
  assert.equal(restored.assets.find(a=>a.asset_id===first.asset_id)!.hidden_from_results,true);
  assert.equal(restored.assets.find(a=>a.asset_id===first.asset_id)!.removed_result,undefined);
  assert.deepEqual(restored.recipe.modules[0].asset_ids,[first.asset_id]);
  assert.deepEqual(restored.assets.filter(a=>a.kind==='output'&&!a.hidden_from_results).map(a=>a.asset_id),[current.asset_id]);
  assert.equal((await repo.load()).assets.find(a=>a.asset_id===first.asset_id)!.hidden_from_results,true);
  assert.deepEqual(await readFile(jsonFile),before);
  if(unrelated.location.type==='external')assert.ok(await readFile(unrelated.location.path));
});

test('结果回收只处理指定图片及 JSON，引用保留缺失身份，失败不永久删除',async()=>{
  const {workspace,directory}=await fixture();await workspace.enqueue(false);await settle(workspace);
  const project=workspace.project!,asset=project.assets.find(a=>a.kind==='output')!,repo=workspace.repository as ProjectRepository;
  if(asset.location.type!=='external')throw new Error('expected external');
  const filename=asset.location.path,jsonFile=filename.replace(/\.[^.]+$/,'.json');
  const next=structuredClone(project.recipe);next.modules[0].asset_ids=[asset.asset_id];await workspace.saveRecipe(next);
  const calls:string[]=[];await assert.rejects(()=>repo.trashResult(project,asset.asset_id,async file=>{calls.push(file);throw new Error('回收站不可用');}),/不会永久删除/);
  assert.equal(calls.length,1);assert.ok(await readFile(filename));assert.ok(await readFile(jsonFile));assert.notEqual(asset.removed_result,true);
  const bin=path.join(directory,'test-bin');await mkdir(bin);calls.length=0;
  await repo.trashResult(project,asset.asset_id,async file=>{calls.push(file);await rename(file,path.join(bin,path.basename(file)));});
  assert.equal(calls.length,2);assert.equal(asset.removed_result,true);
  const loaded=await repo.load();assert.deepEqual(loaded.recipe.modules[0].asset_ids,[asset.asset_id]);
  assert.equal(await repo.sourceStatus(asset),'missing');
  assert.ok(await readFile(path.join(bin,path.basename(filename))));
});

test('回收拒绝 output 目录外的结果，任何文件都不被送入回收站',async()=>{
  const {workspace,directory}=await fixture();await workspace.enqueue(false);await settle(workspace);
  const asset=workspace.project!.assets.find(a=>a.kind==='output')!,repo=workspace.repository as ProjectRepository;
  if(asset.location.type!=='external')throw new Error('expected external');
  const outside=path.join(directory,asset.name);await writeFile(outside,await readFile(asset.location.path));asset.location.path=outside;
  let calls=0;await assert.rejects(()=>repo.trashResult(workspace.project!,asset.asset_id,async()=>{calls++;}),/目录以外/);
  assert.equal(calls,0);assert.ok(await readFile(outside));
});

test('旧生成结果复制迁移到统一 output，资产身份不变且旧文件不删除',async()=>{
  const {workspace,directory}=await fixture();await workspace.enqueue(false);await settle(workspace);
  const project=workspace.project!,asset=project.assets.find(a=>a.kind==='output')!,repo=workspace.repository as ProjectRepository,id=asset.asset_id;
  const bytes=await repo.readAsset(asset),relative_path=`assets/${id}.png`,oldFile=path.join(directory,relative_path);await writeFile(oldFile,bytes);
  asset.location={type:'managed',relative_path};await repo.save(project);
  await repo.consolidateOutputs(project);
  const migrated=project.assets.find(a=>a.asset_id===id)!;assert.equal(migrated.location.type,'external');
  assert.deepEqual(await readFile(oldFile),bytes);assert.deepEqual(await repo.readAsset(migrated),bytes);
  if(migrated.location.type==='external')assert.equal(JSON.parse(await readFile(migrated.location.path.replace(/\.[^.]+$/,'.json'),'utf8')).output_asset_id,id);
});

test('结果图可按引用进行二轮生成，排序预览与新任务一致且不改写旧历史或文件',async()=>{
  const {workspace}=await fixture();
  await workspace.enqueue(false);await settle(workspace);
  const oldJob=structuredClone(workspace.project!.jobs[0]);
  const output=workspace.project!.assets.find(a=>a.asset_id===oldJob.output_asset_ids[0])!;
  const filename=await (workspace.repository as ProjectRepository).resolveAssetPath(output,false);
  const original=await readFile(filename);
  const next=structuredClone(workspace.project!.recipe);
  next.modules[0].asset_ids=[output.asset_id];
  const prompt=next.modules.pop()!;next.modules.unshift(prompt);
  await workspace.saveRecipe(next);
  const preview=compileRecipe(workspace.project!.recipe);
  assert.equal(preview.blocks[0].source_module_id,prompt.module_id);
  assert.equal(preview.blocks.find(b=>b.type==='image')!.asset_id,output.asset_id);
  await workspace.enqueue(false);await settle(workspace);
  const newJob=workspace.project!.jobs[1];
  assert.deepEqual(newJob.chain_snapshot,preview);
  assert.deepEqual(newJob.adapted_input.blocks,preview.blocks);
  assert.deepEqual(workspace.project!.jobs[0],oldJob);
  assert.deepEqual(await readFile(filename),original);
  assert.notEqual(newJob.output_asset_ids[0],output.asset_id);
});
test('项目往返保存四模块，复制新 ID；只读基础语义不能被 API 修改',async()=>{
  const {workspace,directory}=await fixture();const first=workspace.project!.recipe.modules[0];await workspace.copyModule(first.module_id);
  const copy=workspace.project!.recipe.modules[1];assert.notEqual(copy.reference_id,first.reference_id);
  const changed=structuredClone(workspace.project!.recipe);changed.modules[0].base_instruction='恶意覆盖';await assert.rejects(()=>workspace.saveRecipe(changed),/不可由界面修改/);
  const reopened=await new ProjectRepository(directory).load();assert.equal(reopened.recipe.modules.length,5);
});
test('非空目录不被覆盖，也不额外创建 assets 目录',async()=>{
  const {directory,workspace}=await fixture();const root=path.join(directory,'nonempty');await mkdir(root);await writeFile(path.join(root,'keep.txt'),'keep');
  await assert.rejects(()=>workspace.create(new ProjectRepository(root),'不能覆盖'),/空文件夹/);assert.deepEqual(await readdir(root),['keep.txt']);
});
test('多图导入保留顺序，持久化后素材仍然可读',async()=>{
  const {workspace,directory}=await fixture();const source=path.join(directory,'source');await mkdir(source);
  const first=path.join(source,'z.png'),second=path.join(source,'a.png');
  await sharp({create:{width:40,height:30,channels:3,background:'#c08070'}}).png().toFile(first);
  await sharp({create:{width:60,height:50,channels:3,background:'#609080'}}).png().toFile(second);
  await workspace.importFiles([first,second],workspace.project!.recipe.modules[0].module_id);
  const p=await new ProjectRepository(directory).load();const m=p.recipe.modules[0];assert.equal(p.assets.find(a=>a.asset_id===m.asset_ids[0])!.name,'z.png');assert.equal(p.assets.find(a=>a.asset_id===m.asset_ids[1])!.name,'a.png');
  assert.ok((await new ProjectRepository(directory).readAsset(p.assets[0])).length>0);
});
test('模拟任务完成保存结果和版本；后续配方修改不改变任务快照',async()=>{
  const {workspace,directory}=await fixture();await workspace.serial(()=>workspace.enqueue(false));
  const before=structuredClone(workspace.project!.jobs[0].recipe_snapshot);
  const recipe=structuredClone(workspace.project!.recipe);recipe.modules.at(-1)!.user_instruction='之后的新要求';await workspace.serial(()=>workspace.saveRecipe(recipe));await settle(workspace);
  const job=workspace.project!.jobs[0];assert.equal(job.status,'succeeded');assert.deepEqual(job.recipe_snapshot,before);assert.equal(job.output_asset_ids.length,1);assert.equal(workspace.project!.revisions.length,1);
  const p=await new ProjectRepository(directory).load();assert.equal(p.jobs[0].status,'succeeded');const image=await sharp(await new ProjectRepository(directory).readAsset(p.assets[0])).metadata();assert.equal(image.width,1200);
});
test('任务取消不产生结果；任务未结束时不能切换项目',async()=>{
  const {workspace,directory}=await fixture(200);await workspace.serial(()=>workspace.enqueue(false));
  await assert.rejects(()=>workspace.open(new ProjectRepository(directory)),/当前任务/);
  await workspace.serial(()=>workspace.cancel(workspace.project!.jobs[0].task_id));await settle(workspace);assert.equal(workspace.project!.jobs[0].status,'cancelled');assert.equal(workspace.project!.assets.length,0);await workspace.shutdown();
});
test('真实模型未接入时明确阻止；主动拍平不要求降级确认',async()=>{
  const {workspace}=await fixture();let recipe=structuredClone(workspace.project!.recipe);recipe.model_config_id='model_nano_pro';recipe.core_parameters=seedModels()[2].defaults;
  await workspace.saveRecipe(recipe);await assert.rejects(()=>workspace.enqueue(false),/未就绪/);
  recipe=structuredClone(recipe);recipe.model_config_id='model_mock_separated';recipe.core_parameters=seedModels()[1].defaults;await workspace.saveRecipe(recipe);
  recipe.input_strategy='numbered_flat';await workspace.saveRecipe(recipe);await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);assert.equal(workspace.project!.jobs[0].adapted_input.adjustments.length,0);assert.equal(workspace.project!.jobs[0].execution_plan!.actual_strategy,'numbered_flat');
});
test('中断任务重新打开时标为失败，防止自动重试和重复计费',async()=>{
  const {workspace,directory}=await fixture();await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);
  workspace.project!.jobs[0].status='running';await workspace.persist();
  const reopened=new Workspace(new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}}),new MockGenerator(10));
  await reopened.open(new ProjectRepository(directory));assert.equal(reopened.project!.jobs[0].status,'failed');assert.match(reopened.project!.jobs[0].error!,/没有自动重试/);
});
test('导入项目的目录穿越和缺失素材被拒绝',async()=>{
  const {workspace,directory}=await fixture();const file=path.join(directory,projectFilename);const p=JSON.parse(await readFile(file,'utf8'));
  p.recipe.modules[0].asset_ids=['asset_missing'];await writeFile(file,JSON.stringify(p));await assert.rejects(()=>new ProjectRepository(directory).load(),/缺少引用素材/);
  const rogue={asset_id:'asset_rogue',name:'x',location:{type:'managed' as const,relative_path:'../outside.png'},thumbnail_path:'assets/x.webp',width:1,height:1,mime_type:'image/png',created_at:'',kind:'import' as const};
  await assert.rejects(()=>workspace.repository!.readAsset(rogue),/路径非法/);
});

test('从模块库拖入指定位置，新模块顺序由配方数组决定',async()=>{
  const {workspace}=await fixture();const target=workspace.project!.recipe.modules[1].module_id;
  await workspace.addModule('style',target);
  assert.equal(workspace.project!.recipe.modules[1].reference_type,'style');
  assert.equal(workspace.project!.recipe.modules[2].module_id,target);
  await assert.rejects(()=>workspace.addModule('subject','module_missing'),/插入位置/);
});

test('保存失败不会留下假复制、假入队或半批次导入',async()=>{
  const {workspace,directory}=await fixture();const before=structuredClone(workspace.project!);
  const repository=workspace.repository!;const save=repository.save.bind(repository);
  repository.save=async()=>{throw new Error('测试磁盘写入失败');};
  await assert.rejects(()=>workspace.copyModule(before.recipe.modules[0].module_id),/写入失败/);
  await assert.rejects(()=>workspace.addModule('subject'),/写入失败/);
  await assert.rejects(()=>workspace.enqueue(false),/写入失败/);
  assert.deepEqual(workspace.project!.recipe,before.recipe);assert.equal(workspace.project!.jobs.length,0);
  const file=path.join(directory,'test.png');await sharp({create:{width:20,height:20,channels:3,background:'#80a080'}}).png().toFile(file);
  repository.save=save;
  await assert.rejects(()=>workspace.importFiles([file,path.join(directory,'missing.png')],before.recipe.modules[0].module_id));
  assert.deepEqual(workspace.project!.assets,before.assets);assert.deepEqual(workspace.project!.recipe,before.recipe);
});

test('任务存储故障会停队列，不无限自动重试',async()=>{
  const {workspace}=await fixture();const repository=workspace.repository!,save=repository.save.bind(repository);let failures=0;
  repository.save=async p=>{if(p.jobs.some(j=>j.status==='preparing'||j.status==='failed')){failures++;throw new Error('磁盘不可写');}await save(p);};
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(workspace.project!.jobs[0].status,'failed');assert.ok(failures<=3);assert.equal(workspace.project!.assets.length,0);
});

test('执行接口可按图文链读取全部参考图，不能读取任务外素材',async()=>{
  const seen:number[]=[];
  const executor:CloudExecutionPort={execute:async context=>{
    for(const block of context.job.chain_snapshot.blocks)if(block.type==='image')seen.push((await sharp(await context.readImage(block.asset_id)).metadata()).width!);
    await assert.rejects(()=>context.readImage('asset_not_in_job'),/只能读取本次任务/);
    return {images:[{bytes:await sharp({create:{width:20,height:20,channels:3,background:'#ffffff'}}).png().toBuffer(),format:'png',width:20,height:20}]};
  }};
  const {workspace,directory}=await fixture(10,executor);
  const files=[30,50].map(width=>path.join(directory,`source-${width}.png`));
  for(let i=0;i<files.length;i++)await sharp({create:{width:[30,50][i],height:20,channels:3,background:'#80a080'}}).png().toFile(files[i]);
  await workspace.importFiles([files[1],files[0],files[1]],workspace.project!.recipe.modules[0].module_id);
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);
  assert.deepEqual(seen,[50,30,50]);assert.equal(workspace.project!.jobs[0].status,'succeeded');
});

test('模型已返回但保存失败时，从本地恢复结果，不再次调用执行器',async()=>{
  let calls=0;const executor:CloudExecutionPort={execute:async()=>{calls++;return {images:[{bytes:await sharp({create:{width:20,height:20,channels:3,background:'#fff'}}).jpeg().toBuffer(),format:'jpeg',width:20,height:20}]};}};
  const {workspace}=await fixture(10,executor),repository=workspace.repository!,original=repository.saveOutput.bind(repository);let fail=true;
  repository.saveOutput=async(...args)=>{if(fail)throw new Error('disk save failed');return original(...args);};
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);const job=workspace.project!.jobs[0];assert.equal(job.status,'failed');assert.equal(job.recoverable_result,true);assert.equal(calls,1);
  fail=false;await workspace.serial(()=>workspace.retry(workspace.project!.project_id,job.task_id));assert.equal(calls,1);assert.equal(job.status,'succeeded');assert.equal(job.recoverable_result,false);assert.equal(workspace.project!.assets.at(-1)!.mime_type,'image/jpeg');
  const loaded=await repository.load();assert.equal(loaded.jobs[0].execution_summary!.actual_formats[0],'jpeg');assert.ok(!JSON.stringify(loaded.jobs).includes('credential_ref'));
});

async function makeImage(filename:string,color='#80a080') {
  await sharp({create:{width:60,height:40,channels:3,background:color}}).png().toFile(filename);
}
test('默认导入仅链接源图并缓存缩略图，不复制原图',async()=>{
  const {workspace,directory}=await fixture();const file=path.join(directory,'linked.png');await makeImage(file);
  await workspace.importFiles([file],workspace.project!.recipe.modules[0].module_id);
  const asset=workspace.project!.assets[0];assert.equal(asset.location.type,'external');
  assert.deepEqual(await readdir(path.join(directory,'assets')),[`${asset.asset_id}_thumb.webp`]);
  const loaded=await new ProjectRepository(directory).load();assert.equal(loaded.schema_version,3);assert.equal(loaded.assets[0].location.type,'external');
});
test('非首源图缺失不阻断打开记录，但阻止执行而不静默忽略',async()=>{
  const {workspace,directory}=await fixture();const files=[path.join(directory,'first.png'),path.join(directory,'second.png')];
  await makeImage(files[0]);await makeImage(files[1],'#80a0c0');await workspace.importFiles(files,workspace.project!.recipe.modules[0].module_id);
  await rename(files[1],path.join(directory,'moved.png'));
  const repository=new ProjectRepository(directory),loaded=await repository.load();assert.equal(await repository.sourceStatus(loaded.assets[1]),'missing');
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);
  assert.equal(workspace.project!.jobs[0].status,'failed');assert.match(workspace.project!.jobs[0].error!,/重新定位/);assert.equal(workspace.project!.revisions.length,0);
});
test('源图同路径改写不会偷偷替换旧引用；重新导入创建新资产身份',async()=>{
  const {workspace,directory}=await fixture();const file=path.join(directory,'changed.png');await makeImage(file);
  await workspace.importFiles([file],workspace.project!.recipe.modules[0].module_id);const old=structuredClone(workspace.project!.assets[0]);
  await makeImage(file,'#c06060');await assert.rejects(()=>workspace.repository!.readAsset(old),/内容已改变/);
  await workspace.importFiles([file]);assert.equal(workspace.project!.assets.length,2);assert.notEqual(workspace.project!.assets[1].asset_id,old.asset_id);
  assert.deepEqual(workspace.project!.recipe.modules[0].asset_ids,[old.asset_id]);
});
test('重新定位只允许同一内容，保留引用身份与顺序',async()=>{
  const {workspace,directory}=await fixture();const file=path.join(directory,'old.png'),moved=path.join(directory,'new.png');await makeImage(file);
  await workspace.importFiles([file,file],workspace.project!.recipe.modules[0].module_id);const id=workspace.project!.assets[0].asset_id;await rename(file,moved);
  await workspace.relinkAsset(id,moved);assert.deepEqual(workspace.project!.recipe.modules[0].asset_ids,[id,id]);assert.ok((await workspace.repository!.readAsset(workspace.project!.assets[0])).length);
  const other=path.join(directory,'other.png');await makeImage(other,'#ffffff');await assert.rejects(()=>workspace.relinkAsset(id,other),/同一份原图/);
  assert.equal(workspace.project!.assets[0].location.type==='external'&&workspace.project!.assets[0].location.path,moved);
});
test('打包另存复制参考与结果，包可独立打开，当前链接状态不变',async()=>{
  const {workspace,directory}=await fixture();const file=path.join(directory,'pack-source.png');await makeImage(file);await workspace.importFiles([file],workspace.project!.recipe.modules[0].module_id);
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);const before=structuredClone(workspace.project!);
  const target=path.join(directory,'packed');await (workspace.repository as ProjectRepository).packageProject(before,target);
  assert.deepEqual(workspace.project,before);await rename(file,path.join(directory,'source-moved.png'));
  const repository=new ProjectRepository(target),packed=await repository.load();assert.ok(packed.assets.every(asset=>asset.location.type==='managed'));
  for(const asset of packed.assets)assert.ok((await repository.readAsset(asset)).length);
  assert.deepEqual(packed.recipe,before.recipe);assert.deepEqual(packed.jobs,before.jobs);
  await assert.rejects(()=>(workspace.repository as ProjectRepository).packageProject(before,target),/空文件夹/);
});
test('语义类别切换更新核心语义和 reference_id，保留图片／补充／module_id，历史不变',async()=>{
  const {workspace,directory}=await fixture();const file=path.join(directory,'semantic.png');await makeImage(file);await workspace.importFiles([file],workspace.project!.recipe.modules[0].module_id);
  const recipe=structuredClone(workspace.project!.recipe);recipe.modules[0].user_instruction='保留标识';await workspace.saveRecipe(recipe);
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);const previous=structuredClone(workspace.project!.recipe.modules[0]),snapshot=structuredClone(workspace.project!.jobs[0]);
  await workspace.changeReferenceType(previous.module_id,'style');const next=workspace.project!.recipe.modules[0];
  assert.equal(next.module_id,previous.module_id);assert.notEqual(next.reference_id,previous.reference_id);assert.equal(next.reference_type,'style');assert.equal(next.base_instruction,workspace.registry.get('style').base_instruction);
  assert.deepEqual(next.asset_ids,previous.asset_ids);assert.equal(next.user_instruction,previous.user_instruction);assert.deepEqual(workspace.project!.jobs[0],snapshot);
  await assert.rejects(()=>workspace.changeReferenceType(next.module_id,'prompt'),/仅语义/);
});
test('旧 v1 自包含记录显式读迁移，不删除原图，不在读取时改写清单',async()=>{
  const {workspace,directory}=await fixture();const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#ffffff'}}).png().toBuffer();
  const asset=await workspace.repository!.saveOutput(bytes,'legacy.png','png');const raw:any=structuredClone(workspace.project!);raw.schema_version=1;
  const relative_path=`assets/${asset.asset_id}.png`;await writeFile(path.join(directory,relative_path),bytes);
  raw.assets=[{...asset,relative_path}];delete raw.assets[0].location;raw.recipe.modules[0].asset_ids=[asset.asset_id];
  const manifest=path.join(directory,projectFilename);await writeFile(manifest,JSON.stringify(raw));
  const loaded=await new ProjectRepository(directory).load();assert.equal(loaded.schema_version,2);assert.equal(loaded.assets[0].location.type,'managed');assert.ok((await workspace.repository!.readAsset(loaded.assets[0])).length);
  assert.equal(JSON.parse(await readFile(manifest,'utf8')).schema_version,1);
});

test('打开打包记录时派生新工作，不自动改写归档；原素材仍只链接',async()=>{
  const {workspace,directory}=await fixture();const file=path.join(directory,'archive.png');await makeImage(file);await workspace.importFiles([file],workspace.project!.recipe.modules[0].module_id);
  await workspace.serial(()=>workspace.enqueue(false));await settle(workspace);
  const archive=path.join(directory,'archive'),fork=path.join(directory,'fork');await (workspace.repository as ProjectRepository).packageProject(workspace.project!,archive);
  const repository=new ProjectRepository(archive),archived=await repository.load(),manifest=await readFile(path.join(archive,projectFilename),'utf8');
  await repository.forkWorkspace(archived,fork);const loaded=await new ProjectRepository(fork).load();
  assert.notEqual(loaded.project_id,archived.project_id);assert.equal(loaded.assets.find(a=>a.kind==='import')!.location.type,'external');assert.equal(loaded.assets.find(a=>a.kind==='output')!.location.type,'managed');
  assert.deepEqual(loaded.recipe,archived.recipe);assert.equal(await readFile(path.join(archive,projectFilename),'utf8'),manifest);
});

test('功能参考保存工具状态与 PNG，生成新素材但保留模块身份',async()=>{
  const {workspace}=await fixture();await workspace.addModule('viewpoint');const module=structuredClone(workspace.project!.recipe.modules.at(-1)!);
  const bytes=await sharp({create:{width:600,height:600,channels:3,background:'#e0e5da'}}).png().toBuffer();
  await workspace.saveToolReference(module.module_id,bytes,{yaw:45,pitch:-20,roll:0,projection:'perspective'},'保持商品比例');
  const saved=workspace.project!.recipe.modules.at(-1)!;assert.equal(saved.reference_id,module.reference_id);assert.equal(saved.tool_state!.yaw,45);assert.equal(saved.asset_ids.length,1);assert.equal(workspace.project!.assets.at(-1)!.kind,'generated');
  await assert.rejects(()=>workspace.importFiles(['arbitrary.png'],module.module_id),/功能参考工具/);
  assert.equal(saved.tool_state!.projection,'perspective');
  const reloaded=await workspace.repository!.load();
  assert.equal(reloaded.recipe.modules.find(m=>m.module_id===module.module_id)!.tool_state!.projection,'perspective');
});
