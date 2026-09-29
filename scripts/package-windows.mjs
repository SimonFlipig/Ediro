import { readFile, readdir, mkdir, cp, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { build, Platform, Arch } from 'electron-builder';
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js';
import configuration from '../electron-builder.cjs';
import { createReleaseIcon } from './release-icon.mjs';
import { listPackage, extractFile } from '@electron/asar';
import { load as loadYaml } from 'js-yaml';

const root=fileURLToPath(new URL('../',import.meta.url));
process.chdir(root);
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This first-release builder targets Windows x64.');
const pkg=JSON.parse(await readFile('package.json','utf8'));
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const output=path.join(root,'.local','release-candidates',`${pkg.version}-${stamp}`);
const licenses=path.join(output,'license-materials');
await mkdir(licenses,{recursive:true});
await createReleaseIcon(path.join(root,'build/icon.svg'),path.join(root,'.local/release-icon.ico'),path.join(root,'.local/release-icon.png'));
const inventory=[];
for(const [relative,metadata] of Object.entries(lock.packages)){
  if(!relative||(metadata.dev&&relative!=='node_modules/electron'))continue;
  const directory=path.join(root,relative);
  let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(metadata.optional&&error.code==='ENOENT')continue;throw error;}
  const name=relative.replace(/^node_modules\//,'');
  const destination=path.join(licenses,name.replaceAll('/','__'));
  await mkdir(destination,{recursive:true});
  const files=entries.filter(e=>e.isFile()&&/^(licen[cs]e|copying|notice|copyright)/i.test(e.name)).map(e=>e.name);
  if(name.startsWith('@img/sharp-'))files.push(...entries.filter(e=>e.isFile()&&/^(README\.md|versions\.json)$/.test(e.name)).map(e=>e.name));
  for(const file of files)await cp(path.join(directory,file),path.join(destination,file),{errorOnExist:true,force:false});
  inventory.push({name,version:metadata.version,license:metadata.license??'UNDECLARED',files});
}
await cp('LICENSE',path.join(licenses,'Ediro-GPL-3.0.txt'));
await cp('THIRD_PARTY_NOTICES.md',path.join(licenses,'THIRD_PARTY_NOTICES.md'));
await cp('third_party',path.join(licenses,'third_party'),{recursive:true,errorOnExist:true,force:false});
await cp('node_modules/electron/dist/LICENSE',path.join(licenses,'Electron-LICENSE.txt'));
await cp('node_modules/electron/dist/LICENSES.chromium.html',path.join(licenses,'LICENSES.chromium.html'));
await writeFile(path.join(licenses,'inventory.json'),JSON.stringify(inventory,null,2));
process.env.CSC_IDENTITY_AUTO_DISCOVERY='false';
await build({targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),publish:'never',config:{...configuration,directories:{...configuration.directories,output},extraResources:[{from:licenses,to:'licenses'}]}});
const appArchive=path.join(output,'win-unpacked/resources/app.asar');
const roots=new Set(['dist','dist-host','node_modules','package.json','LICENSE','THIRD_PARTY_NOTICES.md']);
const packagedFiles=listPackage(appArchive).map(file=>file.replace(/^[/\\]/,'').replaceAll('\\','/'));
for(const file of packagedFiles)if(!roots.has(file.split('/')[0]))throw new Error(`Unexpected archive content: ${file}`);
for(const file of ['dist-host/desktop/entry.js','dist-host/core/release-prompt-config.js']){
  if(!extractFile(appArchive,path.normalize(file)).equals(await readFile(path.join(root,file))))throw new Error(`Packaged output differs: ${file}`);
}
await stat(path.join(output,'win-unpacked/resources/licenses/inventory.json'));
await writeFile(path.join(output,'package-audit.json'),JSON.stringify({allowedRoots:[...roots],entries:packagedFiles.length,releasePromptsMatch:true,licenseInventory:true},null,2));
await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'scripts/run-release-smoke.mjs'),path.join(output,'win-unpacked/Ediro.exe')],{cwd:root,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Packaged smoke failed: ${code}`)));});
const portableRoot=path.join(output,`Ediro-${pkg.version}-portable`);
await cp(path.join(output,'win-unpacked'),portableRoot,{recursive:true,errorOnExist:true,force:false});
await writeFile(path.join(portableRoot,'ediro-portable.json'),JSON.stringify({version:1},null,2));
await writeFile(path.join(portableRoot,'使用说明.txt'),'Ediro 便携版\r\n\r\n请完整解压后运行 Ediro.exe。工程、导出和设置保存在旁边的 data 文件夹。\r\n升级前关闭程序；将旧版 data 文件夹保留并放到新版 Ediro.exe 旁。不要覆盖或删除自己的数据。\r\n迁移到另一台电脑时，可携带 .ediro 工程；API Key 受 Windows 用户加密保护，需要重新配置。\r\n真实模型需要自行配置连接和 API Key。许可材料在 resources\\licenses，源码获取说明在其 third_party 文件夹。\r\n');
const portableName=`Ediro-${pkg.version}-windows-x64-portable.zip`;
const sevenZip=await getPath7za();
await new Promise((resolve,reject)=>{const child=spawn(sevenZip,['a','-tzip','-mx=5',path.join(output,portableName),path.basename(portableRoot)],{cwd:output,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`ZIP creation exited ${code}`)));});
const setupName=`Ediro-${pkg.version}-windows-x64-setup.exe`;
const feed=loadYaml(await readFile(path.join(output,'latest.yml'),'utf8'));
const setupBytes=await readFile(path.join(output,setupName));
const updateFile=feed.files?.find(file=>file.url===setupName);
if(feed.version!==pkg.version||updateFile?.sha512!==createHash('sha512').update(setupBytes).digest('base64')||updateFile.size!==setupBytes.length)throw new Error('Update metadata does not match the installer.');
const updateConfig=loadYaml(await readFile(path.join(output,'win-unpacked/resources/app-update.yml'),'utf8'));
if(updateConfig.provider!=='github'||updateConfig.owner!=='SimonFlipig'||updateConfig.repo!=='Ediro'||updateConfig.private!==false||updateConfig.token)throw new Error('Unexpected update provider or credentials.');
const names=[setupName,`${setupName}.blockmap`,'latest.yml',portableName];
const artifacts=[];
for(const name of names){const file=path.join(output,name);artifacts.push({name,size:(await stat(file)).size,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});}
await writeFile(path.join(output,'SHA256SUMS.txt'),artifacts.map(a=>`${a.sha256}  ${a.name}`).join('\n')+'\n');
await writeFile(path.join(output,'candidate.json'),JSON.stringify({version:pkg.version,builtAt:stamp,status:'local-candidate-not-published',signed:false,platform:'win32',arch:'x64',artifacts},null,2));
await writeFile(path.join(root,'.local','last-release-candidate.json'),JSON.stringify({directory:output},null,2));
console.log(`\nCandidate packages: ${output}`);
