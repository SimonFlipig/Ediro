import {writeFile,mkdir,copyFile,cp,utimes,rename,rm,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getPath7za} from 'app-builder-lib/out/toolsets/7zip.js';
import {describeSourceSet,hashFile,verifyLocalArtifact,fileTree,canonicalJson,splitSourceArchive,sourceVolumeBytes,validateArchives} from './source-set.mjs';

const defaultRoot=fileURLToPath(new URL('../',import.meta.url));
const missingHash=async file=>{try{return await hashFile(file);}catch(error){if(error.code!=='ENOENT')throw error;return undefined;}};
function checkArchive(actual,expected,label){
  if(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)throw Error(`Source ${label} mismatch: ${expected.file}`);
}
async function cacheArchive(cache,entry,produce){
  const file=path.join(cache,entry.file),existing=await missingHash(file);
  if(existing){checkArchive(existing,entry,'cache');return file;}
  // All writers use this exclusive lock, including writers of shared originals.
  // Existing files are rechecked after locking and never replaced or repaired.
  const lockFile=file+'.lock',lock=await open(lockFile,'wx');
  try{
    const concurrent=await missingHash(file);
    if(concurrent){checkArchive(concurrent,entry,'cache');return file;}
    const pending=file+`.pending-${process.pid}-${randomUUID()}`;
    await produce(pending);
    checkArchive(await hashFile(pending),entry,'checksum');
    if(await missingHash(file))throw Error(`Source cache appeared while locked; refusing to overwrite: ${entry.file}`);
    await rename(pending,file);
    return file;
  }finally{
    await lock.close();await rm(lockFile);
  }
}
async function downloadArchive(url,pending,expected,fetcher){
  const response=await fetcher(url,{signal:AbortSignal.timeout(60*60*1000)});
  if(!response.ok||!response.body)throw Error(`Download failed: ${expected.file} (${response.status})`);
  let received=0;
  const limit=new Transform({transform(chunk,encoding,done){received+=chunk.length;done(received>expected.bytes?Error(`Source download exceeds expected size: ${expected.file}`):null,chunk);}});
  await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(pending,{flags:'wx'}));
}
function transformChromium(root,original,pending){
  return new Promise((resolve,reject)=>{
    const python=process.env.EDIRO_PYTHON_PATH||process.env.PYTHON||'python';
    const child=spawn(python,[path.join(root,'scripts/prepare-chromium-source.py'),original,pending],{cwd:root,stdio:'inherit',windowsHide:true});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Chromium source transformation exited ${code}`)));
  });
}
export async function ensureSourceArchive(entry,cache,{root=defaultRoot,fetcher=fetch,transformer=transformChromium}={}){
  validateArchives({schemaVersion:1,platform:'win32-x64',archives:[entry]});
  await mkdir(cache,{recursive:true});
  return cacheArchive(cache,entry,async pending=>{
    if(!entry.transform){await downloadArchive(entry.url,pending,entry,fetcher);return;}
    // The public URL describes these original bytes, not the derived TAR.
    const source={file:entry.transform.sourceSha256+'.original',bytes:entry.transform.sourceBytes,sha256:entry.transform.sourceSha256};
    const original=await cacheArchive(cache,source,file=>downloadArchive(entry.url,file,source,fetcher));
    await transformer(root,original,pending);
  });
}

if(process.argv[1]&&path.relative(fileURLToPath(import.meta.url),path.resolve(process.argv[1]))===''){
const root=defaultRoot;
const cache=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'.local/third-party-source-cache');
const set=await describeSourceSet(root),store=path.join(root,'.local/source-sets');
const output=path.join(store,set.sourceSetId);
await mkdir(store,{recursive:true});
async function remember(artifact,reused){
  const report={directory:output,sourceSetId:set.sourceSetId,status:'candidate-requires-source-review',reused,artifact};
  await writeFile(path.join(root,'.local/last-third-party-sources.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
try{
  const artifact=await verifyLocalArtifact(output,set);
  await remember(artifact,true);
}catch(error){
  if(error.code!=='ENOENT')throw error;
  // A lock prevents concurrent processes from replacing the same immutable set.
  const lock=await open(output+'.lock','wx');
  const stage=output+'.building';
  try{
    await mkdir(stage); // Existing unfinished work is preserved for diagnosis.
    const directory=path.join(stage,'third-party-sources');
    await mkdir(path.join(directory,'archives'),{recursive:true});
    await mkdir(cache,{recursive:true});
    await cp(path.join(root,'third_party'),path.join(directory,'materials'),{recursive:true,errorOnExist:true,force:false});
    let cursor=0;
    await Promise.all(Array.from({length:4},async()=>{
      while(cursor<set.manifest.archives.length){
        const entry=set.manifest.archives[cursor++],file=await ensureSourceArchive(entry,cache,{root});
        await copyFile(file,path.join(directory,'archives',entry.file));
      }
    }));
    // Detect material changes during copying; identity must describe the payload.
    if(canonicalJson(await fileTree(path.join(directory,'materials')))!==canonicalJson(set.descriptor.materials))throw Error('Source materials changed while packing');
    await writeFile(path.join(directory,'source-set.json'),canonicalJson(set.descriptor)+'\n');
    await writeFile(path.join(directory,'SHA256SUMS.txt'),set.manifest.archives.map(e=>`${e.sha256}  archives/${e.file}`).sort().join('\n')+'\n');
    const files=await fileTree(directory),epoch=new Date('2000-01-01T00:00:00Z');
    for(const file of files)await utimes(path.join(directory,file.path),epoch,epoch);
    // Files only: no changing directory timestamps. Stable root and sorted names.
    const list=files.map(f=>'third-party-sources/'+f.path).sort().join('\n')+'\n';
    await writeFile(path.join(stage,'zip-files.txt'),list);
    const name=`ediro-third-party-${set.sourceSetId}.zip`,sevenZip=await getPath7za();
    const run=args=>new Promise((resolve,reject)=>{const child=spawn(sevenZip,args,{cwd:stage,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Archive command exited ${code}`)));});
    await run(['a','-tzip','-mx=1','-mtc=off','-mta=off',name,'@zip-files.txt']);
    await run(['t',name]);
    const actual=await hashFile(path.join(stage,name));
    const artifact={sourceSetId:set.sourceSetId,name,size:actual.bytes,sha256:actual.sha256};
    if(actual.bytes>sourceVolumeBytes){
      artifact.parts=await splitSourceArchive(path.join(stage,name));
      await run(['t',artifact.parts[0].name]);
    }
    await writeFile(path.join(stage,'source-set.json'),canonicalJson(set.descriptor)+'\n');
    await writeFile(path.join(stage,'artifact.json'),JSON.stringify(artifact,null,2)+'\n');
    await rename(stage,output);
    await remember(artifact,false);
  }finally{
    await lock.close();await rm(output+'.lock');
  }
}
}
