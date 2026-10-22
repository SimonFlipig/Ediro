import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,readdir,lstat,open} from 'node:fs/promises';
import path from 'node:path';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
export const canonicalJson=value=>JSON.stringify(canonical(value));
export const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
export function safeRelative(name){
  if(typeof name!=='string'||!name||name.includes('\\')||name.includes(':')||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error(`Unsafe relative path: ${name}`);
  return name;
}
export async function hashFile(file){
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(file,{highWaterMark:8*1024*1024})){hash.update(chunk);bytes+=chunk.length;}
  return {bytes,sha256:hash.digest('hex')};
}
// GitHub limits individual assets to 2 GiB. Keep the original ZIP identity and
// split its bytes into conventional .zip.001 volumes without omitting sources.
export const sourceVolumeBytes=1_900_000_000;
export async function splitSourceArchive(file,partBytes=sourceVolumeBytes){
  if(!Number.isSafeInteger(partBytes)||partBytes<1)throw Error('Invalid source volume size');
  const parts=[];let handle,hash,size=0,name;
  const finish=async()=>{if(!handle)return;await handle.close();handle=undefined;parts.push({name,size,sha256:hash.digest('hex')});};
  try{
    for await(const chunk of createReadStream(file,{highWaterMark:8*1024*1024})){
      let offset=0;
      while(offset<chunk.length){
        if(!handle){name=path.basename(file)+'.'+String(parts.length+1).padStart(3,'0');handle=await open(path.join(path.dirname(file),name),'wx');hash=createHash('sha256');size=0;}
        const bytes=chunk.subarray(offset,offset+Math.min(partBytes-size,chunk.length-offset));
        await handle.writeFile(bytes);hash.update(bytes);size+=bytes.length;offset+=bytes.length;
        if(size===partBytes)await finish();
      }
    }
    await finish();return parts;
  }finally{if(handle)await handle.close();}
}
function validateVolumes(entry,bytesKey){
  if(!Array.isArray(entry.parts)||entry.parts.length<2)throw Error('A split source archive needs at least two volumes');
  let total=0;
  for(const [index,part] of entry.parts.entries()){
    if(part.name!==entry.name+'.'+String(index+1).padStart(3,'0')||!Number.isSafeInteger(part[bytesKey])||part[bytesKey]<=0||!/^[a-f0-9]{64}$/.test(part.sha256))throw Error('Invalid source volume metadata or order');
    total+=part[bytesKey];
  }
  if(total!==entry[bytesKey])throw Error('Source volume sizes do not match the complete archive');
}
function fixedPublicUrl(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||/\/latest(?:\/|$)/.test(url.pathname))throw Error('Source URL must be immutable, public HTTPS (not latest or expiring)');
}
export async function fileTree(directory){
  const result=[];
  async function walk(dir,prefix=''){
    for(const name of (await readdir(dir)).sort()){
      const file=path.join(dir,name),relative=prefix+name,info=await lstat(file);
      if(info.isSymbolicLink())throw Error(`Symlink not allowed in source materials: ${relative}`);
      if(info.isDirectory())await walk(file,relative+'/');
      else if(info.isFile())result.push({path:safeRelative(relative),...await hashFile(file)});
      else throw Error(`Unsupported source entry: ${relative}`);
    }
  }
  await walk(directory);return result;
}
export function validateArchives(manifest){
  if(manifest.schemaVersion!==1||manifest.platform!=='win32-x64'||!Array.isArray(manifest.archives)||!manifest.archives.length)throw Error('Unsupported source manifest');
  const names=new Set();
  for(const entry of manifest.archives){
    safeRelative(entry.file);
    const url=new URL(entry.url);
    if(entry.file.includes('/')||names.has(entry.file)||url.protocol!=='https:'||url.username||url.password||!entry.name||!entry.version||!entry.kind||!Number.isSafeInteger(entry.bytes)||entry.bytes<=0||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error(`Invalid source archive: ${entry.file}`);
    if(Object.hasOwn(entry,'transform')){
      const transform=entry.transform;
      if(!transform||typeof transform!=='object'||Array.isArray(transform)||transform.type!=='chromium-source-only-v1'||Object.keys(transform).sort().join(',')!=='sourceBytes,sourceSha256,type'||!Number.isSafeInteger(transform.sourceBytes)||transform.sourceBytes<=0||typeof transform.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(transform.sourceSha256))throw Error(`Invalid source archive transform: ${entry.file}`);
    }
    names.add(entry.file);
  }
}
// The application root version is intentionally absent. Every locked dependency,
// including build tools, remains part of the fingerprint (conservative invalidation).
export function dependencyInputs(lock){
  return Object.fromEntries(Object.entries(lock.packages).filter(([name])=>name).sort(([a],[b])=>a.localeCompare(b)));
}
export async function describeSourceSet(root){
  const manifest=await readJson(path.join(root,'third_party/sources.json'));validateArchives(manifest);
  const materials=await fileTree(path.join(root,'third_party'));
  const buildInputs=[];
  for(const name of ['electron-builder.cjs','scripts/package-windows.mjs','scripts/prepare-nsis-template.mjs','scripts/prepare-chromium-source.py','scripts/package-third-party-sources.mjs','scripts/source-set.mjs'])buildInputs.push({path:name,...await hashFile(path.join(root,name))});
  // Include custom NSIS templates and helpers, not just the include entrypoint.
  for(const file of await fileTree(path.join(root,'build')))buildInputs.push({...file,path:'build/'+file.path});
  const binaryInputs=[];
  for(const name of ['node_modules/electron/dist','node_modules/@img/sharp-win32-x64/lib','node_modules/onnxruntime-node/bin/napi-v6/win32/x64']){
    for(const file of await fileTree(path.join(root,name)))if(/\.(exe|dll|node|bin)$/i.test(file.path))binaryInputs.push({...file,path:`${name}/${file.path}`});
  }
  const descriptor={schemaVersion:1,platform:manifest.platform,dependencies:dependencyInputs(await readJson(path.join(root,'package-lock.json'))),materials,buildInputs,binaryInputs};
  const sourceSetId=sha256(canonicalJson(descriptor));
  return {sourceSetId,descriptor,manifest};
}
export function verifyReview(review,set){
  if(review.schemaVersion!==1||review.sourceSetId!==set.sourceSetId||review.status!=='approved'||!review.reviewedBy||!review.reviewedAt)throw Error('第三方源码基线尚未批准，或依赖集已变化；禁止发布。查看 config/source-review.json。');
  const required=['native-image-sources','native-relinking','electron-corresponding-source','javascript-sources-and-notices','installer-components'];
  const covered=new Set(set.manifest.archives.map(a=>a.file));
  for(const id of required){
    const item=review.checks?.find(c=>c.id===id);
    if(item?.status!=='passed'||!Array.isArray(item.evidence)||!item.evidence.length)throw Error(`Source review unresolved: ${id}`);
    for(const file of item.evidence)if(!set.descriptor.materials.some(m=>m.path===file)&&!covered.has(file))throw Error(`Review evidence not in source set: ${file}`);
  }
}
export function selectPublication(registry,set,artifact){
  const entry=registry.schemaVersion===1&&registry.entries?.find(e=>e.sourceSetId===set.sourceSetId);
  if(!entry)throw Error('当前源码集没有已登记的固定公开附件；禁止发布。');
  fixedPublicUrl(entry.url);
  if(entry.sha256!==artifact.sha256||entry.bytes!==artifact.size||entry.name!==artifact.name)throw Error('Published source identity differs from local source set');
  if(artifact.parts||entry.parts){
    validateVolumes(artifact,'size');validateVolumes(entry,'bytes');
    const actual=entry.parts.map(p=>({name:p.name,size:p.bytes,sha256:p.sha256}));
    if(canonicalJson(actual)!==canonicalJson(artifact.parts))throw Error('Published source volumes differ from the local archive');
    for(const part of entry.parts)fixedPublicUrl(part.url);
  }
  return entry;
}
export async function verifyRemoteArchive(entry,fetcher=fetch){
  if(entry.parts)validateVolumes(entry,'bytes');
  const combined=createHash('sha256');let total=0;
  for(const part of entry.parts??[entry]){
    const response=await fetcher(part.url,{signal:AbortSignal.timeout(60*60*1000)});
    if(!response.ok||!response.body)throw Error(`Source download unavailable: HTTP ${response.status}`);
    const hash=createHash('sha256');let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>part.bytes)throw Error('Remote source is larger than expected');hash.update(chunk);combined.update(chunk);}
    if(bytes!==part.bytes||hash.digest('hex')!==part.sha256)throw Error('Remote source checksum mismatch');
    total+=bytes;
  }
  if(total!==entry.bytes||combined.digest('hex')!==entry.sha256)throw Error('Complete remote source checksum mismatch');
}
export async function verifyPublication(entry,fetcher=fetch){
  if(entry.parts){
    validateVolumes(entry,'bytes');
    // Each immutable GitHub volume has its own server-side digest. The complete
    // concatenated digest is verified by a full anonymous download on registration.
    for(const part of entry.parts){fixedPublicUrl(part.url);await verifyPublication(part,fetcher);}
    return;
  }
  // GitHub stores a digest of the uploaded bytes. Verify the public API and the
  // anonymous download URL every release, without re-downloading 238 MB.
  if(entry.assetApiUrl){
    if(!/^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases\/assets\/\d+$/.test(entry.assetApiUrl))throw Error('Unsupported asset metadata endpoint');
    const response=await fetcher(entry.assetApiUrl,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`Public source metadata unavailable: ${response.status}`);
    const asset=await response.json();
    if(asset.state!=='uploaded'||asset.name!==entry.name||asset.size!==entry.bytes||asset.digest!==`sha256:${entry.sha256}`||asset.browser_download_url!==entry.url)throw Error('Public source metadata mismatch');
    const download=await fetcher(entry.url,{method:'HEAD',signal:AbortSignal.timeout(30000)});
    if(!download.ok)throw Error(`Anonymous source download unavailable: ${download.status}`);
    const length=download.headers.get('content-length');
    if(length!==null&&Number(length)!==entry.bytes)throw Error('Public source size mismatch');
  }else await verifyRemoteArchive(entry,fetcher);
}
export async function verifyLocalArtifact(directory,set){
  const artifact=await readJson(path.join(directory,'artifact.json'));
  if(artifact.sourceSetId!==set.sourceSetId||artifact.name!==`ediro-third-party-${set.sourceSetId}.zip`)throw Error('Local source-set metadata mismatch');
  const actual=await hashFile(path.join(directory,artifact.name));
  if(actual.bytes!==artifact.size||actual.sha256!==artifact.sha256)throw Error('Cached source archive is corrupt; do not silently overwrite');
  if(artifact.parts){
    validateVolumes(artifact,'size');const combined=createHash('sha256');
    for(const part of artifact.parts){
      const hash=createHash('sha256');let bytes=0;
      for await(const chunk of createReadStream(path.join(directory,part.name),{highWaterMark:8*1024*1024})){hash.update(chunk);combined.update(chunk);bytes+=chunk.length;}
      if(bytes!==part.size||hash.digest('hex')!==part.sha256)throw Error('Cached source volume is corrupt; do not silently overwrite');
    }
    if(combined.digest('hex')!==artifact.sha256)throw Error('Source volumes do not reconstruct the original ZIP');
  }
  const descriptor=await readJson(path.join(directory,'source-set.json'));
  if(canonicalJson(descriptor)!==canonicalJson(set.descriptor))throw Error('Cached source-set descriptor mismatch');
  return artifact;
}
// Inventory the actual packaged native payload, not all optional npm packages.
export async function nativePayload(directory){
  return (await fileTree(directory)).filter(file=>/\.(dll|node|wasm)$/i.test(file.path)&&!file.path.startsWith('resources/licenses/'));
}
export function verifyNativePayload(actual,set){
  const expected=set.descriptor.binaryInputs.filter(f=>/\.(dll|node)$/i.test(f.path)).map(f=>({...f,path:f.path.startsWith('node_modules/electron/dist/')?f.path.slice('node_modules/electron/dist/'.length):'resources/app.asar.unpacked/'+f.path})).sort((a,b)=>a.path.localeCompare(b.path));
  if(canonicalJson([...actual].sort((a,b)=>a.path.localeCompare(b.path)))!==canonicalJson(expected))throw Error('实际原生组件与源码集不一致；禁止复用。');
}
export async function verifyCandidateArtifacts(directory,candidate){
  for(const item of candidate.artifacts){
    if(safeRelative(item.name).includes('/'))throw Error('Artifact must be at candidate root');
    const actual=await hashFile(path.join(directory,item.name));
    if(actual.bytes!==item.size||actual.sha256!==item.sha256)throw Error(`Candidate artifact mismatch: ${item.name}`);
  }
}

const applicationRoots=['src','scripts','build','config','third_party'];
const applicationFiles=['package.json','package-lock.json','index.html','tsconfig.json','tsconfig.host.json','vite.config.ts','electron-builder.cjs','provider-capabilities.v1.json','LICENSE','THIRD_PARTY_NOTICES.md'];
// Git exports may normalize line endings; binary resources must match bytewise.
function sourceDigest(name,bytes){
  return sha256(/\.(?:tsx?|mjs|cjs|json|html|css|md|txt|nsh|svg)$/.test(name)||path.basename(name)==='LICENSE'?bytes.toString('utf8').replaceAll('\r\n','\n'):bytes);
}
function isApplicationSource(name){return applicationFiles.includes(name)||applicationRoots.some(root=>name.startsWith(root+'/'));}
export async function applicationInventory(root){
  const names=[...applicationFiles];
  for(const dir of applicationRoots)for(const file of await fileTree(path.join(root,dir)))names.push(dir+'/'+file.path);
  const result={};
  for(const name of names.sort())result[name]=sourceDigest(name,await readFile(path.join(root,name)));
  return result;
}
export async function verifyApplicationSource(zipFile,expected){
  if(!expected||!Object.keys(expected).length)throw Error('Candidate has no application source inventory');
  const {default:unzipper}=await import('unzipper');
  const archive=await unzipper.Open.file(zipFile);
  const files=archive.files.filter(f=>f.type!=='Directory');
  const prefix=files.some(f=>f.path==='package.json')?'':files.find(f=>/^[^/]+\/package\.json$/.test(f.path))?.path.replace(/package\.json$/,'');
  if(prefix===undefined)throw Error('Application source ZIP must contain one application root');
  const actual={},seen=new Set();
  for(const file of files){
    safeRelative(file.path);
    if(!file.path.startsWith(prefix))throw Error('Application ZIP contains multiple roots');
    const name=file.path.slice(prefix.length);safeRelative(name);
    if(seen.has(name.toLowerCase()))throw Error('Duplicate source ZIP path');seen.add(name.toLowerCase());
    if(isApplicationSource(name)){
      if(file.uncompressedSize>64*1024*1024)throw Error('Unexpected oversized application source file');
      actual[name]=sourceDigest(name,await file.buffer());
    }
  }
  if(canonicalJson(actual)!==canonicalJson(expected))throw Error('Application source ZIP differs from the packaged application source snapshot');
}
