// Real renderer + IPC dialogs, with isolated documents and a mock executor only.
const {app,BrowserWindow,ipcMain,dialog,protocol,net,shell}=require('electron');
const {mkdtemp,mkdir,writeFile,stat}=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),artifacts=path.join(root,'.local');
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let testRoot;
app.whenReady().then(async()=>{
  await mkdir(artifacts,{recursive:true});testRoot=await mkdtemp(path.join(artifacts,'dialogs-desktop-'));app.setPath('userData',path.join(testRoot,'electron'));
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {AppDialogs}=await import('../dist-host/desktop/app-dialogs.js');
  const win=new BrowserWindow({width:1540,height:1040,show:false,webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const dialogs=new AppDialogs(ipcMain,win,()=>{});
  dialog.showMessageBox=async()=>{throw Error('Unexpected native message box');};
  const controller=await DesktopController.create(path.join(testRoot,'.local/runtime'),()=>win,{showMessage:dialogs.show,deferStartup:true});
  ipcMain.handle('ediro:command',(_event,command)=>controller.execute(command));
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async(check,label)=>{for(let i=0;i<200;i++){if(await check())return;await wait(50);}throw Error('Timeout: '+label);};
  const title=()=>js(`document.querySelector('.app-dialog h2')?.textContent??''`);
  const click=async label=>{await js(`(()=>{const button=[...document.querySelectorAll('.app-dialog button')].find(b=>b.textContent===${JSON.stringify(label)});if(!button)throw Error('Missing button');button.click();})()`);};
  const screenshot=async name=>{await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await wait(250);await writeFile(path.join(testRoot,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());};
  await win.loadFile(path.join(root,'dist/index.html'));await until(()=>js(`!!document.querySelector('.module-card')`),'renderer');
  // Startup notices can be queued before renderer readiness without native dialogs.
  const notice=dialogs.show({message:'恢复提示测试',detail:'原工程保持不变。'});await until(async()=>await title()==='恢复提示测试','startup notice');await click('知道了');await notice;
  const revealed=[];shell.showItemInFolder=filename=>revealed.push(filename);
  let destination=path.join(testRoot,'另存工程.ediro');dialog.showSaveDialog=async()=>({canceled:false,filePath:destination});
  await js(`(()=>{[...document.querySelectorAll('.top-actions button')].find(b=>b.textContent==='另存为…').click();})()`);
  await until(async()=>await title()==='保存成功','saved dialog');assert.deepEqual(revealed,[]);assert.ok(await stat(destination));
  assert.deepEqual(await js(`[...document.querySelectorAll('.app-dialog button')].map(b=>b.textContent)`),['打开目录','知道了']);
  assert.equal(await js(`document.activeElement.textContent`),'知道了');await screenshot('保存成功');
  await click('知道了');await until(async()=>await title()==='','dismiss save');assert.deepEqual(revealed,[]);
  destination=path.join(testRoot,'打开目录工程.ediro');
  const saved=controller.execute({type:'project:package'});await until(async()=>await title()==='保存成功','second save');await click('打开目录');assert.ok((await saved).ok);assert.deepEqual(revealed,[destination]);
  // Real failure transition; dismissal never issues a retry, and refresh never repeats it.
  const originalExecutor=controller.workspace.executor;let calls=0,fail=true;
  controller.workspace.executor={execute:async(...args)=>{calls++;if(fail)throw Error('模拟网络失败');return originalExecutor.execute(...args);}};
  const recipe=structuredClone(controller.workspace.project.recipe);recipe.modules.at(-1).user_instruction='对话框重试测试原提示';
  assert.ok((await controller.execute({type:'recipe:save',recipe})).ok);
  const start=await controller.execute({type:'job:start',allow_degradation:true});assert.ok(start.ok,start.error);
  await until(async()=>await title()==='生成失败','failure');assert.equal(calls,1);await screenshot('生成失败');
  await click('知道了');await controller.refreshState();await wait(200);assert.equal(await title(),'');assert.equal(calls,1);
  await controller.execute({type:'job:start',allow_degradation:true});await until(async()=>await title()==='生成失败','second failure');
  const originalJob=structuredClone(controller.workspace.project.jobs.at(-1));
  const edited=structuredClone(recipe);edited.modules.at(-1).user_instruction='后来修改的提示';await controller.execute({type:'recipe:save',recipe:edited});const acceptedRecipe=structuredClone(controller.workspace.project.recipe);
  fail=false;await click('重试');await until(()=>controller.workspace.project.jobs.at(-1).status==='succeeded','retry');await until(async()=>await title()==='','retry dismissed');
  assert.equal(calls,3);assert.deepEqual(controller.workspace.project.jobs.at(-1).recipe_snapshot,originalJob.recipe_snapshot);assert.deepEqual(controller.workspace.project.recipe,acceptedRecipe);
  // Save failure retry recovers the staged bytes without another generation call.
  const repo=controller.workspace.repository,saveOutput=repo.saveOutput.bind(repo);repo.saveOutput=async()=>{throw Error('模拟磁盘写入失败');};
  await controller.execute({type:'job:start',allow_degradation:true});await until(async()=>await title()==='结果保存失败','local result');assert.equal(calls,4);
  repo.saveOutput=saveOutput;await click('重试');await until(async()=>await title()==='','local recovered');assert.equal(calls,4);assert.equal(controller.workspace.project.jobs.at(-1).status,'succeeded');
  // A privileged confirmation resolves through a separate IPC channel, without deadlock.
  const file=controller.workspace.repository.filename,id=(await controller.view()).project_record_id;
  const removal=controller.execute({type:'workspace:remove',id});await until(async()=>(await title()).includes('回收站'),'remove dialog');await screenshot('删除确认');await click('取消');assert.equal((await removal).cancelled,true);assert.ok(await stat(file));
  // Invalid replies cannot resolve the host prompt.
  let resolved=false;const guarded=dialogs.show({message:'回复校验',buttons:['取消','确认'],cancelId:0});guarded.then(()=>{resolved=true;});await until(async()=>await title()==='回复校验','reply check');
  const pending=[...dialogs.pending.keys()][0];await js(`window.ediro.respondDialog(${JSON.stringify(pending)},99)`);await wait(80);assert.equal(resolved,false);await click('取消');await guarded;
  // Ordinary preflight errors use the same dialog and repeated failed retries stay in it.
  const empty=structuredClone(controller.workspace.project.recipe);empty.modules.forEach(m=>{m.enabled=true;m.user_instruction='';m.asset_ids=[];});await controller.execute({type:'recipe:save',recipe:empty});await controller.refreshState();
  await js(`document.querySelector('.generate-button').click()`);await until(async()=>await title()==='生成未能开始','preflight error');await click('重试');await until(()=>js(`!!document.querySelector('.app-dialog-error')`),'retry preflight error');await click('知道了');await wait(100);assert.equal(await title(),'');assert.equal(calls,4);
  await controller.shutdown();win.destroy();
  const report={passed:true,testRoot,checks:['custom-save-success','no-auto-explorer','explicit-open-directory','failure-once','dismiss-no-retry','frozen-input-retry','save-only-recovery','custom-delete-cancel','dialog-ipc-no-deadlock','invalid-reply-ignored','preflight-retry-single-dialog']};
  await writeFile(path.join(artifacts,'dialogs-desktop-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));app.exit(0);
}).catch(async error=>{console.error(error);await writeFile(path.join(artifacts,'dialogs-desktop-report.json'),JSON.stringify({passed:false,testRoot,error:error.stack},null,2));app.exit(1);});
