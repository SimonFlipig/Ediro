import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const executable=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'node_modules/electron/dist/electron.exe');
const reportRoot=path.join(root,'.local',`packaged-smoke-${Date.now()}`);
await mkdir(reportRoot,{recursive:true});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.EDIRO_DEV_URL;
const args=[...(process.argv[2]?[]:[root]),`--ediro-release-smoke=${reportRoot}`];
const code=await new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{env,cwd:root,windowsHide:true,stdio:'inherit'});
  const timer=setTimeout(()=>{child.kill();reject(new Error(`Smoke timeout. Inspect ${reportRoot}`));},120000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('exit',code=>{clearTimeout(timer);resolve(code);});
});
console.log(`Reports: ${reportRoot}`);
for(const name of await readdir(reportRoot)){
  const file=path.join(reportRoot,name,code===0?'report.json':'error.txt');
  try{console.log(await readFile(file,'utf8'));}catch{}
}
if(code!==0)throw new Error(`Smoke failed with exit code ${code}`);
