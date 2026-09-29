import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Own a separate mock-only host. Never terminate the user's running host.
const child=spawn(process.execPath,['scripts/preview.mjs'],{env:{...process.env,EDIRO_PREVIEW_PORT:'5299'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
const exited=new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
const base='http://127.0.0.1:5299';
const connections=[];
try{
  let token;
  for(let attempt=0;attempt<60;attempt++){
    if(child.exitCode!==null)throw new Error(output);
    try{token=(await (await fetch(`${base}/preview-session`)).json()).token;break;}catch{await delay(100);}
  }
  assert.ok(token,'host starts');
  async function connect(){
    const abort=new AbortController();connections.push(abort);
    const response=await fetch(`${base}/preview-lifecycle?token=${token}`,{signal:abort.signal});
    assert.equal(response.status,200);
    const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/connected/);
    return abort;
  }
  const first=await connect();first.abort();
  await delay(300);
  const second=await connect();
  await delay(2800);assert.equal(child.exitCode,null,'refresh reconnect keeps host alive');
  second.abort();
  const code=await Promise.race([exited,delay(10000).then(()=>{throw new Error(`host did not exit: ${output}`);})]);
  assert.equal(code,0);assert.match(output,/后台进程退出/);
  console.log('PASS: 刷新重连保留后台；最后一个页面断开后后台完整退出。');
}finally{
  connections.forEach(connection=>connection.abort());
  if(child.exitCode===null)child.kill();
}
