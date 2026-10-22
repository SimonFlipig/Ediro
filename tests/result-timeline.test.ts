import test from 'node:test';
import assert from 'node:assert/strict';
import type {Block,Job,JobStatus} from '../src/core/domain.js';
import type {ViewAsset} from '../src/shared/api.js';
import {isActiveJob,resultTimeline,taskReferenceAsset} from '../src/ui/result-timeline.js';

const time=(minute:number)=>`2026-10-22T05:${String(minute).padStart(2,'0')}:00.000Z`;
const asset=(id:string,minute:number,patch:Partial<ViewAsset>={}):ViewAsset=>({asset_id:id,kind:'output',created_at:time(minute),preview_url:`ediro-asset://${id}`,source_status:'available',...patch} as ViewAsset);
const job=(id:string,status:JobStatus,minute:number,outputs:string[]=[],patch:Partial<Job>={}):Job=>({task_id:id,status,created_at:time(minute),output_asset_ids:outputs,chain_snapshot:{blocks:[],mode:'text_to_image'},...patch} as Job);
const keys=(jobs:Job[],assets:ViewAsset[]=[])=>resultTimeline(jobs,assets).map(entry=>entry.key);
const image=(id:string,type:string):Block=>({type:'image',asset_id:id,reference_type:type,source_module_id:`module_${type}`,reference_id:`reference_${type}`});

test('各运行阶段与失败取消均保留任务入口，成功任务不留空占位',()=>{
  const statuses:JobStatus[]=['queued','preparing','running','post_processing','failed','cancelled','succeeded'];
  const jobs=statuses.map((status,index)=>job(`job_${status}`,status,index));
  assert.deepEqual(jobs.map(isActiveJob),[true,true,true,true,false,false,false]);
  assert.deepEqual(keys(jobs),statuses.slice(0,-1).map(status=>`task:job_${status}`));
  assert.deepEqual(keys(structuredClone(jobs)),keys(jobs),'reloaded task records preserve their recoverable entries');
});

test('成功多输出替换原任务位置，不越过后排任务；保存失败仍保留任务及部分产物',()=>{
  const first=job('first','running',1),second=job('second','queued',2);
  assert.deepEqual(keys([first,second]),['task:first','task:second']);
  const outputs=[asset('a',3),asset('b',3)];
  assert.deepEqual(keys([{...first,status:'succeeded',output_asset_ids:['a','b']},second],outputs),['asset:a','asset:b','task:second']);
  const failed={...first,status:'failed' as const,output_asset_ids:['a'],recoverable_result:true};
  assert.deepEqual(keys([failed,second],outputs.slice(0,1)),['task:first','asset:a','task:second']);
});

test('移除失败取消任务只隐藏占位，已有结果与运行中任务始终保留',()=>{
  const jobs=[job('failed','failed',1,['partial'],{hidden_from_results:true}),job('cancelled','cancelled',2,[],{hidden_from_results:true}),job('active','running',3,[],{hidden_from_results:true})];
  const before=structuredClone(jobs);
  assert.deepEqual(keys(jobs,[asset('partial',2)]),['asset:partial','task:active']);
  assert.deepEqual(jobs,before,'history snapshots are unchanged by list filtering');
});

test('过滤隐藏删除缺失结果，保留无任务可见结果，派生时间线不改写历史',()=>{
  const jobs=[job('done','succeeded',2,['hidden','deleted','missing','good'])];
  const assets=[asset('orphan',1),asset('hidden',3,{hidden_from_results:true}),asset('deleted',3,{removed_result:true}),asset('missing',3,{source_status:'missing'}),asset('good',3),asset('source',4,{kind:'import'})];
  const before=structuredClone({jobs,assets});
  const entries=resultTimeline(jobs,assets);
  assert.deepEqual(entries.map(entry=>entry.key),['asset:orphan','asset:good']);
  assert.equal(entries[0].kind==='result'&&entries[0].job,undefined);
  assert.equal(entries[1].kind==='result'&&entries[1].job,jobs[0]);
  assert.deepEqual({jobs,assets},before);
});

test('局部编辑后来保存的变体按保存时间追加，初始结果保持任务位置',()=>{
  const mask=job('mask','succeeded',1,['initial','later'],{mask_edit:{draft:{source_asset_id:'source'}} as Job['mask_edit']});
  const newer=job('newer','succeeded',2,['newer_result']);
  assert.deepEqual(keys([mask,newer],[asset('initial',2),asset('newer_result',3),asset('later',4)]),['asset:initial','asset:newer_result','asset:later']);
  assert.deepEqual(keys([mask,newer],[asset('initial',2,{hidden_from_results:true}),asset('newer_result',3),asset('later',4)]),['asset:newer_result','asset:later']);
});

test('相同创建时间保持任务及输出顺序，重复输出不会重复显示',()=>{
  const jobs=[job('first','succeeded',1,['a','b']),job('second','failed',1,['a'])];
  assert.deepEqual(keys(jobs,[asset('b',3),asset('a',2)]),['asset:a','asset:b','task:second']);
});

test('马赛克来源按冻结链优先主体，跳过失效素材，只有文字时使用备用色块',()=>{
  const subject=asset('subject',1,{kind:'import',hidden_from_materials:true}),composition=asset('composition',1,{kind:'import'}),current=asset('current',1,{kind:'import'});
  const task=job('task','running',1,[],{chain_snapshot:{blocks:[image('composition','composition'),image('subject','subject')],mode:'reference_generation'}});
  assert.equal(taskReferenceAsset(task,[current,composition,subject]),subject);
  assert.equal(taskReferenceAsset(task,[composition,{...subject,source_status:'missing'}]),composition);
  assert.equal(taskReferenceAsset(task,[composition,{...subject,source_status:'changed'}]),composition);
  assert.equal(taskReferenceAsset(task,[current]),undefined,'unrelated current recipe images cannot replace frozen inputs');
  assert.equal(taskReferenceAsset(job('text','running',1),[subject]),undefined);
  const mask={...task,mask_edit:{draft:{source_asset_id:'current'}} as Job['mask_edit']};
  assert.equal(taskReferenceAsset(mask,[subject,composition,current]),current);
});
