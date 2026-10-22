import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {localImageModels,localImageModelStatus,modelDirectory,prepareLocalImageModel,resolveLocalImageModel} from '../src/adapters/local-image-models.js';

test('发布模型固定 HTTPS 来源、revision、大小和 SHA256，缺失不会自动下载',async t=>{
  for(const entry of Object.values(localImageModels)){
    assert.match(entry.revision,/^[a-f0-9]{40}$/);assert.ok(entry.license);
    for(const file of entry.files){assert.equal(new URL(file.url).protocol,'https:');assert.ok(file.url.includes(`/resolve/${entry.revision}/`));assert.match(file.sha256,/^[a-f0-9]{64}$/);assert.ok(file.size>0);}
  }
  const runtime=await mkdtemp(path.join(os.tmpdir(),'ediro-models-'));t.after(()=>rm(runtime,{recursive:true,force:true}));
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('不得自动下载');});
  assert.deepEqual(await localImageModelStatus(runtime),{depth:'missing',segment:'missing'});
  await assert.rejects(resolveLocalImageModel(runtime,'depth'),/未准备或校验失败/);
});

test('模型下载先校验后替换、并发合并、重用已验证文件，坏文件和取消不标记就绪',async t=>{
  const runtime=await mkdtemp(path.join(os.tmpdir(),'ediro-models-'));t.after(()=>rm(runtime,{recursive:true,force:true}));
  const original=localImageModels.depth,bytes=Buffer.from('controlled model fixture');
  localImageModels.depth={...original,files:[{role:'model',name:'model.onnx',url:'https://example.com/fixed-model.onnx',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
  t.after(()=>{localImageModels.depth=original;});
  let calls=0;const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(bytes);});
  await Promise.all([prepareLocalImageModel(runtime,'depth'),prepareLocalImageModel(runtime,'depth')]);
  assert.equal(calls,1);assert.equal((await localImageModelStatus(runtime)).depth,'ready');
  const files=await resolveLocalImageModel(runtime,'depth');assert.deepEqual(await readFile(files.model),bytes);
  await prepareLocalImageModel(runtime,'depth');assert.equal(calls,1);
  const provenance=JSON.parse(await readFile(path.join(modelDirectory(runtime),'depth','source.json'),'utf8'));assert.equal(provenance.revision,original.revision);
  const damaged=Buffer.alloc(bytes.length,1);await writeFile(files.model,damaged);assert.equal((await localImageModelStatus(runtime)).depth,'missing');
  mock.mock.mockImplementation(async()=>new Response(Buffer.alloc(bytes.length,2)));
  await assert.rejects(prepareLocalImageModel(runtime,'depth'),/校验失败/);
  assert.deepEqual(await readFile(files.model),damaged);assert.ok(!(await readdir(path.dirname(files.model))).some(file=>file.endsWith('.tmp')));
  const controller=new AbortController();controller.abort();await assert.rejects(prepareLocalImageModel(runtime,'depth',controller.signal),/取消/);
  assert.equal((await localImageModelStatus(runtime)).depth,'missing');
});
