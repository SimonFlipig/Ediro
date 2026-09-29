// Reproduce legacy declarations that omit mask support supplied by a preset.
const {app,BrowserWindow,ipcMain}=require('electron');
const {mkdtemp,mkdir,writeFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const base=await mkdtemp(path.join(root,'.local','editing-default-')),runtime=path.join(base,'.local/runtime');await mkdir(runtime,{recursive:true});app.setPath('userData',path.join(base,'electron'));
  const {ModelLibrary,seedModels}=await import('../dist-host/core/models.js');
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const data=new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}}).snapshot();
  for(const id of ['model_nano_pro','model_image_2']){const model=data.models.find(m=>m.model_config_id===id);model.capabilities.operations=['generate','referenceEdit'];}
  data.models.find(m=>m.model_config_id==='model_nano_pro').title='Kuai Nano Pro';
  await writeFile(path.join(runtime,'model-library.v3.json'),JSON.stringify(data));
  const win=new BrowserWindow({width:1540,height:1040,show:false,webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const controller=await DesktopController.create(runtime,()=>win);controller.executors.execute=async()=>{throw Error('Model calls are forbidden in this check');};
  ipcMain.handle('ediro:command',(_event,command)=>controller.execute(command));
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async(check)=>{for(let i=0;i<100;i++){if(await check())return;await wait(30);}throw Error('UI timeout');};
  const button=label=>`[...document.querySelectorAll('.settings-actions button')].find(b=>b.textContent===${JSON.stringify(label)})`;
  await win.loadFile(path.join(root,'dist/index.html'));await until(()=>js(`!!document.querySelector('.module-card')`));await js(`document.querySelector('.settings-button').click()`);
  for(const [id,title] of [['model_nano_pro','Kuai Nano Pro'],['model_image_2',data.models.find(m=>m.model_config_id==='model_image_2').title]]){
    await js(`(()=>{[...document.querySelectorAll('.settings-model-row')].find(b=>b.querySelector('b').textContent===${JSON.stringify(title)}).click();})()`);
    await until(()=>js(`!!${button('设为默认编辑模型')}`));assert.equal(await js(`${button('设为默认编辑模型')}.disabled`),false);
    const model=(await controller.view()).models.find(m=>m.model_config_id===id);assert.deepEqual(model.declared_capabilities.operations,['generate','referenceEdit']);assert.ok(model.capabilities.operations.some(op=>['guidedMaskEdit','nativeMaskEdit'].includes(op)));
    if(id==='model_nano_pro'){
      await js(`${button('设为默认编辑模型')}.scrollIntoView({block:'center'})`);await win.webContents.capturePage(undefined,{stayHidden:true});await wait(150);await writeFile(path.join(base,'默认编辑模型按钮.png'),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG());
    }
    await js(`${button('设为默认编辑模型')}.click()`);await until(()=>js(`!!${button('已设为默认编辑模型')}`));assert.equal(controller.workspace.models.snapshot().assignments.editing_default,id);
  }
  const selected=controller.workspace.models.snapshot().models.find(m=>m.model_config_id==='model_image_2');await controller.workspace.models.saveModel({...selected,capabilities:{...selected.capabilities,disabled_operations:['nativeMaskEdit']}});await controller.refreshState();
  await until(()=>js(`!${button('已设为默认编辑模型')}`));
  await controller.shutdown();win.destroy();const result={passed:true,base,checks:['legacy-nano-button-visible','legacy-images-button-visible','click-saves-default','explicit-opt-out-respected']};await writeFile(path.join(root,'.local/editing-default-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
