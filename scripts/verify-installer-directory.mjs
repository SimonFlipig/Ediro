import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const base=path.join(root,'.local');await mkdir(base,{recursive:true});
const directory=await mkdtemp(path.join(base,'installer-directory-check-'));
async function findCompiler(folder){
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const full=path.join(folder,entry.name);
    if(entry.isFile()&&entry.name.toLowerCase()==='makensis.exe')return full;
    if(entry.isDirectory()){const result=await findCompiler(full);if(result)return result;}
  }
}
const compiler=await findCompiler(process.env.ELECTRON_BUILDER_CACHE||path.join(base,'electron-builder-cache'));
assert.ok(compiler,'Build a Windows candidate first to populate the NSIS cache.');
const file=path.join(directory,'existing-file.txt');await writeFile(file,'not a directory');
const tests=[{name:'existing-writable',target:directory,expected:'1'},{name:'new-writable',target:path.join(directory,'new','nested','Ediro'),expected:'1'},{name:'existing-file',target:file,expected:'0'},{name:'protected-system',target:path.join(process.env.SystemRoot??'C:\\Windows','System32'),expected:'0'}];
const quote=value=>value.replaceAll('$','$$').replaceAll('"','$\\"');
const output=path.join(directory,'guard-check.exe'),report=path.join(directory,'result.txt');
await writeFile(path.join(directory,'guard-check.nsi'),`Unicode true
Name "Ediro directory permission check"
OutFile "${quote(output)}"
RequestExecutionLevel user
SilentInstall silent
!include "${quote(path.join(root,'build/installer.nsh'))}"
Section
  FileOpen $9 "${quote(report)}" w
${tests.map(item=>`  StrCpy $INSTDIR "${quote(item.target)}"\n  Call EdiroCheckDirectoryAccess\n  FileWrite $9 "${item.name}=$EdiroDirectoryWritable$\\r$\\n"`).join('\n')}
  FileClose $9
SectionEnd
`);
const run=(file,args)=>new Promise((resolve,reject)=>{const child=spawn(file,args,{windowsHide:true,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Exit ${code}`)));});
await run(compiler,['/V2',path.join(directory,'guard-check.nsi')]);
await run(output,['/S']);
const result=await readFile(report,'utf8');console.log(result);
for(const item of tests)assert.ok(result.includes(`${item.name}=${item.expected}`),`Directory guard mismatch: ${item.name}`);
console.log(`Directory checks passed without installing Ediro: ${directory}`);
