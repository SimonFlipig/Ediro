import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary} from '../src/core/models.js';
import {GenerationTimings} from '../src/core/generation-timing.js';
import {ProjectRepository,projectFilename} from '../src/adapters/project-repository.js';
import {GeminiGenerator} from '../src/adapters/gemini-generator.js';
import {modelForEnrollment} from '../src/protocols/model-catalog.js';
import type {ExecutionResult} from '../src/core/ports.js';

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){for(let i=0;i<300;i++){if(check())return;await wait(10);}throw Error('timing test timeout');}
async function fixture(){
  const root=path.resolve('.local/test-projects');await mkdir(root,{recursive:true});
  const directory=await mkdtemp(path.join(root,'timing-'));
  const model=modelForEnrollment('nano','gemini-generate-content','model_timing','connection_timing','timing-image');
  const library=new ModelLibrary({schema_version:3,connections:[{connection_id:'connection_timing',title:'本地受控平台',endpoint:'https://invalid.test',revision:1,enabled:true}],models:[{...model,origin:'user',purpose:'generation',capability_source:'user'}],assignments:{generation_default:model.model_config_id}},async()=>{},{has:async()=>false,set:async()=>{}},[{...new GeminiGenerator().description,requires_credential:false}]);
  const bytes=await sharp({create:{width:32,height:32,channels:3,background:'#445566'}}).png().toBuffer();
  const controls:{succeed:()=>void;fail:()=>void}[]=[];
  const workspace=new Workspace(library,{execute:async(_context,signal,progress)=>{
    await progress('等待本地受控结果',30);
    return new Promise<ExecutionResult>((resolve,reject)=>{
      const abort=()=>reject(Error('cancelled'));
      signal.addEventListener('abort',abort,{once:true});
      controls.push({succeed:()=>{signal.removeEventListener('abort',abort);resolve({images:[{bytes,format:'png',width:32,height:32}]});},fail:()=>{signal.removeEventListener('abort',abort);reject(Error('controlled failure'));}});
      if(signal.aborted)abort();
    });
  }});
  await workspace.create(new ProjectRepository(directory),'时长测试');
  workspace.project!.recipe.modules.at(-1)!.user_instruction='本地受控生成';
  await workspace.persist();
  const settle=async()=>{await until(()=>workspace.project!.jobs.every(j=>['succeeded','failed','cancelled'].includes(j.status)));await workspace.serial(async()=>{});};
  return {workspace,controls,directory,settle};
}

test('计时从出队开始；样本只留程序内，工程不保存计时与预计数据',async()=>{
  const {workspace:w,controls,directory,settle}=await fixture();
  await w.serial(()=>w.enqueue(false));await until(()=>controls.length===1);
  await w.serial(()=>w.enqueue(false));
  const [first,second]=w.project!.jobs;
  assert.equal(w.generationTimingByTask.get(second.task_id),undefined);assert.equal(second.status,'queued');
  // A long queue/creation age must never turn into a generation duration.
  second.created_at=new Date(Date.now()-3_600_000).toISOString();
  await wait(80);controls[0].succeed();await until(()=>controls.length===2);
  const firstTiming=w.generationTimingByTask.get(first.task_id)!,secondTiming=w.generationTimingByTask.get(second.task_id)!;
  assert.equal(first.status,'succeeded');assert.ok(firstTiming.duration_ms!>=80);
  assert.equal(secondTiming.sample_count,1);
  assert.equal(secondTiming.estimated_duration_ms,firstTiming.duration_ms);
  assert.equal(secondTiming.platform_id,firstTiming.platform_id);
  assert.equal(secondTiming.family,'nano');
  assert.ok(Date.parse(secondTiming.started_at)>Date.parse(second.created_at)+3_000_000);
  controls[1].succeed();await settle();
  assert.ok(secondTiming.duration_ms!<10_000);
  assert.equal(w.generationTimings.snapshot().length,2);
  const samples=w.generationTimings.snapshot();
  assert.ok(w.project!.jobs.every(job=>!('timing' in job)));
  assert.doesNotMatch(await readFile(path.join(directory,projectFilename),'utf8'),/"(?:timing|estimated_duration_ms|sample_count|duration_ms|platform_id)"/);
  await w.open(new ProjectRepository(directory));
  assert.equal(w.generationTimingByTask.size,0,'opening a project clears transient per-task timing');
  assert.deepEqual(w.generationTimings.snapshot(),samples,'application samples survive switching/opening projects');
  assert.ok(w.project!.jobs.every(job=>!('timing' in job)));
  await w.shutdown();
});

test('失败和取消不采样；重试创建新计时而不继承旧预计时间',async()=>{
  const {workspace:w,controls,settle}=await fixture();
  await w.serial(()=>w.enqueue(false));await until(()=>controls.length===1);
  controls[0].fail();await settle();
  const old=w.project!.jobs[0];assert.equal(old.status,'failed');assert.ok(w.generationTimingByTask.get(old.task_id)!.duration_ms!>0);
  const original=structuredClone(w.generationTimingByTask.get(old.task_id));assert.equal(w.generationTimings.snapshot().length,0);
  await w.serial(async()=>{
    await w.retry(w.project!.project_id,old.task_id);
    assert.equal(w.generationTimingByTask.get(w.project!.jobs[1].task_id),undefined,'retry has no timing before queue starts');
  });
  await until(()=>controls.length===2);
  const retried=w.project!.jobs[1],retryTiming=w.generationTimingByTask.get(retried.task_id)!;assert.equal(retryTiming.duration_ms,undefined);assert.equal(retryTiming.sample_count,0);
  await w.serial(()=>w.cancel(retried.task_id));await settle();
  assert.equal(retried.status,'cancelled');assert.equal(w.generationTimings.snapshot().length,0);
  assert.deepEqual(w.generationTimingByTask.get(old.task_id),original);assert.ok(w.project!.jobs.every(job=>!('timing' in job)));await w.shutdown();
});

test('本地结果恢复不会把等待恢复时间计入或重复采样',async()=>{
  const {workspace:w,controls,settle}=await fixture();
  const repo=w.repository!,saveOutput=repo.saveOutput.bind(repo);let broken=true;
  repo.saveOutput=async(...args)=>{if(broken)throw Error('controlled disk error');return saveOutput(...args);};
  await w.serial(()=>w.enqueue(false));await until(()=>controls.length===1);
  controls[0].succeed();await settle();
  const job=w.project!.jobs[0],duration=w.generationTimingByTask.get(job.task_id)!.duration_ms;
  assert.equal(job.status,'failed');assert.ok(job.recoverable_result);assert.equal(w.generationTimings.snapshot().length,0);
  await wait(80);broken=false;await w.serial(()=>w.recoverResult(job.task_id));
  assert.equal(job.status,'succeeded');assert.equal(w.generationTimingByTask.get(job.task_id)!.duration_ms,duration);
  assert.equal(controls.length,1);assert.equal(w.generationTimings.snapshot().length,0);
  await w.shutdown();
});

test('耗时统计写入失败不影响生成成功与工程保存',async()=>{
  const {workspace:w,controls,settle}=await fixture();
  w.generationTimings=new GenerationTimings([],async()=>{throw Error('controlled timing write error');});
  await w.serial(()=>w.enqueue(false));await until(()=>controls.length===1);
  controls[0].succeed();await settle();
  const job=w.project!.jobs[0];assert.equal(job.status,'succeeded');assert.equal(job.progress,100);
  assert.equal(job.output_asset_ids.length,1);
  const saved=(await w.repository!.load()).jobs[0];assert.equal(saved.status,'succeeded');assert.equal('timing' in saved,false);assert.ok(w.generationTimingByTask.get(job.task_id)!.duration_ms!>0);
  await w.shutdown();
});

test('旧开发版本写入的计时字段读取时剥离，后续保存不再进入工程',async()=>{
  const {workspace:w,controls,directory,settle}=await fixture();
  await w.serial(()=>w.enqueue(false));await until(()=>controls.length===1);controls[0].succeed();await settle();
  const filename=path.join(directory,projectFilename),raw=JSON.parse(await readFile(filename,'utf8'));
  raw.jobs[0].timing=structuredClone(w.generationTimingByTask.get(raw.jobs[0].task_id));
  raw.generation_timings={[raw.jobs[0].task_id]:raw.jobs[0].timing};
  await writeFile(filename,JSON.stringify(raw));
  await w.open(new ProjectRepository(directory));
  assert.equal('timing' in w.project!.jobs[0],false);assert.equal('generation_timings' in w.project!,false);
  assert.equal(w.generationTimingByTask.size,0);
  await w.persist();
  assert.doesNotMatch(await readFile(filename,'utf8'),/"(?:timing|generation_timings|estimated_duration_ms|sample_count|duration_ms|platform_id)"/);
  await w.shutdown();
});
