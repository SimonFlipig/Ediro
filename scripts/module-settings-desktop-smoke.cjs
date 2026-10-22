// Real renderer + DesktopController, with a fresh runtime and no provider calls.
// Run after npm run build. The Electron window remains hidden throughout.
const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');
const {mkdtemp,mkdir,readFile,writeFile,appendFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let failureWindow,failureBase,controller,freshFrame,lastFrame,lastStage='startup',providerCalls=0;
const forbidProvider=()=>{providerCalls++;throw Error('Provider access is forbidden in module-settings smoke.');};
globalThis.fetch=async()=>forbidProvider();
// Hidden Windows GPU surfaces can reject capturePage with UnknownVizError.
// Software offscreen painting produces explicit frames without showing a window.
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});
  const base=await mkdtemp(path.join(root,'.local','module-settings-ui-'));failureBase=base;
  const phase=async name=>{
    lastStage=name;const record={stage:name,time:new Date().toISOString()};
    await appendFile(path.join(base,'stages.jsonl'),JSON.stringify(record)+'\n');
    await writeFile(path.join(base,'stage.json'),JSON.stringify(record));
  };
  await phase('create-isolated-controller');
  app.setPath('userData',path.join(base,'electron'));
  const runtime=path.join(base,'.local','runtime');
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {registerWindowChrome}=await import('../dist-host/desktop/window-chrome.js');
  const win=new BrowserWindow({width:1775,height:1050,show:false,backgroundColor:'#f6f5f1',
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,offscreen:true}});
  failureWindow=win;win.setMenuBarVisibility(false);registerWindowChrome(ipcMain,()=>win);
  let paintSequence=0;
  win.webContents.on('paint',(_event,_dirty,image)=>{
    if(image.isEmpty())return;
    lastFrame={png:image.toPNG(),size:image.getSize()};paintSequence++;
  });
  win.webContents.setFrameRate(30);
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{providerCalls++;callback({cancel:true});});
  const createController=async()=>{
    const next=await DesktopController.create(runtime,()=>win,{deferStartup:true,projectRoot:base,showMessage:async()=>{throw Error('Unexpected native dialog in isolated smoke.');}});
    next.executors.execute=async()=>forbidProvider();next.executors.probe=async()=>forbidProvider();
    return next;
  };
  controller=await createController();
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  let failNextSave=false,saveAttempts=0,savedSettings=0;
  let failNextPreview=false,previewAttempts=0,cancelPreviewAttempts=0,prepareAttempts=0,releasePrepare;
  const previewRequests=[];
  const modelStates={depth:'missing',segment:'missing'};
  const withModelStates=response=>response.state?{...response,state:{...response.state,reference_models:{...modelStates}}}:response;
  const allowedCommands=new Set(['state','module-settings:save','project:save','recipe:save','reference:preview','reference:cancel-preview','reference-model:prepare']);
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  ipcMain.handle('ediro:command',async(_event,command)=>{
    if(!allowedCommands.has(command.type))throw Error('Unexpected command: '+command.type);
    if(command.type==='module-settings:save'){
      saveAttempts++;
      if(failNextSave){failNextSave=false;return {ok:false,error:'模拟模块设置保存失败'};}
    }
    if(command.type==='reference:preview'){
      previewAttempts++;
      previewRequests.push(structuredClone(command));
      if(failNextPreview){failNextPreview=false;return {ok:false,error:'模拟预览失败，请重试。'};}
    }
    if(command.type==='reference:cancel-preview')cancelPreviewAttempts++;
    // Download UI is exercised at the IPC boundary; no model resource is downloaded.
    if(command.type==='reference-model:prepare'){
      prepareAttempts++;
      if(prepareAttempts===1)return {ok:false,error:'模拟资源下载失败，请重试。'};
      modelStates[command.kind]='downloading';
      win.webContents.send('ediro:state',(await withModelStates({state:await controller.view()})).state);
      await new Promise(resolve=>{releasePrepare=resolve;});
      modelStates[command.kind]='ready';
      return withModelStates({ok:true,state:await controller.view()});
    }
    const result=await controller.execute(command);
    if(command.type==='module-settings:save'&&result.ok)savedSettings++;
    return withModelStates(result);
  });
  const js=async code=>{
    const result=await win.webContents.executeJavaScript(`(()=>{try{return {ok:true,value:(${code})};}catch(error){return {ok:false,error:error.stack??String(error)};}})()`);
    if(!result.ok)throw Error(result.error);return result.value;
  };
  const until=async(check,label)=>{for(let i=0;i<200;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  freshFrame=async label=>{
    // DOM geometry can update before the software compositor has replaced the
    // prior offscreen surface. Settle layout, then request a second painted frame.
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before=paintSequence;win.webContents.startPainting();win.webContents.invalidate();
    await until(()=>Promise.resolve(paintSequence>before&&lastFrame?.png.length>0),label+' fresh offscreen frame');
    await wait(120);const settled=paintSequence;win.webContents.invalidate();
    await until(()=>Promise.resolve(paintSequence>settled&&lastFrame?.png.length>0),label+' settled offscreen frame');
    assert.ok(lastFrame.size.width>0&&lastFrame.size.height>0,'offscreen frame has dimensions');
    return lastFrame;
  };
  const visible=selector=>js(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const click=async(label,scope='.global-settings')=>{
    await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(button=>button.textContent.trim()===${JSON.stringify(label)}&&button.getClientRects().length);if(!el||el.disabled||el.closest('[inert]'))throw Error('Button unavailable: '+${JSON.stringify(label)});el.click();})()`);
    await wait(50);
  };
  const select=async(selector,value)=>{
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||!el.getClientRects().length||el.closest('[inert]'))throw Error('Select unavailable: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(30);
  };
  const clickAria=async label=>{
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});if(!el||el.disabled||!el.getClientRects().length||el.closest('[inert]'))throw Error('Button unavailable: '+${JSON.stringify(label)});el.click();})()`);
    await wait(40);
  };
  const moduleSelect=type=>`.module-settings-row select[aria-label="${type==='composition'?'构图':'风格'}参考图最长边"]`;
  const values=()=>js(`Object.fromEntries([...document.querySelectorAll('.module-settings-row select[aria-label$="最长边"]')].map(el=>[el.getAttribute('aria-label'),el.value]))`);
  const expectedValues=(composition,style)=>({'构图参考图最长边':String(composition),'风格参考图最长边':String(style)});
  const expectedSettings=(composition,style)=>({version:1,composition:{max_edge:composition,preprocess:'none',blur_strength:'medium'},style:{max_edge:style,preprocess:'none',blur_strength:'medium'},prompt:{role:'general'}});
  const settings=()=>controller.workspace.moduleSettings;
  const settingsFile=path.join(runtime,'module-settings.v1.json');
  const diskSettings=async()=>JSON.parse(await readFile(settingsFile,'utf8'));
  const load=async()=>{
    await win.loadFile(path.join(root,'dist','index.html'));
    await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'renderer startup');
    assert.equal(win.isVisible(),false);
  };
  const openSettings=async()=>{await click('设置','.top-actions');await until(()=>visible('.global-settings'),'open settings');};
  const openModules=async()=>{await click('模块设置','.settings-page-navigation');await until(()=>visible('.module-settings-body'),'module settings page');};
  const waitSaved=async(composition,style)=>{
    await until(async()=>JSON.stringify(await values())===JSON.stringify(expectedValues(composition,style))&&await js(`document.querySelectorAll('.module-settings-row select:disabled').length===0`),'module settings saved');
    assert.deepEqual(settings(),expectedSettings(composition,style));
    assert.deepEqual(await diskSettings(),settings());
  };
  const screenshots=[];
  const capture=async(width,height)=>{
    await phase(`capture-${width}x${height}-resize`);
    win.setSize(width,height);await wait(100);
    await freshFrame(`resize ${width}x${height}`);
    await phase(`capture-${width}x${height}-layout`);
    const layout=await js(`(()=>{
      const controls=[...document.querySelectorAll('.settings-page-navigation button,.settings-page-actions button,.module-settings-row select')];
      const clipped=[];
      for(const el of controls){
        const r=el.getBoundingClientRect(),name=el.getAttribute('aria-label')||el.textContent.trim();
        if(!r.width||!r.height||r.left<0||r.top<0||r.right>innerWidth+1||r.bottom>innerHeight+1){clipped.push(name+':viewport');continue;}
        for(let parent=el.parentElement;parent;parent=parent.parentElement){
          const box=parent.getBoundingClientRect(),style=getComputedStyle(parent);
          const left=box.left+parent.clientLeft,top=box.top+parent.clientTop;
          if(/auto|scroll|hidden|clip/.test(style.overflowX)&&(r.left<left-1||r.right>left+parent.clientWidth+1))clipped.push(name+':horizontal');
          if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(r.top<top-1||r.bottom>top+parent.clientHeight+1))clipped.push(name+':vertical');
        }
      }
      return {width:innerWidth,height:innerHeight,controlCount:controls.length,clipped,
        overflow:[...document.querySelectorAll('.settings-page-heading,.module-settings-body,.module-settings-row')].filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>el.className),
        previewCount:document.querySelectorAll('.module-settings-body img,.module-settings-body canvas').length};
    })()`);
    assert.equal(layout.controlCount,9);assert.deepEqual(layout.clipped,[]);assert.deepEqual(layout.overflow,[]);assert.equal(layout.previewCount,0);assert.equal(win.isVisible(),false);
    const file=path.join(base,`module-settings-${width}x${height}.png`);
    await phase(`capture-${width}x${height}-write`);
    const frame=await freshFrame(`capture ${width}x${height}`);
    await writeFile(file,frame.png);
    screenshots.push({file,viewport:{width:layout.width,height:layout.height},pixels:frame.size});
  };

  await phase('default-module-settings');
  await load();await openSettings();await openModules();
  assert.equal(await js(`document.querySelectorAll('.module-settings-row select').length`),5);
  assert.equal(await js(`document.querySelector('select[aria-label="提示词默认角色"]').value`),'general');
  assert.equal(await js(`document.querySelectorAll('.module-settings-row select[aria-label$="模糊强度"]').length`),0);
  assert.deepEqual(await values(),expectedValues(1024,1024));
  const initialRecipe=structuredClone(controller.workspace.project.recipe);
  await phase('save-composition-512');
  await select(moduleSelect('composition'),'512');await waitSaved(512,1024);
  assert.deepEqual(controller.workspace.project.recipe,initialRecipe);

  // A failed IPC save must keep the old select value and stored settings.
  await phase('save-failure-and-retry');
  const beforeFailure=await readFile(settingsFile,'utf8');failNextSave=true;
  await select(moduleSelect('style'),'512');
  await until(()=>visible('.module-settings-body [role=alert]'),'save failure message');
  assert.deepEqual(await values(),expectedValues(512,1024));
  assert.equal(await readFile(settingsFile,'utf8'),beforeFailure);
  assert.deepEqual(settings(),expectedSettings(512,1024));
  assert.equal(await js(`document.querySelectorAll('.module-settings-row select:disabled').length`),0);
  await select(moduleSelect('style'),'512');await waitSaved(512,512);
  assert.equal(await visible('.module-settings-body [role=alert]'),false);
  await select(moduleSelect('style'),'1024');await waitSaved(512,1024);
  assert.equal(saveAttempts,4);assert.equal(savedSettings,3);

  await phase('return-and-reopen');
  await click('返回工作台');await until(async()=>!await visible('.global-settings'),'return to workbench');
  await openSettings();await until(()=>visible('.module-settings-body'),'reopen module settings');
  assert.deepEqual(await values(),expectedValues(512,1024));

  // Reuse the existing model draft guard when leaving the model page.
  await phase('model-draft-cancel-and-discard');
  await click('模型设置','.settings-page-navigation');await until(()=>visible('.settings-model-detail'),'model page');
  await js(`(()=>{const row=document.querySelector('[data-model-id="model_mock_native"]');if(!row)throw Error('Mock model row missing');row.click();})()`);
  await until(()=>js(`document.querySelector('.settings-model-row.selected')?.dataset.modelId==='model_mock_native'`),'select mock model');
  const modelsBefore=structuredClone(controller.workspace.models.snapshot());
  const beforeRatio=modelsBefore.models.find(model=>model.model_config_id==='model_mock_native').defaults.aspect_ratio;
  const draftRatio=beforeRatio==='16:9'?'4:3':'16:9';
  await select('.settings-model-detail .settings-field-grid select',draftRatio);
  await until(()=>js(`document.querySelector('.settings-model-detail .settings-status')?.textContent==='未保存'`),'model draft dirty');
  await click('模块设置','.settings-page-navigation');await until(()=>visible('.app-dialog'),'guard before module page');
  assert.equal(await visible('.module-settings-body'),false);
  await click('继续编辑','.app-dialog');await until(async()=>!await visible('.app-dialog'),'continue editing');
  assert.equal(await js(`document.querySelector('.settings-model-detail .settings-field-grid select')?.value`),draftRatio);
  await click('模块设置','.settings-page-navigation');await until(()=>visible('.app-dialog'),'guard remains active');
  await click('放弃并切换','.app-dialog');await until(()=>visible('.module-settings-body'),'discard and switch');
  assert.deepEqual(controller.workspace.models.snapshot(),modelsBefore);
  assert.deepEqual(await values(),expectedValues(512,1024));

  await phase('preprocess-settings-and-download-retry');
  await select('select[aria-label="构图参考图处理方式"]','blur');
  await until(()=>visible('select[aria-label="构图参考图模糊强度"]'),'blur strength appears');
  await select('select[aria-label="构图参考图模糊强度"]','strong');
  await until(()=>Promise.resolve(settings().composition.blur_strength==='strong'),'blur strength saved');
  await select('select[aria-label="风格参考图处理方式"]','depth');
  await until(()=>visible('.module-settings-resource button'),'missing local resource');
  await click('下载资源','.module-settings-resource');
  await until(()=>visible('.module-settings-body [role=alert]'),'download failure retry path');
  await click('下载资源','.module-settings-resource');
  await until(()=>Promise.resolve(!!releasePrepare),'download pending');
  // The download must not occupy the ordinary editing/saving command queue.
  await select(moduleSelect('style'),'512');
  await until(()=>Promise.resolve(settings().style.max_edge===512),'save while resource download is pending');
  releasePrepare();
  await until(()=>js(`document.querySelector('.module-settings-resource')?.textContent.includes('本地资源已就绪')`),'download complete');
  await select(moduleSelect('style'),'1024');
  await until(()=>Promise.resolve(settings().style.max_edge===1024),'restore style size');
  assert.equal(prepareAttempts,2);
  assert.deepEqual(settings().composition,{max_edge:512,preprocess:'blur',blur_strength:'strong'});
  assert.deepEqual(settings().style,{max_edge:1024,preprocess:'depth',blur_strength:'medium'});
  assert.deepEqual(await diskSettings(),settings());
  await capture(1775,1050);await capture(1120,800);

  // A fresh controller must load settings from disk, not retained React state.
  await phase('controller-restart-and-disk-reload');
  const storedSettings=structuredClone(settings());
  await controller.shutdown();controller=await createController();
  assert.deepEqual(settings(),storedSettings);
  for(const type of ['composition','style'])assert.deepEqual(controller.workspace.project.recipe.modules.find(module=>module.reference_type===type).reference_settings,storedSettings[type],'new workspace inherits persisted '+type+' defaults');
  await load();await openSettings();await openModules();
  assert.deepEqual(await values(),expectedValues(512,1024));
  assert.equal(await js(`document.querySelector('select[aria-label="构图参考图模糊强度"]').value`),'strong');
  await select('select[aria-label="风格参考图处理方式"]','none');
  await until(()=>js(`document.querySelector('select[aria-label="风格参考图处理方式"]')?.value==='none'&&document.querySelectorAll('.module-settings-row select:disabled').length===0`),'style only resize saved');
  await click('返回工作台');

  await phase('editor-preview-and-retry');
  const fixture=path.join(base,'reference.png'),secondFixture=path.join(base,'reference-2.png');
  const sharp=require('sharp');
  const {resizeReferenceImage}=await import('../dist-host/adapters/reference-image.js');
  const {blurReferenceImage}=await import('../dist-host/adapters/blur-preprocessor.js');
  await writeFile(fixture,await sharp(Buffer.from('<svg width="1200" height="900"><rect width="1200" height="900" fill="#efe9d7"/><rect x="120" y="180" width="350" height="570" fill="#47674c"/><circle cx="870" cy="300" r="120" fill="#b46d49"/><path d="M0 790H1200" stroke="#9d987f" stroke-width="50"/></svg>')).png().toBuffer());
  await writeFile(secondFixture,await sharp({create:{width:800,height:1200,channels:3,background:'#5d798b'}}).png().toBuffer());
  const composition=controller.workspace.project.recipe.modules.find(m=>m.reference_type==='composition');
  const imported=await controller.execute({type:'assets:drop',paths:[fixture,secondFixture],module_id:composition.module_id});assert.ok(imported.ok,imported.error);
  await controller.workspace.copyModule(composition.module_id);
  const fixtureRecipe=structuredClone(controller.workspace.project.recipe);
  for(const type of ['subject','style'])fixtureRecipe.modules.find(m=>m.reference_type===type).asset_ids=[fixtureRecipe.modules.find(m=>m.reference_type==='composition').asset_ids[0]];
  // Existing modules own their settings; changing global defaults must not rewrite them.
  const fixtureComposition=fixtureRecipe.modules.find(m=>m.reference_type==='composition');
  const initialReferenceSettings={max_edge:512,preprocess:'blur',blur_strength:'strong'};
  fixtureComposition.reference_settings=structuredClone(initialReferenceSettings);
  fixtureRecipe.modules.find(m=>m.reference_type==='style').reference_settings={max_edge:1024,preprocess:'none',blur_strength:'medium'};
  const secondComposition=fixtureRecipe.modules.find(module=>module.reference_type==='composition'&&module.module_id!==composition.module_id);
  Object.assign(secondComposition,{title:'第二个构图',user_instruction:'第二模块原说明',reference_settings:{max_edge:512,preprocess:'none',blur_strength:'weak'}});
  await controller.workspace.saveRecipe(fixtureRecipe);await controller.refreshState();
  const openEditor=async type=>{await js(`document.querySelector('.module-card.type-${type} .expand-module').click()`);await until(()=>visible('.module-editor'),'open '+type+' editor');};
  const openEditorId=async id=>{await js(`document.querySelector('[data-module-id="'+${JSON.stringify(id)}+'"] .expand-module').click()`);await until(()=>visible('.module-editor'),'open module '+id);};
  const currentModule=id=>controller.workspace.project.recipe.modules.find(m=>m.module_id===id);
  const editorSelect=name=>`.module-editor select[aria-label="当前参考图${name}"]`;
  const editorValues=()=>js(`({max_edge:Number(document.querySelector(${JSON.stringify(editorSelect('最长边'))}).value),preprocess:document.querySelector(${JSON.stringify(editorSelect('处理方式'))}).value,blur_strength:document.querySelector(${JSON.stringify(editorSelect('模糊强度'))})?.value})`);
  const setText=async text=>{await js(`(()=>{const field=document.querySelector('.module-editor textarea');if(field.disabled)throw Error('Preview blocked text editing');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(30);};
  const waitPreview=async(edge,previous)=>{
    await until(()=>js(`(()=>{const img=document.querySelector('.reference-preprocess-image img');return !!img&&img.complete&&Math.max(img.naturalWidth,img.naturalHeight)===${edge}&&${previous?`img.src!==${JSON.stringify(previous)}`:'true'};})()`),'processed preview '+edge);
    return js(`document.querySelector('.reference-preprocess-image img').src`);
  };
  const matchesController=async(moduleId,assetId,draft)=>{
    const url=await js(`document.querySelector('.reference-preprocess-image img').src`);
    const response=await controller.execute({type:'reference:preview',request_id:'preview_smoke_'+Date.now(),project_id:controller.workspace.project.project_id,module_id:moduleId,asset_id:assetId,reference_type:'composition',settings:draft});
    assert.ok(response.ok,response.error);assert.equal(url,response.reference_preview);
    assert.match(url,/^data:image\/png;base64,/);
    const actual=Buffer.from(url.slice(url.indexOf(',')+1),'base64'),asset=controller.workspace.project.assets.find(asset=>asset.asset_id===assetId);
    const clear=await resizeReferenceImage(await controller.workspace.repository.readAsset(asset),draft.max_edge);
    assert.deepEqual(actual,await blurReferenceImage(clear,draft.blur_strength),'preview bytes match the real clear-base and blur pipeline');
    return url;
  };
  const globalBeforeEditor=await readFile(settingsFile,'utf8'),compositionBefore=structuredClone(currentModule(composition.module_id));
  await until(()=>js(`(()=>{const buttons=[...document.querySelectorAll('.image-block-content .chain-reference-preview')];return buttons.length===5&&buttons.every(button=>{const image=button.querySelector('img');return image?.complete&&image.naturalWidth>0;});})()`),'all sidebar references processed');
  const beforeOrdinaryEditors=previewAttempts;
  await openEditor('subject');assert.equal(await visible('.reference-preprocess-preview'),false);await click('取消','.module-editor');
  await openEditor('style');assert.equal(await visible('.reference-preprocess-preview'),true);assert.equal(await visible('.reference-preprocess-image img'),false);assert.equal(await js(`document.querySelector(${JSON.stringify(editorSelect('处理方式'))}).value`),'none');await click('取消','.module-editor');
  assert.equal(previewAttempts,beforeOrdinaryEditors,'subject and resize-only editors do not request their own preview');
  failNextPreview=true;await openEditor('composition');
  await until(()=>visible('.reference-preprocess-error'),'preview failure');
  assert.deepEqual(await editorValues(),initialReferenceSettings);
  const instruction='预览失败后仍可编辑，取消不保存这份草稿';
  await setText(instruction);
  assert.equal(await js(`document.querySelector('.module-editor footer .primary').disabled`),false);
  await click('重试预览','.reference-preprocess-error');
  await waitPreview(512);const sourceUrl=await matchesController(composition.module_id,compositionBefore.asset_ids[0],initialReferenceSettings);
  await clickAria('下一张参考预览');
  await until(()=>js(`document.querySelector('.reference-preprocess-image img')?.naturalHeight===512&&document.querySelector('.reference-preprocess-pages span')?.textContent==='2 / 2'`),'second reference preview');
  await clickAria('上一张参考预览');
  await until(()=>js(`document.querySelector('.reference-preprocess-image img')?.src===${JSON.stringify(sourceUrl)}&&document.querySelector('.reference-preprocess-pages span')?.textContent==='1 / 2'`),'first reference again');

  await phase('editor-draft-options-and-missing-model-recovery');
  await select(editorSelect('最长边'),'1024');let draftUrl=await waitPreview(1024,sourceUrl);
  await select(editorSelect('模糊强度'),'weak');draftUrl=await waitPreview(1024,draftUrl);
  const draftSettings={max_edge:1024,preprocess:'blur',blur_strength:'weak'};
  await matchesController(composition.module_id,compositionBefore.asset_ids[0],draftSettings);
  assert.deepEqual(currentModule(composition.module_id),compositionBefore,'draft preview must not save module data');
  assert.equal(await readFile(settingsFile,'utf8'),globalBeforeEditor);
  const beforeNone=previewAttempts;await select(editorSelect('处理方式'),'none');
  await until(async()=>!await visible('.reference-preprocess-image img'),'none removes preview image');
  assert.equal(await visible('.reference-preprocess-preview'),true);assert.equal(previewAttempts,beforeNone);
  for(const mode of ['depth','segment']){
    await select(editorSelect('处理方式'),mode);await until(()=>visible('.reference-preprocess-error'),mode+' missing resource error');
    assert.equal(await js(`document.querySelector(${JSON.stringify(editorSelect('处理方式'))}).value`),mode);
    assert.equal(await js(`document.querySelector('.module-editor footer .primary').disabled`),false);
  }
  await select(editorSelect('处理方式'),'blur');await waitPreview(1024);
  assert.deepEqual(await editorValues(),draftSettings);

  const captureEditor=async(width,height)=>{
    await phase(`editor-and-lightbox-${width}x${height}`);win.setSize(width,height);await wait(100);await freshFrame('editor resize');
    const layout=await js(`(()=>{const selectors=['.module-editor header','.reference-preprocess-preview','.module-editor textarea','.editor-text small','.module-editor footer',...Array.from(document.querySelectorAll('.reference-preprocess-preview select')).map(el=>'select[aria-label="'+el.getAttribute('aria-label')+'"]')];const boxes=selectors.map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();return {selector,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});const save=document.querySelector('.module-editor footer .primary'),rect=save.getBoundingClientRect(),top=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return {boxes,saveUncovered:save===top||save.contains(top),overflow:[...document.querySelectorAll('.reference-preprocess-preview,.module-editor footer')].filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>el.className)};})()`);
    assert.ok(layout.boxes.every(r=>r.left>=0&&r.top>=0&&r.right<=r.width+1&&r.bottom<=r.height+1),'editor controls visible at '+width);
    assert.deepEqual(layout.overflow,[]);assert.ok(layout.saveUncovered,'save button is not covered');
    assert.ok(layout.boxes.find(r=>r.selector==='.editor-text small').bottom<=layout.boxes.find(r=>r.selector==='.module-editor footer').top,'text count stays above footer');
    const file=path.join(base,`reference-editor-${width}x${height}.png`);await writeFile(file,(await freshFrame('reference editor')).png);screenshots.push({file});
    await clickAria('放大生图参考预览');await until(()=>visible('.reference-preview-lightbox'),'open enlarged preview');
    await until(()=>js(`(()=>{const img=document.querySelector('.reference-preview-lightbox img');return img?.complete&&img.naturalWidth>0&&getComputedStyle(img).visibility==='visible';})()`),'enlarged image decoded');
    assert.equal(await js(`document.querySelector('.reference-preview-lightbox img').src`),await js(`document.querySelector('.reference-preprocess-image img').src`));
    assert.equal(await js(`document.querySelector('.module-editor').closest('[inert]')!==null`),true);
    const large=await js(`(()=>{const el=document.querySelector('.reference-preview-lightbox img'),r=el.getBoundingClientRect(),button=document.querySelector('button[aria-label="关闭参考大图"]'),b=button.getBoundingClientRect();return {fits:r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&b.left>=0&&b.top>=0&&b.right<=innerWidth+1&&b.bottom<=innerHeight+1};})()`);assert.ok(large.fits,'large preview and close button fit viewport');
    const lightbox=path.join(base,`reference-large-${width}x${height}.png`);await writeFile(lightbox,(await freshFrame('reference large')).png);screenshots.push({file:lightbox});
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(async()=>!await visible('.reference-preview-lightbox'),'Escape closes only large preview');
    assert.equal(await visible('.module-editor'),true);assert.equal(await js(`document.querySelector('.module-editor textarea').value`),instruction);assert.deepEqual(await editorValues(),draftSettings);
    await clickAria('放大生图参考预览');await until(()=>visible('.reference-preview-lightbox'),'reopen enlarged preview');await clickAria('关闭参考大图');await until(async()=>!await visible('.reference-preview-lightbox'),'large close button');
  };
  await captureEditor(1120,800);await captureEditor(1775,1050);
  await phase('cancel-reference-draft');
  await click('取消','.module-editor');await until(async()=>!await visible('.module-editor'),'cancel reference draft');
  assert.deepEqual(currentModule(composition.module_id),compositionBefore);assert.equal(await readFile(settingsFile,'utf8'),globalBeforeEditor);
  await openEditorId(composition.module_id);assert.deepEqual(await editorValues(),initialReferenceSettings);
  assert.equal(await js(`document.querySelector('.module-editor textarea').value`),compositionBefore.user_instruction);
  await waitPreview(512);await select(editorSelect('最长边'),'1024');await waitPreview(1024);await select(editorSelect('模糊强度'),'weak');await waitPreview(1024);
  const savedInstruction='模块独立预处理参数已保存';await setText(savedInstruction);
  await click('保存并关闭','.module-editor');await until(async()=>!await visible('.module-editor'),'save module reference settings');
  assert.deepEqual(currentModule(composition.module_id).reference_settings,draftSettings);assert.equal(currentModule(composition.module_id).user_instruction,savedInstruction);
  assert.deepEqual(currentModule(secondComposition.module_id).reference_settings,secondComposition.reference_settings);assert.equal(await readFile(settingsFile,'utf8'),globalBeforeEditor);
  await openEditorId(composition.module_id);assert.deepEqual(await editorValues(),draftSettings);assert.equal(await js(`document.querySelector('.module-editor textarea').value`),savedInstruction);await waitPreview(1024);await click('取消','.module-editor');
  await openEditorId(secondComposition.module_id);assert.equal(await js(`document.querySelector(${JSON.stringify(editorSelect('处理方式'))}).value`),'none');assert.equal(await js(`document.querySelector(${JSON.stringify(editorSelect('最长边'))}).value`),'512');assert.equal(await visible('.reference-preprocess-image img'),false);await click('取消','.module-editor');

  await phase('new-global-default-does-not-rewrite-module');
  await openSettings();await openModules();await select('select[aria-label="构图参考图处理方式"]','none');
  await until(()=>Promise.resolve(settings().composition.preprocess==='none'),'new global default saved');await click('返回工作台');
  assert.deepEqual(currentModule(composition.module_id).reference_settings,draftSettings);
  await openEditorId(composition.module_id);assert.deepEqual(await editorValues(),draftSettings);await waitPreview(1024);await click('取消','.module-editor');
  assert.ok(cancelPreviewAttempts>=3,'obsolete preview work receives cancellation');
  assert.ok(previewRequests.every(request=>request.module_id&&request.settings),'preview commands explicitly carry the module and current draft');
  assert.equal(providerCalls,0);assert.equal(win.isVisible(),false);
  await phase('complete');
  const result={passed:true,base,runtime,settings:structuredClone(settings()),saveAttempts,savedSettings,prepareAttempts,previewAttempts,cancelPreviewAttempts,providerCalls,screenshots,
    checks:['default-1k','independent-change-events','save-failure-and-retry','return-and-reopen','model-draft-cancel-and-discard','blur-strength','download-failure-and-retry','save-during-download','no-clipped-controls','disk-reload','no-settings-page-preview','subject-no-controls-none-has-controls-without-image','preview-failure-and-retry','draft-preview-matches-controller-bytes','multi-image-preview','obsolete-preview-cancellation','draft-mode-size-strength-preview','missing-resource-mode-recovery','cancel-does-not-save','save-and-reopen-module-settings','same-type-modules-independent','module-edit-preserves-global-defaults','global-default-change-preserves-explicit-module','large-preview-close-and-escape-preserve-draft','editor-and-large-preview-two-viewports','save-button-uncovered']};
  const report=path.join(base,'report.json');await writeFile(report,JSON.stringify(result,null,2));
  await controller.shutdown();controller=undefined;win.destroy();
  console.log(JSON.stringify({...result,report}));app.exit(0);
}).catch(async error=>{
  console.error(error);
  if(failureBase){
    await writeFile(path.join(failureBase,'failure.json'),JSON.stringify({stage:lastStage,error:error.stack??String(error),providerCalls},null,2)).catch(diagnosticError=>console.error(diagnosticError));
    if(failureWindow&&!failureWindow.isDestroyed()){
      try{await writeFile(path.join(failureBase,'failure.html'),await failureWindow.webContents.executeJavaScript('document.documentElement.outerHTML'));}catch(diagnosticError){console.error('DOM capture failed:',diagnosticError);}
      try{const frame=await freshFrame?.('failure');if(!frame)throw Error('No offscreen frame available');await writeFile(path.join(failureBase,'failure.png'),frame.png);}catch(diagnosticError){console.error('Failure screenshot failed:',diagnosticError);}
    }
    console.error('Failure stage: '+lastStage+'; artifacts: '+failureBase);
  }
  if(controller)try{await controller.shutdown();}catch{}
  app.exit(1);
});
