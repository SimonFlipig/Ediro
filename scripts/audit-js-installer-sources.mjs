import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {listPackage,extractFile,statFile} from '@electron/asar';
import {t as tarList} from 'tar';

const root=path.resolve(import.meta.dirname,'..');
const candidate=process.argv.slice(2).find(arg=>!arg.startsWith('--'))??path.join(root,'.local/release-candidates/0.1.3-2026-10-22T08-59-44-637Z');
const output=path.join(root,'.local/release-source-completion/js-installer');
await mkdir(output,{recursive:true});
const archive=path.join(candidate,'win-unpacked/resources/app.asar');
const paths=listPackage(archive).map(p=>p.replace(/^[/\\]/,'').replaceAll('\\','/'));
const records=[];
for(const file of paths.filter(p=>/^node_modules\/(?:@[^/]+\/)?[^/]+\/(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*package\.json$/.test(p))){
  const json=JSON.parse(extractFile(archive,path.normalize(file)).toString('utf8'));
  const packageRoot=file.slice(0,-'package.json'.length);
  const files=paths.filter(p=>p.startsWith(packageRoot)&&!p.slice(packageRoot.length).startsWith('node_modules/'));
  records.push({path:file,name:json.name,version:json.version,license:json.license,author:json.author,repository:json.repository,files:files.length,licenses:files.filter(p=>/\/(?:licen[cs]e|copying|notice|copyright|thirdpartynotices)[^/]*$/i.test(p)),sourceFiles:files.filter(p=>/\.(?:ts|tsx|c|cc|cpp|h|rs)$/.test(p)&&!p.endsWith('.d.ts')).length});
}

if(process.argv.includes('--verify')){
  const archives=JSON.parse(await readFile(path.join(output,'npm-archives.json'),'utf8'));
  const comparisons=[];
  for(const record of records){
    const packageRoot=record.path.slice(0,-'package.json'.length);
    const expected=new Map();
    for(const file of paths.filter(p=>p.startsWith(packageRoot)&&!p.slice(packageRoot.length).startsWith('node_modules/'))){
      const relative=file.slice(packageRoot.length);
      if(!relative||relative==='package.json'||statFile(archive,path.normalize(file)).files)continue;
      expected.set(`package/${relative}`,createHash('sha256').update(extractFile(archive,path.normalize(file))).digest('hex'));
    }
    const source=archives.find(a=>a.name===record.name&&a.version===record.version);
    const missing=new Set(expected.keys()),mismatched=[];
    await tarList({file:path.join(output,source.file),onReadEntry(entry){
      const wanted=expected.get(entry.path);if(!wanted){entry.resume();return;}
      const hash=createHash('sha256');entry.on('data',chunk=>hash.update(chunk));entry.on('end',()=>{missing.delete(entry.path);if(hash.digest('hex')!==wanted)mismatched.push(entry.path);});
    }});
    comparisons.push({name:record.name,version:record.version,filesCompared:expected.size,missing:[...missing],mismatched});
    console.log(`Compared ${record.name}@${record.version}: ${expected.size} files, ${missing.size} missing, ${mismatched.length} mismatched`);
  }
  const report={schemaVersion:1,candidate:path.basename(candidate),scope:'All packaged npm files other than package.json (builder prunes metadata); compares original npm tarball bytes to app.asar bytes.',packages:comparisons,pass:comparisons.every(c=>!c.missing.length&&!c.mismatched.length)};
  await writeFile(path.join(output,'javascript-byte-verification.json'),JSON.stringify(report,null,2)+'\n');
  if(!report.pass)process.exitCode=1;
}
records.sort((a,b)=>a.path.localeCompare(b.path));
await writeFile(path.join(output,'packaged-javascript-inventory.json'),JSON.stringify({candidate,packages:records},null,2)+'\n');
console.log(JSON.stringify(records.map(r=>({name:r.name,version:r.version,license:r.license,sourceFiles:r.sourceFiles,licenses:r.licenses.length})),null,2));

if(process.argv.includes('--download')){
  const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
  const unique=[...new Map(records.map(r=>[`${r.name}@${r.version}`,r])).values()];
  const archives=[],metadata=[];
  let cursor=0;
  await Promise.all(Array.from({length:4},async()=>{
    while(cursor<unique.length){
      const item=unique[cursor++];
      const metaResponse=await fetch(`https://registry.npmjs.org/${encodeURIComponent(item.name)}/${encodeURIComponent(item.version)}`,{signal:AbortSignal.timeout(120000)});
      if(!metaResponse.ok)throw Error(`npm metadata ${item.name}: ${metaResponse.status}`);
      const meta=await metaResponse.json();
      metadata.push({name:meta.name,version:meta.version,gitHead:meta.gitHead,repository:meta.repository,license:meta.license,author:meta.author,dist:meta.dist});
      const file=`npm-${item.name.replaceAll('@','').replaceAll('/','-')}-${item.version}.tgz`,destination=path.join(output,file);
      let bytes;try{bytes=await readFile(destination);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(!bytes){const response=await fetch(meta.dist.tarball,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error(`npm archive ${item.name}: ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());await writeFile(destination,bytes,{flag:'wx'});}
      const local=lock.packages[item.path.slice(0,-'/package.json'.length)];
      const locked=local?.version===item.version?local:Object.values(lock.packages).find(p=>p.version===item.version&&p.resolved===meta.dist.tarball);
      const integrity=locked?.integrity??meta.dist.integrity;
      const [algorithm,digest]=integrity.split('-');
      if(createHash(algorithm).update(bytes).digest('base64')!==digest)throw Error(`Integrity failed: ${item.name}`);
      archives.push({name:item.name,version:item.version,file,url:meta.dist.tarball,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,kind:'javascript-package-source'});
      console.log(`Verified ${item.name}@${item.version}`);
    }
  }));
  archives.sort((a,b)=>a.file.localeCompare(b.file));metadata.sort((a,b)=>a.name.localeCompare(b.name));
  await writeFile(path.join(output,'npm-archives.json'),JSON.stringify(archives,null,2)+'\n');
  await writeFile(path.join(output,'npm-metadata.json'),JSON.stringify(metadata,null,2)+'\n');
}
