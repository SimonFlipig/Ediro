import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GenerationFailureLog, type GenerationFailureRecord } from '../src/adapters/generation-failure-log.js';

const record=(index:number):GenerationFailureRecord=>({timestamp:new Date(Date.UTC(2026,10,6,0,0,index)).toISOString(),task_id:`task_${index}`,model:'gemini-3-pro-image',adapter_id:'gemini-generate-content',duration_ms:600000,stage:'response_body',reason:'timeout',timeout_ms:600000,http_status:200,received_bytes:10,upstream_request_id:`request_${index}`,error_name:'TimeoutError'});
const rows=async(log:GenerationFailureLog):Promise<GenerationFailureRecord[]>=> (await readFile(log.filename,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));

test('没有历史失败时初始化不会创建日志',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'ediro-failures-')),log=new GenerationFailureLog(root);
  await log.initialize();
  await assert.rejects(stat(log.filename),{code:'ENOENT'});
  assert.deepEqual(await readdir(root),[]);
});

test('并发写入及多个实例只保留最新 50 条，不丢失较新记录',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'ediro-failures-')),first=new GenerationFailureLog(root),second=new GenerationFailureLog(root);
  await Promise.all(Array.from({length:65},(_,index)=>(index%2?first:second).append(record(index))));
  const saved=await rows(first);
  assert.equal(saved.length,50);
  assert.deepEqual(saved.map(row=>row.task_id),Array.from({length:50},(_,index)=>`task_${index+15}`));
  await first.append(record(0));
  assert.deepEqual(await rows(first),saved,'迟到的旧失败不应淘汰新记录');
  assert.deepEqual(await readdir(path.dirname(first.filename)),['generation-errors.jsonl']);
});

test('初始化清理超量、损坏及额外敏感字段，重启后可继续追加',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'ediro-failures-')),log=new GenerationFailureLog(root);
  await mkdir(path.dirname(log.filename),{recursive:true});
  const inputs=Array.from({length:60},(_,index)=>JSON.stringify({...record(index),prompt:'private prompt',headers:{Authorization:'secret'},body:'private response',error:{message:'private parse error'}}));
  inputs.splice(15,0,'{broken');inputs.push(JSON.stringify({bad:true}));
  await writeFile(log.filename,inputs.join('\n'));
  await log.initialize();
  const saved=await rows(log);
  assert.equal(saved.length,50);assert.equal(saved[0].task_id,'task_10');
  assert.deepEqual(saved.at(-1),record(59));
  assert.doesNotMatch(await readFile(log.filename,'utf8'),/secret|private|prompt|headers|"body"|"error"/);
  await new GenerationFailureLog(root).append(record(60));
  assert.equal((await rows(log))[0].task_id,'task_11');
});

test('记录字段和输入大小受限，超大坏行不影响尾部有效记录',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'ediro-failures-')),log=new GenerationFailureLog(root);
  await mkdir(path.dirname(log.filename),{recursive:true});
  await writeFile(log.filename,'x'.repeat(300000)+'\n'+JSON.stringify(record(1))+'\n');
  await log.initialize();assert.deepEqual(await rows(log),[record(1)]);
  await log.append({...record(2),model:'m'.repeat(10000),upstream_request_id:'id\n'+'i'.repeat(10000),http_status:999,received_bytes:Infinity,prompt:'secret'} as GenerationFailureRecord);
  const saved=(await rows(log))[1];
  assert.equal(saved.model.length,200);assert.equal(saved.upstream_request_id?.length,200);
  assert.equal(saved.http_status,undefined);assert.equal(saved.received_bytes,undefined);
  assert.ok((await stat(log.filename)).size<4096);
  await assert.rejects(log.append({...record(3),duration_ms:NaN}));
  await log.append(record(4));assert.equal((await rows(log)).at(-1)?.task_id,'task_4');
});
