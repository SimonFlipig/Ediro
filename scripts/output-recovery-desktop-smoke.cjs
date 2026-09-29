// Hidden, isolated Electron acceptance check. No cloud calls or user projects.
const {app,BrowserWindow,ipcMain,dialog,protocol,net}=require('electron');
const {mkdir,mkdtemp,readFile,writeFile,rename}=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let controller,win,testRoot;
app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});testRoot=await mkdtemp(path.join(root,'.local','output-recovery-desktop-'));
  app.setPath('userData',path.join(testRoot,'electron'));
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  win=new BrowserWindow({width:1540,height:1040,show:false,webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  let choice=2;
  controller=await DesktopController.create(path.join(testRoot,'runtime'),()=>win,{deferStartup:true,projectRoot:testRoot,showMessage:async options=>({response:options.message.includes('多个来源')?1:choice})});
  ipcMain.handle('ediro:command',(_e,c)=>controller.execute(c));
  ipcMain.handle('ediro:update',()=>({phase:'idle',current_version:'0.1.0'}));
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  const command=async c=>{const result=await controller.execute(c);assert.ok(result.ok,result.error);return result;};
  const w=controller.workspace,model=w.models.snapshot().models.find(m=>m.kind==='mock');
  await w.models.saveModel({...model,model_config_id:'model_history',model:'mock-history'});
  await command({type:'recipe:select-model',model_config_id:'model_history'});
  const first=structuredClone(w.project.recipe);first.modules.at(-1).user_instruction='第一版参数';first.core_parameters.aspect_ratio='16:9';await command({type:'recipe:save',recipe:first});
  const generate=async()=>{await command({type:'job:start',allow_degradation:true});for(let i=0;i<1200;i++){if(w.project.jobs.every(j=>['succeeded','failed','cancelled'].includes(j.status)))break;await wait(50);}assert.equal(w.project.jobs.at(-1).status,'succeeded');};
  await generate();const assetId=w.project.jobs[0].output_asset_ids[0];
  await command({type:'recipe:select-model',model_config_id:model.model_config_id});
  const second=structuredClone(w.project.recipe);second.modules.at(-1).user_instruction='第二版参数';await command({type:'recipe:save',recipe:second});await generate();
  await command({type:'model:delete',model_config_id:'model_history'});
  await win.loadFile(path.join(root,'dist','index.html'));
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("document.querySelectorAll('.result-thumb').length===2"))break;await wait(50);}
  await win.webContents.executeJavaScript("document.querySelectorAll('.result-thumb')[0].click()");
  for(let i=0;i<100;i++){if(w.project.recipe.model_config_id==='model_history')break;await wait(50);}
  assert.equal(w.project.recipe.model_config_id,'model_history');assert.equal(w.project.recipe.core_parameters.aspect_ratio,'16:9');
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("document.querySelectorAll('.result-thumb')[0].classList.contains('selected')"))break;await wait(50);}
  assert.ok(await win.webContents.executeJavaScript("document.querySelectorAll('.result-thumb')[0].classList.contains('selected')"));
  assert.ok(await win.webContents.executeJavaScript("document.querySelector('#generation-model').selectedOptions[0].textContent.includes('历史参数已保留')"));
  await command({type:'project:save'});
  const source=w.repository.filename,sourceBytes=await readFile(source),history=structuredClone(w.project.jobs);
  const exportRoot=path.join(testRoot,'exports');await mkdir(exportRoot);let exported;
  dialog.showSaveDialog=async(_window,options)=>{assert.match(path.basename(options.defaultPath),/^Ediro_\d{8}_\d{6}_[a-zA-Z0-9]+\.png$/);exported=path.join(exportRoot,path.basename(options.defaultPath));return {canceled:false,filePath:exported};};
  await command({type:'asset:export',asset_id:assetId});
  const moved=path.join(exportRoot,'改名.png');await rename(exported,moved);
  await command({type:'project:create',name:'空白工作'});
  const restored=await command({type:'assets:drop',paths:[moved]});
  assert.equal(restored.selected_asset_id,assetId);assert.equal(restored.state.project_format,'ediro');assert.notEqual(restored.state.project_location,source);
  assert.equal(w.project.recipe.modules.at(-1).user_instruction,'第一版参数');assert.equal(w.project.recipe.core_parameters.aspect_ratio,'16:9');assert.deepEqual(w.project.jobs,history);assert.deepEqual(await readFile(source),sourceBytes);
  // The explicit recovery button follows the same path and selects this version.
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[moved]});const reopened=await command({type:'output:open'});assert.equal(reopened.selected_asset_id,assetId);
  choice=1;const before=w.project.project_id;await command({type:'assets:drop',paths:[moved]});assert.equal(w.project.project_id,before);assert.ok(w.project.assets.some(a=>a.kind==='import'));
  choice=2;const moduleId=w.project.recipe.modules[0].module_id;await command({type:'assets:drop',paths:[moved],module_id:moduleId});assert.equal(w.project.project_id,before);assert.ok(w.project.recipe.modules[0].asset_ids.length);
  await writeFile(path.join(testRoot,'report.json'),JSON.stringify({ok:true,missingModelSelection:true,naming:true,renamedExportRecovery:true,explicitRecovery:true,materialImport:true,moduleDrop:true,historyUnchanged:true,sourceUnchanged:true,cloudCalls:0},null,2));
  console.log('OUTPUT_RECOVERY_DESKTOP_OK '+testRoot);
  await controller.shutdown();win.destroy();app.exit(0);
}).catch(async error=>{console.error(error);try{await controller?.shutdown();}catch{}win?.destroy();app.exit(1);});
