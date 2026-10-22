import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sha256,validateArchives} from '../scripts/source-set.mjs';
import {ensureSourceArchive} from '../scripts/package-third-party-sources.mjs';

const original=Buffer.from('upstream source plus excluded build binaries\n');
const filtered=Buffer.from('preferred source only\n');
const archive={name:'chromium',version:'test',kind:'runtime-component-source',file:'chromium-test-source-only.tar',url:'https://example.org/chromium-test.tar.xz',bytes:filtered.length,sha256:sha256(filtered),transform:{type:'chromium-source-only-v1',sourceBytes:original.length,sourceSha256:sha256(original)}};
const validate=entry=>validateArchives({schemaVersion:1,platform:'win32-x64',archives:[entry]});
const fixture=()=>mkdtemp(path.join(os.tmpdir(),'ediro-source-transform-'));
const mustNotRun=()=>{throw Error('Unexpected network or transform call');};
const absent=file=>assert.rejects(access(file),{code:'ENOENT'});

test('派生源码清单仅接受已知变换和严格上游原包身份',()=>{
  validate(archive);
  for(const transform of [null,[],{}, {...archive.transform,type:'shell-command'}, {...archive.transform,command:'run'}, {...archive.transform,sourceSha256:'bad'}, {...archive.transform,sourceSha256:'A'.repeat(64)}, ...[0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'42'].map(sourceBytes=>({...archive.transform,sourceBytes}))]){
    assert.throws(()=>validate({...archive,transform}),/Invalid source archive transform/);
  }
  // Large upstream archives remain valid safe integer metadata, not 32-bit sizes.
  validate({...archive,transform:{...archive.transform,sourceBytes:5_916_191_748}});
});

test('上游 URL 字节先独立校验，再调用变换并缓存不同的派生输出',async()=>{
  const cache=await fixture(),calls=[];
  const output=await ensureSourceArchive(archive,cache,{
    root:cache,
    fetcher:async url=>{calls.push(['fetch',url]);return new Response(original);},
    transformer:async(root,input,pending)=>{
      calls.push(['transform',input]);assert.equal(root,cache);
      assert.equal(path.basename(input),archive.transform.sourceSha256+'.original');
      assert.deepEqual(await readFile(input),original);
      await writeFile(pending,filtered,{flag:'wx'});
    },
  });
  assert.deepEqual(calls.map(c=>c[0]),['fetch','transform']);assert.equal(calls[0][1],archive.url);
  assert.equal(output,path.join(cache,archive.file));assert.deepEqual(await readFile(output),filtered);
  assert.deepEqual(await readFile(path.join(cache,archive.transform.sourceSha256+'.original')),original);
  assert.equal(await ensureSourceArchive(archive,cache,{fetcher:mustNotRun,transformer:mustNotRun}),output);
});

test('错误上游原包哈希、过大或过小流都在执行过滤器前阻断',async()=>{
  for(const transform of [{...archive.transform,sourceSha256:sha256('different upstream')},{...archive.transform,sourceBytes:original.length-1},{...archive.transform,sourceBytes:original.length+1}]){
    const cache=await fixture(),entry={...archive,transform};
    await assert.rejects(ensureSourceArchive(entry,cache,{fetcher:async()=>new Response(original),transformer:mustNotRun}),/Source (checksum mismatch|download exceeds expected size)/);
    await absent(path.join(cache,entry.file));
    await absent(path.join(cache,transform.sourceSha256+'.original'));
  }
});

test('过滤结果仍须匹配最终哈希与大小，失败后可复用已验证的原包重试',async()=>{
  const cache=await fixture();
  await assert.rejects(ensureSourceArchive(archive,cache,{fetcher:async()=>new Response(original),transformer:async(_root,_input,pending)=>writeFile(pending,'incorrect result',{flag:'wx'})}),/Source checksum mismatch/);
  await absent(path.join(cache,archive.file));
  const output=await ensureSourceArchive(archive,cache,{fetcher:mustNotRun,transformer:async(_root,_input,pending)=>writeFile(pending,filtered,{flag:'wx'})});
  assert.deepEqual(await readFile(output),filtered);
});

test('损坏的最终缓存或原包缓存不能被下载或过滤过程覆盖',async()=>{
  for(const name of [archive.file,archive.transform.sourceSha256+'.original']){
    const cache=await fixture(),file=path.join(cache,name);await writeFile(file,'existing damaged cache');
    await assert.rejects(ensureSourceArchive(archive,cache,{fetcher:mustNotRun,transformer:mustNotRun}),/Source cache mismatch/);
    assert.equal(await readFile(file,'utf8'),'existing damaged cache');
  }
});

test('普通归档仍直接校验 URL 字节，复用已校验缓存且限制下载大小',async()=>{
  const cache=await fixture(),{transform,...ordinary}=archive;
  const output=await ensureSourceArchive(ordinary,cache,{fetcher:async()=>new Response(filtered),transformer:mustNotRun});
  assert.deepEqual(await readFile(output),filtered);
  assert.equal(await ensureSourceArchive(ordinary,cache,{fetcher:mustNotRun}),output);
  const otherCache=await fixture();
  await assert.rejects(ensureSourceArchive(ordinary,otherCache,{fetcher:async()=>new Response(Buffer.concat([filtered,Buffer.from('too large')]))}),/exceeds expected size/);
  await absent(path.join(otherCache,ordinary.file));
});
