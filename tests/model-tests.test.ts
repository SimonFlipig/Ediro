import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelTests,type ModelTestRecord } from '../src/core/model-tests.js';
import { ModelLibrary,seedModels } from '../src/core/models.js';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { migrateModels,mockDescription } from '../src/core/model-library.js';
import type { CloudExecutionPort } from '../src/core/ports.js';
async function fixture(executor:CloudExecutionPort){const data=migrateModels(seedModels()),keys=new Map<string,string>(),library=new ModelLibrary(data,async()=>{},{has:async ref=>keys.has(ref),set:async(ref,key)=>{keys.set(ref,key);},resolve:async ref=>keys.get(ref)!},[mockDescription,new GeminiGenerator().description]);await library.saveConnection(data.connections[0],'private-key');await library.saveModel({...data.models[2],model_config_id:'model_reasoning',purpose:'understanding',model:'gemini-3.1-pro-preview',capabilities:{...data.models[2].capabilities,operations:['understand']}});const stored:ModelTestRecord[][]=[];const runner=new ModelTests([],async records=>{stored.push(records);},executor,model=>library.credential(model));return {library,runner,stored};}
test('推理测试冻结配置、不发送素材或配方，成功后显式采用；改连接使验证过期',async()=>{
  let calls=0;const {library,runner,stored}=await fixture({execute:async c=>{calls++;assert.equal(await c.resolveCredential(),'private-key');assert.equal(c.job.chain_snapshot.blocks.length,1);assert.match(c.job.chain_snapshot.blocks[0].type==='text'?c.job.chain_snapshot.blocks[0].text:'',/17 × 23/);await assert.rejects(()=>c.readImage('asset_private'),/不发送/);return {images:[],text:'391',usage:{totalTokenCount:15}};}});
  const record=await runner.run(await library.execution('model_reasoning'));assert.equal(record.status,'succeeded');assert.equal(calls,1);assert.equal(library.resolve('model_reasoning').validation_status,'untested');assert.equal(stored[0][0].status,'running');
  const summary=JSON.stringify(runner.list());assert.ok(!summary.includes('private-key')&&!summary.includes('credential_ref')&&!summary.includes('endpoint'));
  await library.acceptTest(runner.successful(record.test_id));assert.equal(library.resolve('model_reasoning').validation_status,'passed');
  await library.saveConnection({...library.snapshot().connections[0],endpoint:'https://new.example'});assert.equal(library.resolve('model_reasoning').validation_status,'stale');await assert.rejects(()=>library.acceptTest(record),/重新测试/);
});
test('错误答案和网络失败不自动重试，失败测试不可采用',async()=>{
  let calls=0;const {library,runner}=await fixture({execute:async()=>{calls++;return {images:[],text:'392'};}});const record=await runner.run(await library.execution('model_reasoning'));assert.equal(record.status,'failed');assert.equal(calls,1);assert.throws(()=>runner.successful(record.test_id),/成功测试/);assert.equal(library.resolve('model_reasoning').validation_status,'untested');
});
test('测试开始落盘失败时不发请求；启动恢复不重发中断测试',async()=>{
  let calls=0;const executor:CloudExecutionPort={execute:async()=>{calls++;return {images:[],text:'391'};}},f=await fixture(executor),runner=new ModelTests([],async()=>{throw new Error('disk');},executor,model=>f.library.credential(model));await assert.rejects(async()=>runner.run(await f.library.execution('model_reasoning')),/disk/);assert.equal(calls,0);
  const interrupted:ModelTestRecord={test_id:'test_interrupted',model_config_id:'model_reasoning',model_revision:1,connection_revision:1,adapter_version:1,model:'gemini-3.1-pro-preview',adapter_id:'gemini-generate-content',status:'running',created_at:new Date().toISOString(),fee:'unknown',operation:'understand'};
  const reopened=new ModelTests([interrupted],async()=>{},executor,async()=>'key');await reopened.recover();assert.equal(reopened.list()[0].status,'failed');assert.equal(calls,0);
});
test('保存模型不能伪造测试凭据，模型编辑会清除验证',async()=>{
  const {library,runner}=await fixture({execute:async()=>({images:[],text:'391'})});const r=await runner.run(await library.execution('model_reasoning'));await library.acceptTest(r);const entry=library.snapshot().models.find(m=>m.model_config_id==='model_reasoning')!;
  await library.saveModel({...entry,title:'更改名称'});assert.equal(library.resolve('model_reasoning').validation_status,'untested');
});
