import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, access, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=process.argv[2]?path.resolve(process.argv[2]):JSON.parse(await readFile(path.join(root,'.local/last-release-candidate.json'),'utf8')).directory;
const candidate=JSON.parse(await readFile(path.join(directory,'candidate.json'),'utf8'));
for(const artifact of candidate.artifacts){
  assert.equal(path.basename(artifact.name),artifact.name);
  const file=path.join(directory,artifact.name);
  assert.equal((await stat(file)).size,artifact.size);
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),artifact.sha256);
}
const run=(executable,args)=>new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd:root,windowsHide:true,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Command exited ${code}`)));});
const zip=candidate.artifacts.find(a=>a.name.endsWith('-portable.zip'));assert.ok(zip);
const sevenZip=await getPath7za();
await run(sevenZip,['t',path.join(directory,zip.name)]);
await mkdir(path.join(root,'.local'),{recursive:true});
const extracted=await mkdtemp(path.join(root,'.local','portable-zip-check-'));
await run(sevenZip,['x',path.join(directory,zip.name),`-o${extracted}`,'-y']);
const portable=path.join(extracted,`Ediro-${candidate.version}-portable`);
assert.deepEqual(JSON.parse(await readFile(path.join(portable,'ediro-portable.json'),'utf8')),{version:1});
await assert.rejects(access(path.join(portable,'data')),error=>error.code==='ENOENT');
await run(process.execPath,[path.join(root,'scripts/run-release-smoke.mjs'),path.join(portable,'Ediro.exe')]);
console.log(`Verified both artifact hashes, ZIP integrity, clean portable data and extracted executable: ${extracted}`);
