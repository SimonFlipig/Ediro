// Offline integrity and source-coverage report. It does not change approval.
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,readdir,rename,copyFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const cache=path.join(root,'.local/release-source-completion/electron');
const evidence=path.join(root,'third_party/build-evidence');
const version='152.0.7977.78',fullName=`chromium-${version}.tar.xz`;
async function hashes(filename){const sha=createHash('sha256'),md5=createHash('md5');let bytes=0;for await(const chunk of createReadStream(filename)){sha.update(chunk);md5.update(chunk);bytes+=chunk.length;}return{bytes,sha256:sha.digest('hex'),md5:md5.digest('hex')};}
const electronZip=path.join(root,'.local/electron-cache/ac7f9bbe5344a6f3ccf5cdc4671361a3baaec6426c7c2896b00280b871d31359/electron-v44.4.1-win32-x64.zip');
const electronOfficial=await readFile(path.join(cache,'ELECTRON_SHASUMS256.txt'),'utf8');
const electronHash=await hashes(electronZip);assert.ok(electronOfficial.includes(electronHash.sha256+' *electron-v44.4.1-win32-x64.zip'));
const {default:unzipper}=await import('unzipper');
const electronArchive=await unzipper.Open.file(electronZip),runtime=[];
for(const name of await readdir(path.join(root,'node_modules/electron/dist'))){
 if(!/\.(?:exe|dll|bin|pak|dat)$/.test(name)&&!['LICENSE','LICENSES.chromium.html','version'].includes(name))continue;
 const entry=electronArchive.files.find(f=>f.path===name);assert.ok(entry,name);
 const actual=await hashes(path.join(root,'node_modules/electron/dist',name));
 const sha=createHash('sha256');let bytes=0;for await(const chunk of entry.stream()){sha.update(chunk);bytes+=chunk.length;}
 assert.equal(sha.digest('hex'),actual.sha256,name);assert.equal(bytes,actual.bytes,name);runtime.push({name,bytes,sha256:actual.sha256});
}
await writeFile(path.join(evidence,'electron-runtime-origin.json'),JSON.stringify({version:'44.4.1',platform:'win32-x64',officialUrl:'https://github.com/electron/electron/releases/download/v44.4.1/electron-v44.4.1-win32-x64.zip',sha256:electronHash.sha256,bytes:electronHash.bytes,officialSha256Matched:true,runtimeFilesMatchArchive:true,items:runtime},null,2)+'\n');
await copyFile(path.join(cache,'ELECTRON_SHASUMS256.txt'),path.join(evidence,'electron-upstream/ELECTRON_SHASUMS256.txt'));
const fullFile=path.join(cache,fullName);
let full;
try{full=await hashes(fullFile);}catch(error){if(error.code!=='ENOENT')throw error;full=await hashes(fullFile+'.part');assert.equal(full.bytes,5916191748);assert.equal(full.md5,'05ca2357a502e917ea82b9db18b65f36');await rename(fullFile+'.part',fullFile);}
assert.equal(full.bytes,5916191748);assert.equal(full.md5,'05ca2357a502e917ea82b9db18b65f36');
const fullEntry={name:'chromium-complete-source',version,file:fullName,url:`https://commondatastorage.googleapis.com/chromium-browser-official/${fullName}`,kind:'electron-component-source',bytes:full.bytes,sha256:full.sha256,destination:'src',officialMd5:full.md5};
await writeFile(fullFile+'.json',JSON.stringify(fullEntry,null,2)+'\n');
const expectedAnchors=[
 'DEPS','BUILD.gn','.gn','LICENSE','third_party/blink/renderer/core/dom/document.cc',
 'v8/include/v8.h','third_party/skia/src/core/SkCanvas.cpp','third_party/angle/src/libANGLE/Context.cpp',
 'third_party/webrtc/api/peer_connection_interface.h','third_party/boringssl/src/include/openssl/ssl.h',
 'third_party/dawn/src/dawn/native/Instance.cpp','third_party/ffmpeg/libavcodec/avcodec.h',
 'third_party/icu/source/common/unicode/utypes.h','third_party/swiftshader/src/Vulkan/VkDevice.cpp',
 'third_party/eigen3/src/Eigen/Core','third_party/hunspell/src/hunspell/hunspell.cxx',
 'base/third_party/nspr/prtime.cc','net/third_party/mozilla_security_manager/nsNSSCertificateDB.cpp',
 'net/third_party/mozilla_win/cert/win_util.cc','third_party/isimpledom/ISimpleDOMNode.idl',
];
const anchors=Object.fromEntries(expectedAnchors.map(p=>[p,false]));
let gitmodules='';try{gitmodules=await readFile(path.join(evidence,'electron-upstream/.gitmodules'),'utf8');}catch{}
const modulePaths=[...gitmodules.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map(m=>m[1].trim());
const modules=Object.fromEntries(modulePaths.map(p=>[p,{files:0,sourceFiles:0}]));
const sourceExtension=/\.(?:c|cc|cpp|cxx|h|hpp|rs|py|gn|gni|js|ts|idl|fbs|proto|asm|S|inc)$/;
let entries=0,rootPrefix,tarSummary;
const memberIndex=path.join(cache,full.sha256+'.members.jsonl');
let hasIndex=false;try{hasIndex=(await stat(memberIndex)).size>0;}catch{}
if(!hasIndex)await new Promise((resolve,reject)=>{
 const child=spawn(process.env.PYTHON||'python',['scripts/audit-electron-tar.py',fullFile,memberIndex],{cwd:root,windowsHide:true,stdio:'inherit'});
 child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Python TAR/XZ verification exited ${code}`)));
});
for await(const line of createInterface({input:createReadStream(memberIndex),crlfDelay:Infinity})){
 const item=JSON.parse(line);if(item.complete){tarSummary=item;continue;}
 const name=item.name.replace(/^\.\//,'');assert.ok(name,'Empty archive member');entries++;
 assert.ok(!name.startsWith('/')&&!name.split('/').includes('..'));
 rootPrefix??=name.split('/')[0];assert.ok(name===rootPrefix||name.startsWith(rootPrefix+'/'));
 const relative=name.slice(rootPrefix.length+1);if(relative in anchors)anchors[relative]=true;
 if(name.endsWith('/'))continue;
 const segments=relative.split('/');for(let n=1;n<segments.length;n++){const p=segments.slice(0,n).join('/');if(modules[p]){modules[p].files++;if(sourceExtension.test(relative))modules[p].sourceFiles++;}}
}
assert.equal(tarSummary?.complete,true);assert.equal(tarSummary.members,entries);assert.deepEqual(tarSummary.emptyNames,[]);
const nodeEntry=JSON.parse(await readFile(path.join(cache,'node-v24.21.0.tar.xz.json'),'utf8'));
const nodeOfficial=await readFile(path.join(cache,'SHASUMS256.txt'),'utf8');
assert.ok(nodeOfficial.includes(nodeEntry.sha256+'  '+nodeEntry.file));
const nodeActual=await hashes(path.join(cache,nodeEntry.file));assert.equal(nodeActual.sha256,nodeEntry.sha256);assert.equal(nodeActual.bytes,nodeEntry.bytes);
const manifest=[];
for(const filename of (await readdir(cache)).filter(n=>/\.tar\.(?:gz|xz)\.json$/.test(n)).sort()){
 const entry=JSON.parse(await readFile(path.join(cache,filename),'utf8'));
 const actual=entry.file===fullName?full:await hashes(path.join(cache,entry.file));assert.equal(actual.sha256,entry.sha256);assert.equal(actual.bytes,entry.bytes);
 manifest.push(entry);
}
const report={schemaVersion:1,checkedAt:new Date().toISOString(),electronVersion:'44.4.1',chromiumVersion:version,nodeVersion:'24.21.0',fullArchive:{...full,officialMd5Matched:true,tarIntegrity:true,tarReader:'Python tarfile + lzma, including XZ trailer; Windows bsdtar could not decode a member name',entries,rootPrefix},anchors,gitDependencyPaths:modules,missingGitDependencyPaths:Object.keys(modules).filter(p=>modules[p].files===0),nodeOfficialSha256Matched:true,archives:manifest.length,downloadedBytes:manifest.reduce((n,e)=>n+e.bytes,0),fullNativeRebuildPerformed:false};
const missingPathReview=report.missingGitDependencyPaths.map(p=>{
 const block=gitmodules.split('[submodule ').find(b=>b.split(/\r?\n/).some(l=>l.trim()==='path = '+p));
 const condition=block?.match(/gclient-condition\s*=\s*([^\r\n]+)/)?.[1]||null;
 const url=block?.match(/url\s*=\s*([^\r\n]+)/)?.[1]||null;
 const supplement=manifest.find(e=>e.destination==='src/'+p);
 if(supplement)return{path:p,condition,url,status:'supplement-archived',archive:supplement.file};
 if(url?.includes('chrome-internal.googlesource.com'))return{path:p,condition,url,status:'excluded-private-chrome',reason:'Google Chrome internal/branding/test component, not part of the unbranded public Electron target.'};
 if(p==='third_party/openxr/src')return{path:p,condition,url,status:'excluded-disabled-feature',reason:'Electron v44.4.1 DEPS explicitly sets checkout_openxr=False.'};
 if(p==='third_party/perl')return{path:p,condition,url,status:'external-build-interpreter',reason:'General-purpose Perl build interpreter, not code linked into or distributed with Electron Windows. Install a compatible host Perl when building; this missing prebuilt tool repository is not claimed to be source material.'};
 if(condition&&/checkout_(android|ios|chromeos|linux)/.test(condition)&&!condition.includes('checkout_win'))return{path:p,condition,url,status:'excluded-other-platform',reason:'DEPS platform condition is not selected for the Windows x64 Electron target.'};
 if(/^(chrome\/test\/|testing\/libfuzzer\/)/.test(p))return{path:p,condition,url,status:'excluded-test-data',reason:'Browser benchmark/fuzzer test fixtures, not target runtime source or build input for the Electron distribution.'};
 throw Error('Unreviewed missing dependency path: '+p);
});
report.missingPathReview=missingPathReview;
report.unresolvedWindowsGitDependencyPaths=missingPathReview.filter(x=>!x.status).map(x=>x.path);
assert.ok(Object.values(anchors).every(Boolean),'Required source anchor missing');
await writeFile(path.join(evidence,'electron-source-coverage.json'),JSON.stringify(report,null,2)+'\n');
// The full upstream bundle contains unrelated precompiled Linux/toolchain payload.
// It is the local audit input; the release coordinator publishes a separately
// identified source-only derivative. Do not silently publish the original here.
await writeFile(path.join(cache,'manifest-new.json'),JSON.stringify(manifest.filter(e=>e.name!=='chromium-complete-source'),null,2)+'\n');
await copyFile(path.join(cache,'SHASUMS256.txt'),path.join(evidence,'electron-upstream/node-v24.21.0-SHASUMS256.txt'));
console.log(JSON.stringify(report,null,2));
