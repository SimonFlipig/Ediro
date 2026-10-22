// Run after npm run build, with Electron. This uses an isolated runtime and the
// real preload, renderer and controller IPC; it never contacts a model provider.
const {app,BrowserWindow,ipcMain}=require('electron');
const {mkdtemp,mkdir,writeFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reportPath=path.join(root,'.local/mock-model-visibility-desktop-report.json');
const mockIds=['model_mock_native','model_mock_separated'];
const checks=[],commands=[];
let failureWindow,failureBase,controller,probes=0,executionAttempts=0,networkAttempts=0;
const forbidNetwork=()=>{networkAttempts++;throw Error('Real network requests are forbidden in the mock visibility smoke.');};
globalThis.fetch=forbidNetwork;
for(const name of ['node:http','node:https']){const transport=require(name);transport.request=forbidNetwork;transport.get=forbidNetwork;}
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});
  const base=await mkdtemp(path.join(root,'.local','mock-visibility-ui-'));failureBase=base;
  app.setPath('userData',path.join(base,'electron'));
  const runtime=path.join(base,'.local/runtime');
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {maskEditMethod}=await import('../dist-host/core/mask-request.js');
  const {tsImport}=require('tsx/esm/api');
  const {defaultMaskModel}=await tsImport('../src/ui/mask-editor-state.ts',pathToFileURL(__filename).href);
  const win=new BrowserWindow({width:1775,height:1050,show:false,webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  failureWindow=win;
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{networkAttempts++;callback({cancel:true});});
  const protectExecutors=()=>{
    controller.executors.execute=async()=>{executionAttempts++;throw Error('Model execution is forbidden in the mock visibility smoke.');};
    // Stub only the provider boundary. connection:probe must run its actual
    // controller path, including credential lookup without a default image model.
    controller.executors.probe=async(adapter,endpoint,key)=>{
      probes++;
      assert.equal(adapter,'openai-chat-completions');
      assert.equal(endpoint,'https://mock-visibility.example/v1');
      assert.equal(key,'isolated-smoke-key');
      assert.equal(controller.workspace.models.defaultModel(),undefined);
      return ['mock-visibility-reasoner','another-reasoner'];
    };
  };
  controller=await DesktopController.create(runtime,()=>win,{deferStartup:true});protectExecutors();
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  ipcMain.handle('ediro:command',async(_event,command)=>{commands.push(command.type);return controller.execute(command);});

  const js=async code=>{
    const result=await win.webContents.executeJavaScript(`(()=>{try{return {ok:true,value:(${code})};}catch(error){return {ok:false,error:error.stack??String(error)};}})()`);
    if(!result.ok)throw Error(result.error);return result.value;
  };
  const until=async(check,label)=>{for(let i=0;i<180;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const visible=selector=>js(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const click=async(label,scope='.global-settings')=>{
    await js(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(el=>(el.textContent===${JSON.stringify(label)}||el.getAttribute('aria-label')===${JSON.stringify(label)})&&el.getClientRects().length);if(!button||button.disabled||button.closest('[inert]'))throw Error('Button unavailable: '+${JSON.stringify(label)});button.click();})()`);
    await wait(60);
  };
  const field=async(label,value,tag='input',scope='.global-settings')=>{
    await js(`(()=>{const label=[...document.querySelectorAll(${JSON.stringify(scope+' label')})].find(el=>el.textContent.startsWith(${JSON.stringify(label)})&&el.getClientRects().length);const input=label?.querySelector(${JSON.stringify(tag)});if(!input||input.disabled)throw Error('Field unavailable: '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(${tag==='select'?'HTMLSelectElement':'HTMLInputElement'}.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(${JSON.stringify(tag==='select'?'change':'input')},{bubbles:true}));})()`);
    await wait(40);
  };
  const ipc=async command=>{
    const response=await win.webContents.executeJavaScript(`window.ediro.execute(${JSON.stringify(command)})`);
    if(response.ok)await controller.refreshState();
    return response;
  };
  const success=async command=>{const result=await ipc(command);assert.equal(result.ok,true,result.error);return result;};
  const library=()=>controller.workspace.models.snapshot();
  const publicMocks=async()=>((await controller.view()).models.filter(model=>model.kind==='mock').map(model=>model.model_config_id).sort());
  const dropdownMocks=()=>js(`[...document.querySelectorAll('#generation-model option')].filter(option=>option.textContent.includes('模拟引擎')).map(option=>option.value).sort()`);
  const listedMocks=()=>js(`[...document.querySelectorAll('.settings-model-row[data-model-id]')].filter(row=>${JSON.stringify(mockIds)}.includes(row.dataset.modelId)).map(row=>row.dataset.modelId).sort()`);
  const capture=async name=>{
    // Hidden windows need a compositor frame before the captured pixels catch
    // up with the DOM after a dialog closes or a controller is reloaded.
    await win.webContents.capturePage(undefined,{stayHidden:true});
    await js(`(()=>{for(const animation of document.getAnimations()){try{animation.finish();}catch{}}})()`);await wait(150);
    await writeFile(path.join(base,name),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG());
  };
  const load=async()=>{await win.loadFile(path.join(root,'dist/index.html'));await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'renderer ready');};
  const openLibrary=async()=>{await js(`document.querySelector('.settings-button').click()`);await until(()=>visible('.global-settings'),'model library open');};
  const chooseAll=async()=>{await js(`(()=>{const button=[...document.querySelectorAll('.platform-row')].find(el=>el.querySelector('b')?.textContent==='全部模型');if(!button)throw Error('All-models navigation missing');button.click();})()`);await wait(60);};
  const chooseModel=async id=>{await js(`(()=>{const button=document.querySelector('[data-model-id="'+${JSON.stringify(id)}+'"]');if(!button)throw Error('Model row missing');button.click();})()`);await wait(50);};
  const closeLibrary=async()=>{await click('返回工作台');await until(async()=>!await visible('.global-settings'),'library closed');};
  const detail='.settings-model-detail',platformForm='.settings-platform-editor';

  await load();
  assert.deepEqual(await publicMocks(),mockIds);
  assert.deepEqual(await dropdownMocks(),mockIds);
  const originalRecipe=structuredClone(controller.workspace.project.recipe);
  assert.equal(originalRecipe.model_config_id,'model_mock_native');
  let state=await controller.view();
  assert.equal(defaultMaskModel(state.models,state.assignments.editing_default)?.kind,'mock');
  assert.equal(state.models.filter(model=>model.enabled&&maskEditMethod(model)&&model.kind==='mock').length,2);
  await openLibrary();assert.deepEqual(await listedMocks(),mockIds);
  await chooseModel('model_mock_native');
  assert.equal(await js(`(()=>{const button=[...document.querySelectorAll('${detail} button')].find(el=>el.textContent==='移除接入');return button?.disabled&&button.title.includes('不可移除');})()`),true);
  checks.push('fresh-renderer-generation-library-and-mask-helper-show-both-mocks','built-in-mock-removal-disabled');

  // Creating a platform is deliberately separate from enrolling its first model.
  await click('＋ 添加平台');
  await field('平台名称','引擎可见性测试平台','input',platformForm);
  await field('接口类型','openai-chat-completions','select',platformForm);
  await field('API 地址','https://mock-visibility.example/v1','input',platformForm);
  await field('API Key','isolated-smoke-key','input',platformForm);
  await click('保存平台',platformForm);
  await until(()=>visible('.settings-enrollment'),'platform saved to enrollment');
  const connection=library().connections.find(item=>item.title==='引擎可见性测试平台');assert.ok(connection);
  assert.deepEqual(await publicMocks(),mockIds);assert.deepEqual(await dropdownMocks(),mockIds);
  assert.equal(library().models.some(model=>model.connection_id===connection.connection_id),false);
  assert.equal(probes,0);checks.push('platform-only-keeps-mocks-and-does-not-probe');

  await click('手动添加','.settings-enrollment');
  await field('平台模型 ID','mock-visibility-reasoner','input','.enrollment-manual');
  await field('模型家族','reasoning','select','.enrollment-manual');
  await click('添加到模型库','.enrollment-manual');
  await until(()=>Promise.resolve(library().models.some(model=>model.model==='mock-visibility-reasoner')),'renderer manual enrollment');
  const own=library().models.find(model=>model.model==='mock-visibility-reasoner');
  assert.equal(own.purpose,'understanding');
  await until(()=>js(`document.querySelector('.settings-model-row.selected')?.dataset.modelId===${JSON.stringify(own.model_config_id)}`),'enrolled model selected');
  await click('收起添加','.settings-enrollment');
  await click('设为默认推理模型',detail);
  await until(()=>Promise.resolve(library().assignments.understanding_default===own.model_config_id),'reasoning default assigned');
  assert.equal(await js(`[...document.querySelectorAll('${detail} button')].find(el=>el.textContent==='移除接入')?.disabled`),false);
  assert.deepEqual(await publicMocks(),[]);
  assert.equal(library().models.filter(model=>model.kind==='mock').length,2);
  await chooseAll();assert.deepEqual(await listedMocks(),[]);
  assert.equal(await js(`document.querySelector('.settings-platforms').textContent.includes('模拟')`),false);
  checks.push('renderer-manual-reasoning-enrollment-hides-mocks-globally','real-default-remains-removable','mock-records-retained','local-navigation-loses-simulation-label');

  await closeLibrary();
  assert.deepEqual(controller.workspace.project.recipe,originalRecipe,'enrollment must not switch the active recipe');
  assert.deepEqual(await dropdownMocks(),[]);
  assert.equal(await js(`document.querySelector('#generation-model option:checked')?.textContent.includes('待选择模型')`),true);
  assert.equal(await js(`document.querySelector('.generate-button')?.disabled`),true);
  state=await controller.view();
  assert.equal(state.models.filter(model=>model.enabled&&maskEditMethod(model)).some(model=>model.kind==='mock'),false);
  assert.notEqual(defaultMaskModel(state.models,state.assignments.editing_default)?.kind,'mock');
  const rejected=await ipc({type:'job:start',allow_degradation:true});assert.equal(rejected.ok,false);assert.match(rejected.error,/真实模型|重新选择|模拟|隐藏/);
  const selectRejected=await ipc({type:'recipe:select-model',model_config_id:'model_mock_separated'});assert.equal(selectRejected.ok,false);assert.match(selectRejected.error,/真实模型|重新选择|模拟|隐藏/);
  assert.equal(executionAttempts,0);
  checks.push('old-mock-recipe-preserved-with-selection-placeholder-and-disabled-run','mask-helper-cannot-pick-hidden-mock','actual-ipc-cannot-run-or-select-hidden-mock');

  // Remove unused seed placeholders through real IPC so this fixture contains
  // only the user's reasoning model plus the two retained, hidden mock records.
  for(const id of ['model_nano_pro','model_image_2','model_local_pending'])if(library().models.some(model=>model.model_config_id===id))await success({type:'model:delete',model_config_id:id});
  state=await controller.view();assert.deepEqual(state.models.map(model=>model.model_config_id),[own.model_config_id]);
  assert.equal(defaultMaskModel(state.models,state.assignments.editing_default),undefined);
  await openLibrary();assert.equal(await js(`document.querySelectorAll('.settings-platform-footer').length`),0);await closeLibrary();
  const created=await success({type:'project:create',name:'只有推理模型的工作'});
  assert.equal(created.state.project.recipe.model_config_id,'model_unselected');
  assert.equal(created.state.project.recipe.modules.length,4);
  assert.equal(created.state.assignments.generation_default,undefined);
  assert.equal(await js(`document.querySelector('.generate-button')?.disabled`),true);
  const discovery=await success({type:'connection:probe',connection_id:connection.connection_id,adapter_id:'openai-chat-completions'});
  assert.deepEqual(discovery.discovered_models,['mock-visibility-reasoner','another-reasoner']);assert.equal(probes,1);
  checks.push('reasoning-only-library-has-no-local-navigation-or-mask-candidates','new-work-works-without-generation-default','real-controller-probe-works-without-generation-default');

  await controller.shutdown();controller=await DesktopController.create(runtime,()=>win,{deferStartup:true});protectExecutors();await load();
  assert.deepEqual(await publicMocks(),[]);assert.deepEqual(await dropdownMocks(),[]);
  assert.equal(controller.workspace.project.recipe.model_config_id,'model_unselected');
  assert.equal((await controller.view()).assignments.understanding_default,own.model_config_id);
  checks.push('restart-preserves-hidden-mocks-and-reasoning-default');

  // The last real model is a default and is removed through the real UI dialog.
  await openLibrary();await chooseModel(own.model_config_id);await click('移除接入',detail);
  await until(()=>visible('.app-dialog'),'last-model removal confirmation');
  const confirmation=await js(`document.querySelector('.app-dialog')?.textContent`);
  assert.match(confirmation,/默认.*清除/);assert.match(confirmation,/模拟引擎.*重新显示/);
  await click('确认移除','.app-dialog');
  await until(()=>Promise.resolve(!library().models.some(model=>model.model_config_id===own.model_config_id)),'last real default removed');
  await chooseAll();await until(async()=>JSON.stringify(await listedMocks())===JSON.stringify(mockIds),'both mock rows restored');
  assert.deepEqual(await publicMocks(),mockIds);
  assert.equal(library().connections.some(item=>item.connection_id===connection.connection_id),true,'platform must remain after its last model is removed');
  assert.equal(library().assignments.understanding_default,undefined);
  assert.equal(await js(`document.querySelector('.settings-platforms').textContent.includes('模拟与本地')`),true);
  await capture('mocks-restored-in-library.png');await closeLibrary();assert.deepEqual(await dropdownMocks(),mockIds);
  state=await controller.view();assert.equal(defaultMaskModel(state.models,state.assignments.editing_default)?.kind,'mock');
  checks.push('renderer-can-remove-last-real-default-with-explanatory-confirmation','last-model-removal-restores-both-mocks-with-platform-retained','mask-helper-restores-mock-after-library-cleared');

  await controller.shutdown();controller=await DesktopController.create(runtime,()=>win,{deferStartup:true});protectExecutors();await load();
  assert.deepEqual(await publicMocks(),mockIds);assert.deepEqual(await dropdownMocks(),mockIds);
  assert.equal(controller.workspace.project.recipe.model_config_id,'model_mock_native');
  assert.equal(await js(`document.querySelector('.generate-button')?.disabled`),false);
  assert.equal(library().connections.some(item=>item.connection_id===connection.connection_id),true);
  assert.equal(executionAttempts,0);assert.equal(networkAttempts,0);
  checks.push('restart-after-clear-restores-fresh-mock-default','no-model-execution-or-network-request');
  await capture('mocks-restored-after-restart.png');
  await controller.shutdown();win.destroy();
  const result={passed:true,base,probes,executionAttempts,networkAttempts,checks,commandCounts:Object.fromEntries([...new Set(commands)].map(type=>[type,commands.filter(value=>value===type).length])),maskValidation:'Actual defaultMaskModel source and controller public candidates checked before/after enrollment, clear and restart; the image-dependent mask dropdown was not opened.'};
  await writeFile(reportPath,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(0);
}).catch(async error=>{
  console.error(error);
  if(failureWindow&&!failureWindow.isDestroyed()&&failureBase){try{await writeFile(path.join(failureBase,'failure.png'),(await failureWindow.webContents.capturePage(undefined,{stayHidden:true})).toPNG());await writeFile(path.join(failureBase,'failure.html'),await failureWindow.webContents.executeJavaScript('document.documentElement.outerHTML'));console.error('Failure artifacts: '+failureBase);}catch{}}
  try{await writeFile(reportPath,JSON.stringify({passed:false,base:failureBase,error:error.stack??String(error),probes,executionAttempts,networkAttempts,checks},null,2));}catch{}
  app.exit(1);
});
