import test from 'node:test';
import assert from 'node:assert/strict';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {MockGenerator} from '../src/adapters/mock-generator.js';
import type {MaskPixelsPort,MaskPreviewSession} from '../src/core/mask.js';
import type {ProjectStorePort} from '../src/core/ports.js';
import type {Asset,Job} from '../src/core/domain.js';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const repository=(readAsset:ProjectStorePort['readAsset'])=>({directory:'.',create:async()=>{},save:async()=>{},readAsset} as ProjectStorePort);
async function fixture(createPreview:NonNullable<MaskPixelsPort['createPreview']>,readAsset:ProjectStorePort['readAsset']){
  const workspace=new Workspace(new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}}),new MockGenerator(1),undefined,{createPreview} as MaskPixelsPort);
  await workspace.create(repository(readAsset),'预览生命周期');
  // The fixture contains only fields read by the preview path; no generation or
  // filesystem work is needed to control its asynchronous session boundaries.
  workspace.project!.assets=[{asset_id:'asset_source'},{asset_id:'asset_raw'}] as Asset[];
  workspace.project!.jobs=[{task_id:'task_mask',status:'succeeded',mask_edit:{source_snapshot_id:'asset_source',raw_asset_ids:['asset_raw'],draft:{width:32,height:32,strokes:[]}}}] as Job[];
  return workspace;
}

test('预览复用一次素材读取，失败重建，切工程拒绝旧结果并释放会话',async()=>{
  let reads=0,created=0,disposed=0,fail=false,pending:ReturnType<typeof deferred<Buffer>>|undefined;
  const rendering=deferred<void>();
  const w=await fixture(async()=>{
    created++;return {render:async()=>{if(fail)throw new Error('模拟预览进程失败');if(pending){rendering.resolve();return pending.promise;}return Buffer.from('preview');},dispose:()=>{disposed++;}} satisfies MaskPreviewSession;
  },async()=>{reads++;return Buffer.from('input');});
  const id=w.project!.project_id,preview=()=>w.previewMask(id,'task_mask','strict',0,[]);
  assert.match(await preview(),/^data:image\/png;base64,/);await preview();assert.equal(reads,2);assert.equal(created,1);
  fail=true;await assert.rejects(preview,/模拟预览进程失败/);assert.equal(disposed,1);
  fail=false;await preview();assert.equal(reads,4);assert.equal(created,2);
  pending=deferred<Buffer>();const old=preview();await rendering.promise;
  await w.create(repository(async()=>Buffer.from('new')),'新工程');
  pending.resolve(Buffer.from('old result'));
  await assert.rejects(old,/工作记录已切换/);assert.equal(disposed,2);assert.equal(w.project!.name,'新工程');
  await w.shutdown();
});

test('固定素材读取尚未结束时切换工程，不创建过期的预览worker',async()=>{
  const input=deferred<Buffer>();let created=0;
  const w=await fixture(async()=>{created++;return {render:async()=>Buffer.from('unused'),dispose:()=>{}};},()=>input.promise);
  const preview=w.previewMask(w.project!.project_id,'task_mask','strict',0,[]);
  await w.create(repository(async()=>Buffer.from('new')),'另一工程');input.resolve(Buffer.from('old input'));
  await assert.rejects(preview,/工作记录已切换/);assert.equal(created,0);
  await w.shutdown();
});
