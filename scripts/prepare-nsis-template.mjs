import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,mkdtemp,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultRoot=fileURLToPath(new URL('../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const expected={
  'include/installer.nsh':'0e319437dd01dcbf911f3f48f664fde0cefbaef704f1cdb1739f63d563f5d4a0',
  'uninstaller.nsh':'9ee2dac4593478083e8aa6f8487287ce9401006ccd50ecc538871d133ea4a42c',
  'installSection.nsh':'74c4dbb4163cdd90ca4850b75d304e916235c882d6af7b5cdad63bffbc977072',
  'installer.nsi':'8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8'
};
async function tree(directory,prefix=''){
  const files=[];
  for(const item of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const name=prefix+item.name,file=path.join(directory,item.name);
    if(item.isDirectory())files.push(...await tree(file,name+'/'));
    else if(item.isFile())files.push([name,await readFile(file)]);
    else throw Error(`Unsupported NSIS template entry: ${name}`);
  }
  return files;
}
// Keep electron-builder's normal two-pass installer/uninstaller generation.
// The generated mirror changes only the three unavailable WinShell entry points.
export async function prepareNsisTemplate(root=defaultRoot){
  const original=new Map(await tree(path.join(root,'node_modules/app-builder-lib/templates/nsis')));
  for(const [name,sha256] of Object.entries(expected))assert.equal(digest(original.get(name)),sha256,`NSIS template changed; review Shell integration before packaging: ${name}`);
  const files=new Map(original),replacements={SetLnkAUMI:'EdiroSetLnkAUMI',UninstShortcut:'EdiroUninstShortcut',UninstAppUserModelId:'EdiroUninstAppUserModelId'};
  const counts={SetLnkAUMI:0,UninstShortcut:0,UninstAppUserModelId:0};
  for(const name of ['include/installer.nsh','uninstaller.nsh']){
    const text=original.get(name).toString('utf8').replace(/WinShell::(SetLnkAUMI|UninstShortcut|UninstAppUserModelId)\b/g,(_match,method)=>{counts[method]++;return '!insertmacro '+replacements[method];});
    files.set(name,Buffer.from(text));
  }
  assert.deepEqual(counts,{SetLnkAUMI:5,UninstShortcut:4,UninstAppUserModelId:1});
  // NSIS resolves the compilation directory before its include search paths.
  // This root copy ensures installSection.nsh cannot select the original helper.
  files.set('installer.nsh',files.get('include/installer.nsh'));
  for(const [name,bytes] of files)assert.ok(!/WinShell::/.test(bytes.toString('utf8')),`Unreplaced WinShell call: ${name}`);
  const identity=digest(JSON.stringify([...files].map(([name,bytes])=>[name,digest(bytes)])));
  const base=path.join(root,'.local/nsis-templates'),directory=path.join(base,identity);
  const verify=async()=>{
    const actual=new Map(await tree(directory));assert.equal(actual.size,files.size,'Generated NSIS mirror has unexpected files');
    for(const [name,bytes] of files)assert.equal(digest(actual.get(name)),digest(bytes),`Generated NSIS template changed: ${name}`);
  };
  try{await verify();return directory;}catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(base,{recursive:true});const stage=await mkdtemp(path.join(base,'building-'));
  for(const [name,bytes] of files){const file=path.join(stage,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes,{flag:'wx'});}
  try{await rename(stage,directory);}catch(error){if(error.code!=='EEXIST'&&error.code!=='ENOTEMPTY')throw error;await verify();}
  await verify();return directory;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(await prepareNsisTemplate());
