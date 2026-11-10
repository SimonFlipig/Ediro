import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ExecutionRegistry, type ExecutionAdapter } from '../src/adapters/execution-registry.js';
import { GenerationFailureLog, type GenerationFailureRecord } from '../src/adapters/generation-failure-log.js';
import { seedModels } from '../src/core/models.js';
import type { CloudExecutionContext, ExecutionResult } from '../src/core/ports.js';
import type { Job } from '../src/core/domain.js';

function context():CloudExecutionContext{
  const model=seedModels()[2];
  const job={task_id:'task_diagnostic_1',recipe_snapshot:{core_parameters:model.defaults},adapted_input:{kind:'native_blocks',blocks:[{type:'text',text:'private prompt',source_module_id:'mod_one',reference_type:'prompt',reference_id:'ref_one'}],adjustments:[]}} as unknown as Job;
  return {model,job,readImage:async()=>{throw new Error('unexpected image read');},resolveCredential:async()=>'private-api-key'};
}
async function logFixture(){const root=await mkdtemp(path.join(os.tmpdir(),'ediro-diagnostics-')),log=new GenerationFailureLog(root);await log.initialize();return {root,log};}
async function rows(log:GenerationFailureLog):Promise<GenerationFailureRecord[]>{return (await readFile(log.filename,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
function adapter(execute:ExecutionAdapter['execute']):ExecutionAdapter{return {description:new GeminiGenerator().description,execute};}

test('真实 Gemini 超时链路只写一条本地诊断，任务和调用上下文不增加持久化信息',async t=>{
  const {root,log}=await logFixture(),deadline=new AbortController(),c=context(),before=structuredClone(c.job);
  t.mock.method(AbortSignal,'timeout',()=>deadline.signal);
  const chunk=new TextEncoder().encode('{"private":"');let calls=0,pulls=0;
  const generator=new GeminiGenerator(async()=>{
    calls++;
    return new Response(new ReadableStream<Uint8Array>({pull(stream){
      if(pulls++===0){stream.enqueue(chunk);return;}
      deadline.abort(new DOMException('private-api-key private response','TimeoutError'));
      stream.error(deadline.signal.reason);
    }},{highWaterMark:0}),{headers:{'x-request-id':'upstream-timeout-1'}});
  });
  const registry=new ExecutionRegistry(undefined,record=>log.append(record)).register(generator);
  await assert.rejects(registry.execute(c,new AbortController().signal,async()=>{}),/超过 10 分钟/);
  const saved=await rows(log);
  assert.equal(calls,1);assert.equal(saved.length,1);
  assert.equal(saved[0].task_id,c.job.task_id);assert.equal(saved[0].model,c.model.model);assert.equal(saved[0].adapter_id,c.model.adapter_id);
  assert.equal(saved[0].stage,'response_body');assert.equal(saved[0].reason,'timeout');assert.equal(saved[0].timeout_ms,600_000);
  assert.equal(saved[0].http_status,200);assert.equal(saved[0].received_bytes,chunk.length);assert.equal(saved[0].upstream_request_id,'upstream-timeout-1');assert.equal(saved[0].error_name,'TimeoutError');
  assert.ok(saved[0].duration_ms>=0);assert.ok(Number.isFinite(Date.parse(saved[0].timestamp)));
  assert.doesNotMatch(await readFile(log.filename,'utf8'),/private|prompt|"body"|headers|"message"/);
  assert.deepEqual(c.job,before);assert.equal(c.diagnostics,undefined);assert.deepEqual(await readdir(root),['logs']);
});

test('无效 JSON 的安全诊断落入独立日志，不写入原始错误片段',async()=>{
  const {log}=await logFixture(),c=context(),before=structuredClone(c.job);let calls=0;
  const registry=new ExecutionRegistry(undefined,record=>log.append(record)).register(new GeminiGenerator(async()=>{
    calls++;return new Response('private-api-key private prompt',{headers:{'request-id':'bad-json-upstream'}});
  }));
  await assert.rejects(registry.execute(c,new AbortController().signal,async()=>{}),/响应读取或解析失败/);
  const saved=await rows(log);assert.equal(calls,1);assert.equal(saved.length,1);
  assert.equal(saved[0].stage,'response_parse');assert.equal(saved[0].reason,'invalid_json');assert.equal(saved[0].error_name,'SyntaxError');assert.equal(saved[0].upstream_request_id,'bad-json-upstream');
  assert.doesNotMatch(await readFile(log.filename,'utf8'),/private|prompt|"message"/);assert.deepEqual(c.job,before);
});

test('成功、用户取消和理解任务不产生生图失败日志，成功返回对象保持原样',async()=>{
  const {root,log}=await logFixture(),c=context(),before=structuredClone(c.job);
  const success:ExecutionResult={images:[],request_id:'successful-request',text:'result'};
  const successful=new ExecutionRegistry(undefined,record=>log.append(record)).register(adapter(async context=>{
    assert.ok(context.diagnostics);context.diagnostics.upstream_request_id='successful-request';return success;
  }));
  const result=await successful.execute(c,new AbortController().signal,async()=>{});
  assert.equal(result,success);assert.equal(Object.hasOwn(result,'diagnostics'),false);

  const caller=new AbortController(),cancelError=new DOMException('cancelled','AbortError');let calls=0;
  const cancelled=new ExecutionRegistry(undefined,record=>log.append(record)).register(adapter(async context=>{
    calls++;assert.ok(context.diagnostics);context.diagnostics.stage='response_body';caller.abort(cancelError);throw cancelError;
  }));
  await assert.rejects(cancelled.execute(c,caller.signal,async()=>{}),error=>error===cancelError);
  assert.equal(calls,1);assert.deepEqual(c.job,before);

  c.model.purpose='understanding';const inferenceError=new Error('inference failed');
  const understanding=new ExecutionRegistry(undefined,record=>log.append(record)).register(adapter(async context=>{
    assert.equal(context.diagnostics,undefined);throw inferenceError;
  }));
  await assert.rejects(understanding.execute(c,new AbortController().signal,async()=>{}),error=>error===inferenceError);
  assert.deepEqual(await readdir(root),[]);assert.equal(c.diagnostics,undefined);
});

test('每次执行使用独立诊断，不让旧请求编号或超时原因污染下一次失败',async()=>{
  const {log}=await logFixture(),c=context();let calls=0;
  const registry=new ExecutionRegistry(undefined,record=>log.append(record)).register(adapter(async context=>{
    assert.ok(context.diagnostics);calls++;
    if(calls===1){context.diagnostics.stage='response_body';context.diagnostics.reason='timeout';context.diagnostics.upstream_request_id='first-request';}
    throw new Error('private internal error');
  }));
  await assert.rejects(registry.execute(c,new AbortController().signal,async()=>{}));
  c.job.task_id='task_diagnostic_2';
  await assert.rejects(registry.execute(c,new AbortController().signal,async()=>{}));
  const saved=await rows(log);assert.equal(saved.length,2);assert.equal(calls,2);
  assert.equal(saved[0].upstream_request_id,'first-request');assert.equal(saved[0].reason,'timeout');
  assert.equal(saved[1].upstream_request_id,undefined);assert.equal(saved[1].stage,'preparing');assert.equal(saved[1].reason,'execution_error');
});

test('本地日志写入失败保留原始任务异常，不重试生成',async t=>{
  const warning=t.mock.method(console,'warn',()=>{}),original=new Error('original generation failure');let calls=0,writes=0;
  const c=context(),before=structuredClone(c.job);
  const registry=new ExecutionRegistry(undefined,async()=>{writes++;throw new Error('disk unavailable');}).register(adapter(async()=>{calls++;throw original;}));
  await assert.rejects(registry.execute(c,new AbortController().signal,async()=>{}),error=>error===original);
  assert.equal(calls,1);assert.equal(writes,1);assert.equal(warning.mock.callCount(),1);assert.deepEqual(c.job,before);
});
