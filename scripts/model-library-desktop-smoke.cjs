// Exercise the real renderer and model-library IPC using an isolated library.
// Discovery is stubbed; paid generation and real provider requests are forbidden.
const {app,BrowserWindow,ipcMain}=require('electron');
const {mkdtemp,writeFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const base=await mkdtemp(path.join(root,'.local','model-library-ui-'));app.setPath('userData',path.join(base,'electron'));
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const win=new BrowserWindow({width:1540,height:1040,show:false,webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  const controller=await DesktopController.create(path.join(base,'.local/runtime'),()=>win);
  controller.executors.execute=async()=>{throw Error('Paid model execution forbidden');};
  let probes=0,failRemote='studio-second';const attempts=[];
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  ipcMain.handle('ediro:command',async(_event,command)=>{
    if(command.type==='connection:probe'){probes++;return {ok:true,state:await controller.view(),discovered_models:['gemini-3-pro-image-preview','studio-second']};}
    if(command.type==='model:save'){attempts.push(command.model.model);if(command.model.model===failRemote)return {ok:false,error:'模拟第二项保存失败'};}
    return controller.execute(command);
  });
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async(check,label)=>{for(let i=0;i<180;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const click=async(label,scope='.global-settings')=>{await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent===${JSON.stringify(label)}&&b.getClientRects().length);if(!el||el.disabled||el.closest('[inert]'))throw Error('Button unavailable: '+${JSON.stringify(label)});el.click();})()`);await wait(50);};
  const field=async(label,value,tag='input')=>{await js(`(()=>{const label=[...document.querySelectorAll('.global-settings label')].find(l=>l.textContent.startsWith(${JSON.stringify(label)})&&l.getClientRects().length);const el=label?.querySelector(${JSON.stringify(tag)});if(!el)throw Error('Field missing: '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(${tag==='select'?'HTMLSelectElement':'HTMLInputElement'}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(${JSON.stringify(tag==='select'?'change':'input')},{bubbles:true}));})()`);await wait(30);};
  const selectModel=async id=>{await js(`document.querySelector('[data-model-id="${id}"]').click()`);await wait(50);};
  const library=()=>controller.workspace.models.snapshot();
  await win.loadFile(path.join(root,'dist/index.html'));await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'startup');await js(`document.querySelector('.settings-button').click()`);
  await until(()=>js(`!!document.querySelector('.settings-model-detail')`),'settings');
  await selectModel('model_nano_pro');
  assert.equal(await js(`document.querySelectorAll('.settings-columns > :not([hidden])').length`),3);
  assert.equal(await js(`document.querySelectorAll('.settings-drawer-layer').length`),0);
  const beforeRecipe=structuredClone(controller.workspace.project?.recipe);
  await field('默认画面比例','16:9','select');await selectModel('model_image_2');
  await until(()=>js(`!!document.querySelector('.app-dialog')`),'unsaved guard');await click('继续编辑','.app-dialog');
  assert.equal(await js(`document.querySelector('.settings-model-row.selected').dataset.modelId`),'model_nano_pro');
  await selectModel('model_image_2');await click('保存并切换','.app-dialog');
  await until(()=>js(`document.querySelector('.settings-model-row.selected')?.dataset.modelId==='model_image_2'`),'save and switch');
  assert.equal(library().models.find(m=>m.model_config_id==='model_nano_pro').defaults.aspect_ratio,'16:9');
  assert.deepEqual(controller.workspace.project?.recipe,beforeRecipe);
  await click('接入设置');await field('模型显示名称','临时名称');await click('还原修改');
  assert.equal(await js(`document.querySelector('.settings-status').textContent`),'待配置');
  await click('默认参数');await click('设为默认编辑模型');
  await until(()=>Promise.resolve(library().assignments.editing_default==='model_image_2'),'default editing');
  await click('＋ 添加平台');await field('平台名称','三栏测试平台');await field('API 地址','https://model-library.example');await field('API Key','test-only-local');await click('保存并添加模型');
  await until(()=>js(`!!document.querySelector('.settings-enrollment')`),'platform to enrollment');assert.equal(probes,0);
  await click('获取模型列表');await until(()=>js(`document.querySelectorAll('.discovery-row').length===2`),'discovery');assert.equal(probes,1);
  await js(`(()=>{const el=document.querySelector('[aria-label="studio-second 模型预设"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'nano-banana-pro');el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(40);await js(`document.querySelectorAll('.discovery-row input[type=checkbox]').forEach(el=>el.click())`);await wait(40);await click('添加到模型库');
  await until(()=>js(`document.querySelector('.settings-enrollment [role=status]')?.textContent.includes('未全部完成')`),'partial batch');
  const connection=library().connections.find(c=>c.title==='三栏测试平台');assert.ok(connection);
  assert.equal(library().models.filter(m=>m.connection_id===connection.connection_id).length,1);
  assert.equal(await js(`document.querySelectorAll('.discovery-row input:checked').length`),1);
  failRemote='';await click('添加到模型库');await until(()=>js(`!!document.querySelector('.settings-model-detail')`),'batch completion');
  assert.equal(library().models.filter(m=>m.connection_id===connection.connection_id).length,2);
  assert.equal(attempts.filter(id=>id==='gemini-3-pro-image-preview').length,1); // retry must not re-enroll the successful item
  const currentId=await js(`document.querySelector('.settings-model-row.selected').dataset.modelId`);assert.equal(library().models.find(m=>m.model_config_id===currentId).connection_id,connection.connection_id);
  await click('＋ 添加模型');await click('手动添加');await field('平台模型 ID','private-alias');await field('对应模型预设','nano-banana-pro','select');await click('添加到模型库');
  await until(()=>js(`!!document.querySelector('.settings-model-detail')`),'manual enrollment');assert.equal(library().models.filter(m=>m.connection_id===connection.connection_id).length,3);
  await click('接入设置');await field('模型显示名称','不应保存');await click('返回工作台');await click('放弃并切换','.app-dialog');
  await until(()=>js(`!document.querySelector('.global-settings')`),'close guard');assert.ok(!library().models.some(m=>m.title==='不应保存'));
  await js(`document.querySelector('.settings-button').click()`);await until(()=>js(`!!document.querySelector('.settings-columns')`),'reopen');
  await js(`(()=>{[...document.querySelectorAll('.platform-row')].find(b=>b.textContent.includes('三栏测试平台')).click();})()`);await wait(100);
  await win.webContents.capturePage(undefined,{stayHidden:true});await wait(150);await writeFile(path.join(base,'three-column.png'),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG());
  for(const width of [1540,1024,800]){win.setSize(width,1000);await wait(80);const overflow=await js(`(()=>{const nodes=[...document.querySelectorAll('.settings-platforms,.settings-models,.settings-model-detail')];return nodes.filter(n=>n.scrollWidth>n.clientWidth+2).map(n=>n.className);})()`);assert.deepEqual(overflow,[],`column content overflow at ${width}`);}
  await controller.shutdown();win.destroy();const result={passed:true,base,probes,checks:['three-visible-columns','no-nested-drawers','unsaved-cancel','save-and-switch','recipe-preserved','default-editing','platform-to-enrollment','explicit-discovery-only','batch-partial-retry-no-duplicates','manual-alias-enrollment','close-discard','responsive-columns']};await writeFile(path.join(root,'.local/model-library-desktop-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
