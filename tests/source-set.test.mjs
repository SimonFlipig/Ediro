import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describeSourceSet,sha256,canonicalJson,validateArchives,verifyReview,selectPublication,verifyLocalArtifact,verifyPublication,verifyRemoteArchive,verifyNativePayload,verifyApplicationSource,verifyCandidateArtifacts,splitSourceArchive} from '../scripts/source-set.mjs';

const archive={name:'library',version:'1',kind:'native-source',file:'library.tar.gz',url:'https://example.org/library.tar.gz',bytes:3,sha256:sha256('abc')};
const manifest={schemaVersion:1,platform:'win32-x64',archives:[archive]};
const json=(file,value)=>writeFile(file,JSON.stringify(value));
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'ediro-source-test-'));
  for(const name of ['third_party','build','scripts','src','node_modules/electron/dist','node_modules/@img/sharp-win32-x64/lib','node_modules/onnxruntime-node/bin/napi-v6/win32/x64'])await mkdir(path.join(root,name),{recursive:true});
  for(const name of ['electron-builder.cjs','build/installer.nsh','scripts/package-windows.mjs','scripts/prepare-nsis-template.mjs','scripts/prepare-chromium-source.py','scripts/package-third-party-sources.mjs','scripts/source-set.mjs'])await writeFile(path.join(root,name),'build');
  await writeFile(path.join(root,'node_modules/electron/dist/ffmpeg.dll'),'native');
  await writeFile(path.join(root,'node_modules/@img/sharp-win32-x64/lib/sharp.node'),'sharp');
  await json(path.join(root,'third_party/sources.json'),manifest);
  const lock={version:'1.0.0',packages:{'':{version:'1.0.0'},'node_modules/library':{version:'1',integrity:'sha512-fixture'}}};
  await json(path.join(root,'package-lock.json'),lock);
  return {root,lock};
}
test('只改应用版本和业务代码复用；依赖、构建、源码材料及原生字节变化失效',async()=>{
  const {root,lock}=await fixture(),before=await describeSourceSet(root);
  lock.version=lock.packages[''].version='1.0.1';
  await json(path.join(root,'package-lock.json'),lock);
  await writeFile(path.join(root,'src/app.ts'),'changed UI');
  assert.equal((await describeSourceSet(root)).sourceSetId,before.sourceSetId);
  for(const name of ['electron-builder.cjs','scripts/package-windows.mjs','scripts/prepare-nsis-template.mjs','scripts/prepare-chromium-source.py','build/custom-shell.nsh','third_party/NOTICE','node_modules/electron/dist/ffmpeg.dll']){
    const previous=(await describeSourceSet(root)).sourceSetId;
    let original;try{original=await readFile(path.join(root,name));}catch{}
    await writeFile(path.join(root,name),'changed');
    assert.notEqual((await describeSourceSet(root)).sourceSetId,previous,name);
    // Each assertion starts from the preceding valid baseline; no cleanup of user paths.
    if(original)await writeFile(path.join(root,name),original);
  }
  const materialBaseline=(await describeSourceSet(root)).sourceSetId;
  lock.packages['node_modules/library'].version='2';await json(path.join(root,'package-lock.json'),lock);
  assert.notEqual((await describeSourceSet(root)).sourceSetId,materialBaseline);
});
test('归档清单拒绝路径穿越、重复文件、缺少校验和',()=>{
  validateArchives(manifest);
  for(const patch of [{file:'../bad'},{file:'a\\b'},{sha256:'bad'},{url:'http://example.org/a'}])assert.throws(()=>validateArchives({...manifest,archives:[{...archive,...patch}]}));
  assert.throws(()=>validateArchives({...manifest,archives:[archive,archive]}));
  assert.equal(canonicalJson({z:1,a:{y:2,x:3}}),canonicalJson({a:{x:3,y:2},z:1}));
});
test('未批准、跨源码集批准、证据缺失均禁止发布',async()=>{
  const set=await describeSourceSet((await fixture()).root);
  const review={schemaVersion:1,status:'approved',sourceSetId:set.sourceSetId,reviewedBy:'test-only',reviewedAt:'2026-09-30',checks:['native-image-sources','native-relinking','electron-corresponding-source','javascript-sources-and-notices','installer-components'].map(id=>({id,status:'passed',evidence:['sources.json']}))};
  verifyReview(review,set);
  for(const patch of [{status:'pending'},{sourceSetId:'older'},{checks:review.checks.slice(1)}])assert.throws(()=>verifyReview({...review,...patch},set));
  review.checks[0].evidence=['missing.md'];assert.throws(()=>verifyReview(review,set));
});
test('本地归档必须匹配内容和描述，损坏不能静默复用',async()=>{
  const {root}=await fixture(),set=await describeSourceSet(root);
  const artifact={sourceSetId:set.sourceSetId,name:`ediro-third-party-${set.sourceSetId}.zip`,size:3,sha256:sha256('abc')};
  await json(path.join(root,'artifact.json'),artifact);await json(path.join(root,'source-set.json'),set.descriptor);
  await writeFile(path.join(root,artifact.name),'abc');assert.deepEqual(await verifyLocalArtifact(root,set),artifact);
  await writeFile(path.join(root,artifact.name),'bad');await assert.rejects(verifyLocalArtifact(root,set),/corrupt/);
});
const publication={sourceSetId:'set',name:'set.zip',bytes:3,sha256:sha256('abc'),url:'https://github.com/example/sources/releases/download/set/set.zip',assetApiUrl:'https://api.github.com/repos/example/sources/releases/assets/1'};
test('固定公开引用必须匹配哈希；latest、授权参数和缺少集合均拒绝',()=>{
  const select=entry=>selectPublication({schemaVersion:1,entries:[entry]},{sourceSetId:'set'},{name:'set.zip',size:3,sha256:sha256('abc')});
  assert.equal(select(publication),publication);
  for(const patch of [{url:'https://example.org/latest/a.zip'},{url:'https://example.org/a.zip?token=secret'},{sha256:sha256('bad')},{sourceSetId:'other'}])assert.throws(()=>select({...publication,...patch}));
});
test('每版匿名检查远端哈希及下载可达性，失联或附件被替换会阻断',async()=>{
  const asset={state:'uploaded',name:'set.zip',size:3,digest:`sha256:${publication.sha256}`,browser_download_url:publication.url};
  const calls=[];
  const fetcher=async(url,options)=>{calls.push([url,options]);return options.method==='HEAD'?new Response(null,{headers:{'content-length':'3'}}):Response.json(asset);};
  await verifyPublication(publication,fetcher);assert.equal(calls.length,2);assert.equal(calls[1][1].method,'HEAD');
  await assert.rejects(verifyPublication(publication,async()=>Response.json({...asset,digest:'changed'})),/mismatch/);
  await assert.rejects(verifyPublication(publication,async(url,options)=>options.method==='HEAD'?new Response(null,{status:404}):Response.json(asset)),/unavailable/);
  await verifyRemoteArchive(publication,async()=>new Response('abc'));
  await assert.rejects(verifyRemoteArchive(publication,async()=>new Response('bad')),/checksum/);
});

test('大源码 ZIP 分卷逐字节还原原文件，旧分卷不可覆盖，任一卷损坏禁止复用',async()=>{
  const {root}=await fixture(),set=await describeSourceSet(root),name=`ediro-third-party-${set.sourceSetId}.zip`;
  const content=Buffer.from('123456789'),file=path.join(root,name);
  await writeFile(file,content);
  const parts=await splitSourceArchive(file,4);
  assert.deepEqual(parts.map(p=>[p.name,p.size]),[[name+'.001',4],[name+'.002',4],[name+'.003',1]]);
  assert.deepEqual(Buffer.concat(await Promise.all(parts.map(p=>readFile(path.join(root,p.name))))),content);
  await assert.rejects(splitSourceArchive(file,4),/EEXIST/);
  const artifact={sourceSetId:set.sourceSetId,name,size:content.length,sha256:sha256(content),parts};
  await json(path.join(root,'artifact.json'),artifact);await json(path.join(root,'source-set.json'),set.descriptor);
  assert.deepEqual(await verifyLocalArtifact(root,set),artifact);
  await writeFile(path.join(root,parts[1].name),'bad!');
  await assert.rejects(verifyLocalArtifact(root,set),/volume is corrupt/);
});

test('公开分卷需要全部精确对应，匿名下载核对每卷及拼接后的完整哈希',async()=>{
  const chunks=['abcd','efgh','i'],name='source.zip';
  const parts=chunks.map((text,i)=>({name:name+'.'+String(i+1).padStart(3,'0'),size:text.length,sha256:sha256(text)}));
  const artifact={name,size:9,sha256:sha256(chunks.join('')),parts};
  const entry={sourceSetId:'set',name,bytes:9,sha256:artifact.sha256,url:'https://github.com/example/sources/releases/tag/set',parts:parts.map((part,i)=>({name:part.name,bytes:part.size,sha256:part.sha256,url:`https://github.com/example/sources/releases/download/set/${part.name}`,assetApiUrl:`https://api.github.com/repos/example/sources/releases/assets/${i+1}`}))};
  const select=value=>selectPublication({schemaVersion:1,entries:[value]},{sourceSetId:'set'},artifact);
  assert.equal(select(entry),entry);
  for(const altered of [{...entry,parts:entry.parts.slice(1)},{...entry,parts:[...entry.parts].reverse()},{...entry,parts:entry.parts.map((p,i)=>i===1?{...p,url:p.url+'?token=x'}:p)}])assert.throws(()=>select(altered));
  const fetcher=async url=>new Response(chunks[entry.parts.findIndex(p=>p.url===url)]);
  await verifyRemoteArchive(entry,fetcher);
  await assert.rejects(verifyRemoteArchive({...entry,sha256:sha256('wrong')},fetcher),/Complete remote source checksum/);
  await assert.rejects(verifyRemoteArchive(entry,async()=>new Response('bad')),/checksum/);
  const calls=[];
  await verifyPublication(entry,async(url,options)=>{
    calls.push(url);const part=entry.parts.find(p=>p.url===url||p.assetApiUrl===url);
    return options.method==='HEAD'?new Response(null,{headers:{'content-length':String(part.bytes)}}):Response.json({state:'uploaded',name:part.name,size:part.bytes,digest:`sha256:${part.sha256}`,browser_download_url:part.url});
  });
  assert.equal(calls.length,6);
});
test('实际原生组件新增、缺失或字节改变，均不能沿用旧源码集',async()=>{
  const set=await describeSourceSet((await fixture()).root);
  const actual=[{path:'ffmpeg.dll',bytes:6,sha256:sha256('native')},{path:'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp.node',bytes:5,sha256:sha256('sharp')}];
  verifyNativePayload(actual,set);
  assert.throws(()=>verifyNativePayload(actual.slice(1),set));
  assert.throws(()=>verifyNativePayload([...actual,{path:'unknown.dll',bytes:1,sha256:sha256('x')}],set));
  assert.throws(()=>verifyNativePayload([{...actual[0],sha256:sha256('bad')},actual[1]],set));
});

// A minimal stored ZIP fixture (no executable archive tools required in tests).
function zip(entries){
  const chunks=[],directory=[];let offset=0;
  for(const [name,text] of entries){
    const nameBytes=Buffer.from(name),bytes=Buffer.from(text),local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(nameBytes.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);
    chunks.push(local,nameBytes,bytes);directory.push(central,nameBytes);offset+=local.length+nameBytes.length+bytes.length;
  }
  const table=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,table,end]);
}
test('应用源码必须对应候选包；支持 Git 换行转换，拒绝错版、缺失和重复路径',async()=>{
  const {root}=await fixture(),file=path.join(root,'source.zip'),expected={'package.json':sha256('{}\n'),'src/app.ts':sha256('code\n')};
  const entries=[['Ediro/package.json','{}\r\n'],['Ediro/src/app.ts','code\n']];
  await writeFile(file,zip(entries));await verifyApplicationSource(file,expected);
  for(const changed of [[entries[0]], [entries[0],['Ediro/src/app.ts','old code']], [...entries,entries[1]], [...entries,['../private','bad']]]){
    await writeFile(file,zip(changed));await assert.rejects(verifyApplicationSource(file,expected));
  }
});
test('发布前再次核对应用附件字节',async()=>{
  const {root}=await fixture();await writeFile(path.join(root,'app.exe'),'abc');
  const candidate={artifacts:[{name:'app.exe',size:3,sha256:sha256('abc')}]};
  await verifyCandidateArtifacts(root,candidate);await writeFile(path.join(root,'app.exe'),'bad');
  await assert.rejects(verifyCandidateArtifacts(root,candidate),/mismatch/);
});
