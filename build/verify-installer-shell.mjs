import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashFile} from '../scripts/source-set.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);
async function files(directory,prefix=''){
  const found=[];
  for(const item of await readdir(directory,{withFileTypes:true})){
    const name=prefix+item.name;
    if(item.isDirectory())found.push(...await files(path.join(directory,item.name),name+'/'));
    else if(item.isFile())found.push(name);
    else throw Error(`Unsupported installer extraction entry: ${name}`);
  }
  return found.sort();
}
// Requires the full official 7-Zip distribution (7z.exe + 7z.dll); 7za.exe
// lacks the NSIS archive handler. No installer or uninstaller is executed here.
export async function verifyInstallerShell(installer,{sevenZip=process.env.EDIRO_AUDIT_7ZIP_PATH??'7z',directory}={}){
  const evidence=directory??await mkdtemp(path.join(root,'.local/installer-shell-verification-'));
  if(directory)await mkdir(directory); // Refuse to mix old and new extraction results.
  const extract=async(file,target)=>{
    const result=await run(sevenZip,['x','-y','-o'+target,path.resolve(file)],{windowsHide:true,maxBuffer:8*1024*1024});
    await writeFile(target+'.log',result.stdout+result.stderr);
    const names=await files(target);
    assert.ok(names.some(name=>/(^|\/)System\.dll$/i.test(name)),'NSIS System plug-in was not extracted');
    assert.ok(!names.some(name=>/(^|\/)WinShell\.dll$/i.test(name)),'Forbidden WinShell.dll is embedded in the installer');
    const plugins=[];
    for(const name of names.filter(name=>/\.dll$/i.test(name)))plugins.push({path:name,...await hashFile(path.join(target,name))});
    return {names,plugins};
  };
  const setup=await extract(installer,path.join(evidence,'setup'));
  const uninstallers=setup.names.filter(name=>/(^|\/)Uninstall [^/]+\.exe$/i.test(name));
  assert.equal(uninstallers.length,1,'Expected exactly one complete embedded uninstaller');
  const uninstaller=path.join(evidence,'setup',uninstallers[0]);
  const removed=await extract(uninstaller,path.join(evidence,'uninstaller'));
  const report={schemaVersion:1,checkedAt:new Date().toISOString(),installer:{path:path.resolve(installer),...await hashFile(installer)},uninstaller:{path:uninstallers[0],...await hashFile(uninstaller)},setupPlugins:setup.plugins,uninstallerPlugins:removed.plugins,winShellAbsent:true,scope:'Static extraction of both installer stages; no installation, upgrade or uninstallation is executed.'};
  await writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
  return {...report,evidenceDirectory:evidence};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.ok(process.argv[2],'Usage: node build/verify-installer-shell.mjs <setup.exe>');
  console.log(JSON.stringify(await verifyInstallerShell(process.argv[2]),null,2));
}
