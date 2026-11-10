// Real renderer + DesktopController with an isolated runtime and no execution.
// Build first, then run with Electron. The offscreen window always stays hidden.
const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');
const {mkdir,mkdtemp,writeFile,readFile,appendFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let controller,win,base,lastFrame,frameSequence=0,lastStage='startup',providerCalls=0;
const captures=[],commands=[],layoutChecks=[];
const forbidProvider=()=>{providerCalls++;throw Error('Provider access is forbidden in reference-precision smoke.');};
globalThis.fetch=async()=>forbidProvider();
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});
  base=await mkdtemp(path.join(root,'.local','reference-precision-ui-'));
  app.setPath('userData',path.join(base,'electron'));
  const phase=async name=>{lastStage=name;await appendFile(path.join(base,'stages.jsonl'),JSON.stringify({stage:name,time:new Date().toISOString()})+'\n');};
  const runtime=path.join(base,'runtime');
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {registerWindowChrome}=await import('../dist-host/desktop/window-chrome.js');
  const {seedModels}=await import('../dist-host/core/models.js');
  const {geminiProfile,mockProfile}=await import('../dist-host/protocols/generation-profiles.js');
  const {referencePrecisionModules}=await import('../dist-host/core/module-settings.js');
  const adapterId='precision-smoke',modelId='model_precision_smoke';
  const contract={...structuredClone(mockProfile),features:['reference_overrides'],fields:structuredClone(geminiProfile.fields.filter(field=>['reference_precision','reference_overrides'].includes(field.key)))};
  win=new BrowserWindow({width:1775,height:1050,show:false,backgroundColor:'#f6f5f1',
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,offscreen:true}});
  win.setMenuBarVisibility(false);registerWindowChrome(ipcMain,()=>win);
  win.webContents.on('paint',(_event,_dirty,image)=>{if(!image.isEmpty()){lastFrame={png:image.toPNG(),size:image.getSize()};frameSequence++;}});
  win.webContents.setFrameRate(30);
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{providerCalls++;callback({cancel:true});});
  const createController=async()=>{
    const next=await DesktopController.create(runtime,()=>win,{deferStartup:true,projectRoot:base,showMessage:async()=>{throw Error('Unexpected native dialog in reference-precision smoke.');}});
    next.workspace.models.adapters.push({adapter_id:adapterId,version:1,title:'参考图精度测试',kind:'mock',installed:true,purposes:['generation'],requires_credential:false,supports_probe:false,interleaving:['native','separated'],operations:['generate','referenceEdit'],parameters:[],generation_contract:contract});
    next.executors.execute=async()=>forbidProvider();next.executors.probe=async()=>forbidProvider();
    if(!next.workspace.models.snapshot().models.some(model=>model.model_config_id===modelId)){
      const model=seedModels()[0];
      await next.workspace.models.saveModel({...model,model_config_id:modelId,title:'参考图精度测试 · 不执行',model:'precision-smoke-v1',adapter_id:adapterId,purpose:'generation',generation_contract:contract,capabilities:{...model.capabilities,operations:['generate','referenceEdit'],features:['reference_overrides']}});
    }
    return next;
  };
  await phase('create-isolated-controller');controller=await createController();
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  const allowed=new Set(['state','module-settings:save','recipe:save','project:save','project:create','module:add','recipe:select-model','reference:preview','reference:cancel-preview']);
  ipcMain.handle('ediro:command',async(_event,command)=>{assert.ok(allowed.has(command.type),'unexpected UI command '+command.type);commands.push(structuredClone(command));return controller.execute(command);});
  const execute=async command=>{const response=await controller.execute(command);assert.equal(response.ok,true,response.error);if(response.state)win.webContents.send('ediro:state',response.state);return response;};
  const js=async code=>{
    const result=await win.webContents.executeJavaScript(`(()=>{try{return {ok:true,value:(${code})};}catch(error){return {ok:false,error:error.stack??String(error)};}})()`);
    if(!result.ok)throw Error(result.error);return result.value;
  };
  const until=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const freshFrame=async label=>{
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before=frameSequence;win.webContents.startPainting();win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>before&&lastFrame?.png.length),label+' first frame');
    await wait(120);const settled=frameSequence;win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>settled&&lastFrame?.png.length),label+' settled frame');
    return lastFrame;
  };
  const visible=selector=>js(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const reach=async selector=>{
    const layout=await js(`(()=>{
      const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Control unavailable: '+${JSON.stringify(selector)});
      el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      const r=el.getBoundingClientRect(),clipped=[];
      if(!r.width||!r.height||r.left<0||r.top<0||r.right>innerWidth+1||r.bottom>innerHeight+1)clipped.push('viewport');
      for(let parent=el.parentElement;parent;parent=parent.parentElement){
        const box=parent.getBoundingClientRect(),style=getComputedStyle(parent),left=box.left+parent.clientLeft,top=box.top+parent.clientTop;
        if(/auto|scroll|hidden|clip/.test(style.overflowX)&&(r.left<left-1||r.right>left+parent.clientWidth+1))clipped.push(parent.className+':horizontal');
        if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(r.top<top-1||r.bottom>top+parent.clientHeight+1))clipped.push(parent.className+':vertical');
      }
      const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      return {selector:${JSON.stringify(selector)},width:innerWidth,height:innerHeight,clipped,uncovered:!!hit&&(hit===el||el.contains(hit))};
    })()`);
    assert.deepEqual(layout.clipped,[],selector+' reachable after scrolling');assert.equal(layout.uncovered,true,selector+' uncovered');
    layoutChecks.push(layout);return layout;
  };
  const select=async(selector,value)=>{
    await reach(selector);
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(![...el.options].some(option=>option.value===${JSON.stringify(value)}))throw Error('Missing option');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(35);
  };
  const click=async selector=>{await reach(selector);await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(35);};
  const clickLabel=async(label,scope)=>{
    await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Button unavailable');el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});el.click();})()`);await wait(35);
  };
  const load=async()=>{await win.loadFile(path.join(root,'dist','index.html'));await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'renderer startup');assert.equal(win.isVisible(),false);};
  const openModules=async()=>{await click('.settings-button');await clickLabel('模块设置','.settings-page-navigation');await until(()=>visible('.module-settings-body'),'module settings page');};
  const precisionSelect=title=>`select[aria-label="${title}参考图识别精度"]`;
  const settingsFile=path.join(runtime,'module-settings.v1.json');
  const diskSettings=async()=>JSON.parse(await readFile(settingsFile,'utf8'));
  const values=()=>js(`Object.fromEntries([...document.querySelectorAll('.module-settings-row select[aria-label$="识别精度"]')].map(el=>[el.getAttribute('aria-label'),el.value]))`);
  const capturePane=async(name,scroller,width,height,selectors)=>{
    win.setSize(width,height);await wait(100);await freshFrame(name+' resize');
    for(const selector of selectors)await reach(selector);
    const layout=await js(`(()=>{const pane=document.querySelector(${JSON.stringify(scroller)});return {width:innerWidth,height:innerHeight,scrollHeight:pane.scrollHeight,clientHeight:pane.clientHeight,overflow:[...pane.querySelectorAll('select,.module-settings-row')].filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>el.getAttribute('aria-label')||el.className)};})()`);
    assert.deepEqual(layout.overflow,[],name+' horizontal overflow');
    for(const position of ['top','bottom']){
      await js(`(()=>{const pane=document.querySelector(${JSON.stringify(scroller)});pane.scrollTop=${position==='top'?'0':'pane.scrollHeight'};})()`);
      const frame=await freshFrame(name+' '+position),file=path.join(base,`${name}-${width}x${height}-${position}.png`);
      await writeFile(file,frame.png);captures.push({file,position,viewport:{width:layout.width,height:layout.height},pixels:frame.size,scrollHeight:layout.scrollHeight,clientHeight:layout.clientHeight});
    }
    assert.equal(win.isVisible(),false);
  };

  await phase('five-settings-change-and-save');await load();await openModules();
  assert.equal(await js(`document.querySelectorAll('.module-settings-row select[aria-label$="识别精度"]').length`),5);
  assert.ok(Object.values(await values()).every(value=>value==='inherit'));
  const originalRecipe=structuredClone(controller.workspace.project.recipe);
  const expected={image_text:'medium',subject:'low',composition:'medium',style:'ultra_high',viewpoint:'high'};
  for(const module of referencePrecisionModules){
    await select(precisionSelect(module.title),expected[module.type]);
    await until(async()=>controller.workspace.moduleSettings.reference_precision?.[module.type]===expected[module.type]&&await js(`document.querySelectorAll('.module-settings-row select:disabled').length===0`),module.type+' precision saved');
    assert.deepEqual((await diskSettings()).reference_precision,controller.workspace.moduleSettings.reference_precision);
  }
  assert.deepEqual(controller.workspace.project.recipe,originalRecipe,'default edits preserve existing module choices');
  const settingsSelectors=referencePrecisionModules.map(module=>precisionSelect(module.title));
  for(const [width,height] of [[1775,1050],[1120,800]])await capturePane('module-defaults','.module-settings-body',width,height,settingsSelectors);

  await phase('new-work-and-new-modules-use-defaults');await clickLabel('返回工作台','.settings-page-actions');
  const previousProject=controller.workspace.project.project_id;
  await clickLabel('＋ 新工作','.top-actions');await until(()=>visible('.app-dialog'),'new work confirmation');
  await clickLabel('开始新工作','.app-dialog');await until(()=>Promise.resolve(controller.workspace.project.project_id!==previousProject),'new project');
  for(const type of ['subject','composition','style'])assert.equal(controller.workspace.project.recipe.modules.find(module=>module.reference_type===type).reference_precision,expected[type]);
  for(const module of referencePrecisionModules){
    const count=controller.workspace.project.recipe.modules.length;
    await click(`.library-module.type-${module.type}`);
    await until(()=>Promise.resolve(controller.workspace.project.recipe.modules.length===count+1),'new '+module.type+' module');
    assert.equal(controller.workspace.project.recipe.modules.at(-1).reference_precision,expected[module.type]);
  }

  await phase('fresh-controller-loads-persisted-defaults');
  await controller.shutdown();controller=await createController();
  assert.deepEqual(controller.workspace.moduleSettings.reference_precision,expected);
  for(const type of ['subject','composition','style'])assert.equal(controller.workspace.project.recipe.modules.find(module=>module.reference_type===type).reference_precision,expected[type]);
  await load();await openModules();
  for(const module of referencePrecisionModules)assert.equal((await values())[module.title+'参考图识别精度'],expected[module.type]);
  await clickLabel('返回工作台','.settings-page-actions');

  await phase('two-reference-defaults-in-workbench');
  await select('#generation-model',modelId);
  await until(()=>Promise.resolve(controller.workspace.project.recipe.model_config_id===modelId),'precision model selected');
  const subject=controller.workspace.project.recipe.modules.find(module=>module.reference_type==='subject');
  const composition=controller.workspace.project.recipe.modules.find(module=>module.reference_type==='composition');
  const firstFile=path.join(base,'subject-reference.png'),secondFile=path.join(base,'composition-reference.png');
  await writeFile(firstFile,await sharp({create:{width:640,height:640,channels:3,background:'#47674c'}}).png().toBuffer());
  await writeFile(secondFile,await sharp({create:{width:800,height:600,channels:3,background:'#b46d49'}}).png().toBuffer());
  await execute({type:'assets:drop',paths:[firstFile],module_id:subject.module_id});
  await execute({type:'assets:drop',paths:[secondFile],module_id:composition.module_id});
  const firstId=subject.asset_ids[0]??controller.workspace.project.recipe.modules.find(module=>module.module_id===subject.module_id).asset_ids[0];
  const secondId=controller.workspace.project.recipe.modules.find(module=>module.module_id===composition.module_id).asset_ids[0];
  assert.notEqual(firstId,secondId);
  const firstSelect='select[aria-label="subject-reference.png识别精度"]',secondSelect='select[aria-label="composition-reference.png识别精度"]';
  await until(()=>visible('.generation-options details summary'),'advanced options');await click('.generation-options details summary');
  await until(()=>visible(firstSelect),'per-image precision controls');
  const selection=selector=>js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return {value:el.value,label:el.selectedOptions[0].textContent,options:[...el.options].map(option=>option.value)};})()`);
  assert.equal((await selection(firstSelect)).label,'模块默认（低）');
  assert.equal((await selection(secondSelect)).label,'模块默认（中）');
  assert.equal((await selection(firstSelect)).options.filter(value=>value==='inherit').length,1);

  await phase('manual-override-global-and-reset-change-events');
  const overrides=()=>controller.workspace.project.recipe.core_parameters.extensions?.[adapterId]?.reference_overrides??{};
  for(const value of ['high','inherit','module_default']){
    await select(firstSelect,value);
    await until(()=>Promise.resolve(value==='module_default'?!Object.hasOwn(overrides(),firstId):overrides()[firstId]===value),'business override '+value);
    await until(async()=>(await selection(firstSelect)).value===value,'rendered override '+value);
    assert.equal(Object.hasOwn(overrides(),secondId),false,'editing one reference preserves the other default');
  }
  await execute({type:'project:save'});
  const stored=await controller.workspace.repository.load();
  assert.equal(Object.hasOwn(stored.recipe.core_parameters.extensions?.[adapterId]?.reference_overrides??{},firstId),false);

  await phase('same-asset-different-module-defaults');
  const sharedRecipe=structuredClone(controller.workspace.project.recipe);
  sharedRecipe.modules.find(module=>module.reference_type==='style').asset_ids=[firstId];
  await execute({type:'recipe:save',recipe:sharedRecipe});
  await until(async()=>(await selection(firstSelect)).label==='模块默认（按模块）','shared asset module defaults');
  assert.equal((await selection(secondSelect)).label,'模块默认（中）');
  for(const [width,height] of [[1775,1050],[1120,800]])await capturePane('per-image-defaults','.parameter-section',width,height,[firstSelect,secondSelect]);

  await phase('renderer-reload-retains-per-image-state');await execute({type:'project:save'});await load();
  await until(()=>visible('.generation-options details summary'),'reloaded advanced options');await click('.generation-options details summary');
  assert.equal((await selection(firstSelect)).label,'模块默认（按模块）');
  assert.equal((await selection(secondSelect)).label,'模块默认（中）');
  assert.equal(commands.filter(command=>command.type==='module-settings:save').length,5);
  assert.equal(commands.filter(command=>command.type==='module:add').length,5);
  assert.equal(providerCalls,0);assert.equal(win.isVisible(),false);
  await phase('complete');
  const result={passed:true,base,runtime,providerCalls,settings:controller.workspace.moduleSettings,settingsSaveEvents:5,newModuleEvents:5,referenceAssetIds:[firstId,secondId],captures,layoutChecks,checks:['five-default-change-events-and-disk-save','existing-modules-preserved','new-work-inherits-defaults','new-modules-inherit-defaults','fresh-controller-reload','two-image-default-labels','explicit-high','explicit-global-inherit','restore-module-default','per-image-business-state','shared-asset-module-defaults','renderer-reload','scroll-reachability-two-viewports','top-bottom-screenshots','zero-provider-calls']};
  const report=path.join(base,'report.json');await writeFile(report,JSON.stringify(result,null,2));
  await controller.shutdown();controller=undefined;win.destroy();console.log(JSON.stringify({...result,report}));app.exit(0);
}).catch(async error=>{
  console.error(error);
  if(base){
    await writeFile(path.join(base,'failure.json'),JSON.stringify({stage:lastStage,error:error.stack??String(error),providerCalls},null,2)).catch(()=>{});
    if(win&&!win.isDestroyed()){
      try{await writeFile(path.join(base,'failure.html'),await win.webContents.executeJavaScript('document.documentElement.outerHTML'));}catch{}
      try{if(lastFrame)await writeFile(path.join(base,'failure.png'),lastFrame.png);}catch{}
    }
    console.error('Failure stage: '+lastStage+'; artifacts: '+base);
  }
  if(controller)try{await controller.shutdown();}catch{}
  app.exit(1);
});
