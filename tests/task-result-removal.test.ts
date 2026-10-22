import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {ProjectRepository} from '../src/adapters/project-repository.js';
import {DocumentRepository} from '../src/adapters/document-repository.js';
import {commandSchema} from '../src/shared/commands.js';
import type {JobStatus} from '../src/core/domain.js';

async function fixture(document=false){
  const root=path.resolve('.local/test-projects');await mkdir(root,{recursive:true});
  const directory=await mkdtemp(path.join(root,'task-removal-'));
  const filename=path.join(directory,'history.ediro'),cache=path.join(directory,'cache');
  const repository=document?await DocumentRepository.prepare(filename,cache):new ProjectRepository(directory);
  let calls=0;
  const workspace=new Workspace(new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}}),{execute:async()=>{calls++;throw Error('No model calls allowed');}});
  await workspace.create(repository,'移除结果占位');
  workspace.project!.recipe.modules.at(-1)!.user_instruction='保留此任务的生成参数';
  const task=async(status:'failed'|'cancelled')=>workspace.serial(async()=>{
    await workspace.enqueue(false);
    const job=workspace.project!.jobs.at(-1)!;
    // Hold the queue and seed a terminal task without executing any model.
    job.status=status;job.stage=status==='failed'?'受控失败':'已取消';
    await workspace.persist();return job;
  });
  return {workspace,repository,directory,filename,cache,task,calls:()=>calls};
}

test('移除失败或取消占位持久化，拒绝切换工程、未知任务和其他状态；不更改其他运行任务',async()=>{
  const {workspace:w,repository,task,calls}=await fixture();
  const failed=await task('failed'),cancelled=await task('cancelled'),project=w.project!;
  const request={type:'job:hide-result',project_id:project.project_id,task_id:failed.task_id};
  assert.deepEqual(commandSchema.parse(request),request);
  await assert.rejects(()=>w.hideTaskResult('project_other',failed.task_id),/已切换/);
  await assert.rejects(()=>w.hideTaskResult(project.project_id,'task_missing'),/不存在/);
  for(const status of ['queued','preparing','running','post_processing','succeeded'] satisfies JobStatus[]){
    failed.status=status;
    await assert.rejects(()=>w.hideTaskResult(project.project_id,failed.task_id),/只能移除/);
    assert.equal(failed.hidden_from_results,undefined);
  }
  failed.status='failed';
  const active={...structuredClone(cancelled),task_id:'task_other_running',status:'running' as const};
  project.jobs.push(active);const previousActive=structuredClone(active);
  const recipe=structuredClone(project.recipe);
  await w.serial(()=>w.hideTaskResult(project.project_id,failed.task_id));
  await w.serial(()=>w.hideTaskResult(project.project_id,cancelled.task_id));
  await w.serial(()=>w.hideTaskResult(project.project_id,cancelled.task_id));
  assert.deepEqual(active,previousActive);assert.deepEqual(project.recipe,recipe);
  const saved=await repository.load();
  assert.equal(saved.jobs[0].hidden_from_results,true);assert.equal(saved.jobs[1].hidden_from_results,true);
  assert.equal(saved.jobs[2].hidden_from_results,undefined);assert.equal(saved.jobs.length,3);
  await w.serial(async()=>{
    await w.retry(project.project_id,failed.task_id);
    const retried=project.jobs.at(-1)!;
    assert.equal(retried.hidden_from_results,undefined,'a new retry must not inherit the removed placeholder state');
    retried.status='cancelled';await w.persist();
  });
  assert.equal(failed.hidden_from_results,true);
  assert.equal(calls(),0);await w.shutdown();
});

test('移除任务后单文件工程重开仍保留历史、已有输出引用和待恢复返回；恢复不再次执行',async()=>{
  const {workspace:w,repository:repo,task,filename,cache,calls}=await fixture(true);
  const job=await task('failed'),project=w.project!;
  const bytes=await sharp({create:{width:24,height:20,channels:3,background:'#cc8877'}}).png().toBuffer();
  const output=await repo.saveOutput(bytes,'partial.png','png');
  project.assets.push(output);job.output_asset_ids.push(output.asset_id);
  project.revisions.push({revision_id:'revision_partial',asset_id:output.asset_id,task_id:job.task_id,created_at:output.created_at});
  project.recipe.modules[0].asset_ids=[output.asset_id];
  await repo.stageResult(job,{images:[{bytes,format:'png',width:24,height:20}]});job.recoverable_result=true;
  const before=structuredClone(project);
  await w.serial(()=>w.hideTaskResult(project.project_id,job.task_id));
  await w.shutdown();await (repo as DocumentRepository).close();
  const reopened=await DocumentRepository.open(filename,cache);
  await w.open(reopened);
  const restored=w.project!,savedJob=restored.jobs[0];
  assert.equal(savedJob.hidden_from_results,true);
  assert.deepEqual({...savedJob,hidden_from_results:undefined},{...before.jobs[0],hidden_from_results:undefined});
  assert.deepEqual(restored.assets,before.assets);assert.deepEqual(restored.revisions,before.revisions);
  assert.deepEqual(restored.recipe.modules[0].asset_ids,[output.asset_id]);
  assert.deepEqual(await reopened.readAsset(restored.assets[0]),bytes);
  assert.deepEqual((await reopened.pendingResult(job.task_id)).images[0].bytes,bytes);
  await w.serial(()=>w.restoreTaskRecipe(restored.project_id,savedJob.task_id));
  await w.serial(()=>w.recoverResult(savedJob.task_id));
  assert.equal(savedJob.status,'succeeded');assert.deepEqual(savedJob.output_asset_ids,[output.asset_id]);
  assert.equal(calls(),0);await w.shutdown();await reopened.close();
});

test('移除占位保存失败会恢复标记；重试保存后才持久生效',async()=>{
  const {workspace:w,repository,task}=await fixture();
  const job=await task('cancelled'),before=structuredClone(job),projectId=w.project!.project_id;
  const save=repository.save.bind(repository);
  repository.save=async()=>{throw Error('controlled storage failure');};
  await assert.rejects(()=>w.hideTaskResult(projectId,job.task_id),/controlled storage failure/);
  assert.deepEqual(job,before);assert.deepEqual((await repository.load()).jobs[0],before);
  repository.save=save;
  await w.hideTaskResult(projectId,job.task_id);
  assert.equal((await repository.load()).jobs[0].hidden_from_results,true);
  await w.shutdown();
});
