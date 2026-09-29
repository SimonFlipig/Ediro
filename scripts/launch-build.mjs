import { spawn } from 'node:child_process';
import { mkdir,open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.join(root,'.local','launcher');await mkdir(directory,{recursive:true});
const log=await open(path.join(directory,'build.log'),'w');
try{
  await log.write(`Ediro 自动构建 ${new Date().toISOString()}\n\n`);
  if(!process.env.EDIRO_NPM_CLI)throw new Error('未指定 npm 构建工具。');
  // Use the selected Node for npm and its scripts; never fall back to an older
  // node.exe located beside the system npm.cmd. No shell interpolation.
  const child=spawn(process.execPath,[process.env.EDIRO_NPM_CLI,'run','build'],{cwd:root,windowsHide:true,env:{...process.env,PATH:`${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH??''}`},stdio:['ignore',log.fd,log.fd]});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  process.exitCode=code??1;
}catch(error){await log.write(`\n构建无法启动：${error.message}\n`);process.exitCode=1;}finally{await log.close();}
