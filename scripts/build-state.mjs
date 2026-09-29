import { createHash } from 'node:crypto';
import { readFile,readdir,mkdir,writeFile,rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const sourceRoots=['src','scripts','public','index.html','package.json','package-lock.json','tsconfig.json','tsconfig.host.json','vite.config.ts'];
const requiredOutputs=['dist/index.html','dist-host/desktop/main.js','dist-host/desktop/entry.js','dist-host/desktop/preload.cjs'];
async function inventory(directory,roots){
  const files={};
  async function walk(relative){
    let entries;try{entries=await readdir(path.join(directory,relative),{withFileTypes:true});}catch(e){if(e.code==='ENOTDIR'){files[relative]=createHash('sha256').update(await readFile(path.join(directory,relative))).digest('hex');return;}if(e.code==='ENOENT')return;throw e;}
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name)))if(entry.isDirectory())await walk(`${relative}/${entry.name}`);else if(entry.isFile())files[`${relative}/${entry.name}`]=createHash('sha256').update(await readFile(path.join(directory,relative,entry.name))).digest('hex');
  }
  for(const relative of roots)await walk(relative);
  return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
}
export const sourceInventory=directory=>inventory(directory,sourceRoots);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const statePath=directory=>path.join(directory,'.local','launcher','build-state.json');
async function saveJson(filename,data){await mkdir(path.dirname(filename),{recursive:true});const temp=`${filename}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(data,null,2),'utf8');await rename(temp,filename);}
export async function recordBuild(directory,expectedSources){
  const sources=await sourceInventory(directory);
  if(expectedSources&&!equal(sources,expectedSources))throw new Error('构建期间源码发生变化，请重新启动以再次构建。');
  const outputs=await inventory(directory,['dist','dist-host']);
  if(requiredOutputs.some(file=>!outputs[file]))throw new Error('构建缺少桌面入口或预加载文件。');
  await saveJson(statePath(directory),{version:1,node:process.versions.node,sources,outputs});
}
export async function checkBuild(directory){
  let state;try{state=JSON.parse(await readFile(statePath(directory),'utf8'));}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return {needed:true,reason:'尚无有效构建记录，需要自动构建。'};throw e;}
  if(state.version!==1||state.node!==process.versions.node||!state.sources||!state.outputs)return {needed:true,reason:'构建记录或运行环境已变化。'};
  if(!equal(state.sources,await sourceInventory(directory)))return {needed:true,reason:'源码、语义模板或构建配置已变化。'};
  const outputs=await inventory(directory,['dist','dist-host']);
  if(requiredOutputs.some(file=>!outputs[file])||!equal(state.outputs,outputs))return {needed:true,reason:'构建产物缺失或已变化。'};
  return {needed:false,reason:'已是最新构建。'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const candidate=path.join(root,'.local','launcher','build-start.json');
    if(process.argv.includes('--begin'))await saveJson(candidate,await sourceInventory(root));
    else if(process.argv.includes('--record'))await recordBuild(root,JSON.parse(await readFile(candidate,'utf8')));
    else{const status=await checkBuild(root);console.log(status.reason);process.exitCode=status.needed?10:0;}
  }catch(error){console.error(error.message);process.exitCode=1;}
}
