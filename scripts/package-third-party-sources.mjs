import {readFile,writeFile,mkdir,mkdtemp,copyFile,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getPath7za} from 'app-builder-lib/out/toolsets/7zip.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const cache=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'.local/third-party-source-cache');
const manifest=JSON.parse(await readFile(path.join(root,'third_party/sources.json'),'utf8'));
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(cache,{recursive:true});
await mkdir(path.join(root,'.local'),{recursive:true});
const output=await mkdtemp(path.join(root,'.local/third-party-sources-'));
const directory=path.join(output,`Ediro-${version}-third-party-sources`);
await mkdir(path.join(directory,'archives'),{recursive:true});
await cp(path.join(root,'third_party'),path.join(directory,'materials'),{recursive:true,errorOnExist:true,force:false});
let cursor=0;
await Promise.all(Array.from({length:4},async()=>{
  while(cursor<manifest.archives.length){
    const entry=manifest.archives[cursor++];
    if(path.basename(entry.file)!==entry.file||!/^https:\/\//.test(entry.url)||! /^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid source manifest entry');
    const file=path.join(cache,entry.file);
    let bytes;
    try{bytes=await readFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!bytes){
      const response=await fetch(entry.url,{signal:AbortSignal.timeout(180000)});
      if(!response.ok)throw Error(`Download failed: ${entry.file} (${response.status})`);
      bytes=Buffer.from(await response.arrayBuffer());
      if(sha256(bytes)!==entry.sha256)throw Error(`Source checksum mismatch: ${entry.file}`);
      await writeFile(file,bytes,{flag:'wx'});
    }
    if(bytes.length!==entry.bytes||sha256(bytes)!==entry.sha256)throw Error(`Source cache mismatch: ${entry.file}`);
    await copyFile(file,path.join(directory,'archives',entry.file));
  }
}));
await writeFile(path.join(directory,'SHA256SUMS.txt'),manifest.archives.map(e=>`${e.sha256}  archives/${e.file}`).join('\n')+'\n');
const name=`Ediro-${version}-third-party-sources.zip`;
const sevenZip=await getPath7za();
const run=args=>new Promise((resolve,reject)=>{const child=spawn(sevenZip,args,{cwd:output,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Archive command exited ${code}`)));});
await run(['a','-tzip','-mx=1',path.join(output,name),path.basename(directory)]);
await run(['t',path.join(output,name)]);
const bytes=await readFile(path.join(output,name));
const artifact={name,size:bytes.length,sha256:sha256(bytes)};
await writeFile(path.join(output,'artifact.json'),JSON.stringify(artifact,null,2)+'\n');
await writeFile(path.join(root,'.local/last-third-party-sources.json'),JSON.stringify({directory:output,artifact},null,2)+'\n');
console.log(JSON.stringify({output,archives:manifest.archives.length,artifact},null,2));
