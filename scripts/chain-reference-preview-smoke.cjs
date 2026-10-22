// Real Electron renderer + DesktopController, isolated project, zero network.
// Run after npm run build; the test window stays hidden.
const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');
const {mkdtemp,mkdir,readFile,writeFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const sharp=require('sharp');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let base,controller,win,frame,paintSequence=0,stage='startup',providerCalls=0;
globalThis.fetch=async()=>{providerCalls++;throw Error('Network is forbidden in chain-reference smoke');};
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});
  base=await mkdtemp(path.join(root,'.local','chain-reference-ui-'));
  app.setPath('userData',path.join(base,'electron'));
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {registerWindowChrome}=await import('../dist-host/desktop/window-chrome.js');
  const {resizeReferenceImage}=await import('../dist-host/adapters/reference-image.js');
  const {blurReferenceImage}=await import('../dist-host/adapters/blur-preprocessor.js');
  win=new BrowserWindow({width:1775,height:1050,show:false,backgroundColor:'#f6f5f1',
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,offscreen:true}});
  win.setMenuBarVisibility(false);registerWindowChrome(ipcMain,()=>win);
  win.webContents.on('paint',(_event,_dirty,image)=>{if(!image.isEmpty()){frame=image.toPNG();paintSequence++;}});
  win.webContents.setFrameRate(30);
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,callback)=>{providerCalls++;callback({cancel:true});});
  controller=await DesktopController.create(path.join(base,'runtime'),()=>win,{deferStartup:true,projectRoot:base,showMessage:async()=>{throw Error('Unexpected native dialog');}});
  // Allow only the local MockGenerator when exercising the real generation path.
  const executeModel=controller.executors.execute.bind(controller.executors);
  controller.executors.execute=(context,...rest)=>{assert.equal(context.model.kind,'mock');return executeModel(context,...rest);};
  controller.executors.probe=async()=>{throw Error('Unexpected provider probe');};
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  const previews=[],cancellations=[];let activePreviews=0,maxActivePreviews=0,failModule,holdModule,held;
  const allowed=new Set(['state','recipe:save','reference:preview','reference:cancel-preview','project:save']);
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  ipcMain.handle('ediro:command',async(_event,command)=>{
    assert.ok(allowed.has(command.type),'Unexpected renderer command '+command.type);
    if(command.type==='reference:cancel-preview')cancellations.push(command.request_id);
    if(command.type!=='reference:preview')return controller.execute(command);
    previews.push(structuredClone(command));activePreviews++;maxActivePreviews=Math.max(maxActivePreviews,activePreviews);
    try{
      if(failModule===command.module_id){failModule=undefined;return {ok:false,error:'受控预览失败，请重试。'};}
      const shouldHold=holdModule===command.module_id;
      if(shouldHold)holdModule=undefined;
      const response=await controller.execute(command);
      if(shouldHold){
        assert.ok(response.ok,response.error);
        await new Promise(resolve=>{held={request:command,response,release:resolve};});
      }
      return response;
    }finally{activePreviews--;}
  });
  const execute=async command=>{const response=await controller.execute(command);assert.ok(response.ok,response.error);return response;};
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const visible=selector=>js(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const select=async(selector,value)=>{await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Unavailable select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
  const clickText=async(scope,label)=>{await js(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(el=>el.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw Error('Unavailable button '+${JSON.stringify(label)});button.click();})()`);};
  const row=id=>`.image-block-content[data-module-id="${id}"]`;
  const errorRow=id=>row(id)+' + .chain-reference-error';
  const ready=async id=>{await until(()=>js(`(()=>{const img=document.querySelector(${JSON.stringify(row(id)+' img')});return !!img&&img.complete&&img.naturalWidth>0;})()`),'ready '+id);return js(`document.querySelector(${JSON.stringify(row(id)+' img')}).src`);};
  const noImage=id=>js(`document.querySelector(${JSON.stringify(row(id)+' img')})===null`);
  const bytes=url=>Buffer.from(url.slice(url.indexOf(',')+1),'base64');
  const patchModule=async(id,patch)=>{const recipe=structuredClone(controller.workspace.project.recipe);Object.assign(recipe.modules.find(m=>m.module_id===id),patch);await execute({type:'recipe:save',recipe});};
  const screenshots=[];
  const screenshot=async name=>{const before=paintSequence;win.webContents.startPainting();win.webContents.invalidate();await until(()=>Promise.resolve(paintSequence>before&&frame),'fresh frame');await wait(150);const file=path.join(base,name+'.png');await writeFile(file,frame);screenshots.push(file);};

  stage='prepare-fixture';
  const fixture=path.join(base,'用于检查富媒体链长文件名换行及裁切的参考图片-reference.jpg');
  const source=await sharp(Buffer.from('<svg width="1200" height="900"><rect width="1200" height="900" fill="#efe9d7"/><rect x="120" y="180" width="350" height="570" fill="#47674c"/><circle cx="870" cy="300" r="120" fill="#b46d49"/><path d="M0 790H1200" stroke="#9d987f" stroke-width="50"/></svg>')).jpeg().toBuffer();
  await writeFile(fixture,source);
  const composition=controller.workspace.project.recipe.modules.find(m=>m.reference_type==='composition').module_id;
  const style=controller.workspace.project.recipe.modules.find(m=>m.reference_type==='style').module_id;
  const subject=controller.workspace.project.recipe.modules.find(m=>m.reference_type==='subject').module_id;
  await execute({type:'assets:drop',paths:[fixture],module_id:composition});
  const assetId=controller.workspace.project.recipe.modules.find(m=>m.module_id===composition).asset_ids[0];
  const recipe=structuredClone(controller.workspace.project.recipe);
  for(const module of recipe.modules){
    if(['subject','composition','style'].includes(module.reference_type))module.asset_ids=[assetId];
    if(module.reference_type==='prompt'){module.user_instruction='保留产品并参考布局与风格';module.auto_prompt=false;}
  }
  recipe.modules.find(m=>m.module_id===composition).reference_settings={max_edge:512,preprocess:'blur',blur_strength:'strong'};
  recipe.modules.find(m=>m.module_id===style).reference_settings={max_edge:1024,preprocess:'none',blur_strength:'medium'};
  await execute({type:'recipe:save',recipe});
  assert.equal(controller.workspace.models.resolve(recipe.model_config_id).kind,'mock');
  await win.loadFile(path.join(root,'dist','index.html'));

  stage='concurrent-module-previews';
  const compositionUrl=await ready(composition),styleUrl=await ready(style);
  await ready(subject);
  assert.ok(maxActivePreviews>=2,'separate references request previews concurrently');
  assert.notEqual(compositionUrl,styleUrl,'shared source has independent module processing');
  assert.match(compositionUrl,/^data:image\/png;base64,/);assert.match(styleUrl,/^data:image\/png;base64,/);
  assert.deepEqual(bytes(compositionUrl),await blurReferenceImage(await resizeReferenceImage(source,512),'strong'));
  assert.deepEqual(bytes(styleUrl),await resizeReferenceImage(source,1024));
  assert.equal(await js(`document.querySelector(${JSON.stringify(row(composition)+' img')}).naturalWidth`),512);
  assert.equal(await js(`document.querySelector(${JSON.stringify(row(style)+' img')}).naturalWidth`),1024);
  const subjectAsset=(await controller.view()).assets.find(a=>a.asset_id===assetId);
  assert.equal(await js(`document.querySelector(${JSON.stringify(row(subject)+' img')}).src`),subjectAsset.preview_url);
  assert.equal(previews.some(p=>p.module_id===subject),false);

  stage='matches-simulated-generation-request';
  await execute({type:'job:start',allow_degradation:false});
  const job=controller.workspace.project.jobs.at(-1);
  await until(()=>Promise.resolve(['succeeded','failed','cancelled'].includes(job.status)),'local mock generation');
  assert.equal(job.status,'succeeded',job.error);
  const captured=await controller.workspace.repository.loadModelInput(job.task_id);
  assert.equal(captured.body.encoding,'simulation');
  const sent=captured.body.blocks.filter(block=>block.inlineData).map(block=>Buffer.from(block.inlineData.data,'base64'));
  assert.equal(sent.length,3);assert.deepEqual(sent[0],source);assert.deepEqual(sent[1],bytes(compositionUrl));assert.deepEqual(sent[2],bytes(styleUrl));

  stage='editor-save-updates-chain';
  await js(`document.querySelector('.module-card[data-module-id="${composition}"] .expand-module').click()`);
  await until(()=>visible('.module-editor'),'editor open');
  await select('.module-editor select[aria-label="当前参考图最长边"]','1024');
  await select('.module-editor select[aria-label="当前参考图模糊强度"]','weak');
  await until(()=>js(`document.querySelector('.reference-preprocess-image img')?.naturalWidth===1024`),'draft processed');
  assert.equal(await ready(composition),compositionUrl,'unsaved editor draft must not change chain preview');
  await clickText('.module-editor footer','保存并关闭');
  await until(async()=>!await visible('.module-editor'),'editor saved');
  await until(()=>js(`document.querySelector(${JSON.stringify(row(composition)+' img')})?.naturalWidth===1024`),'saved chain updated');
  const savedUrl=await ready(composition);
  assert.deepEqual(bytes(savedUrl),await blurReferenceImage(await resizeReferenceImage(source,1024),'weak'));

  stage='failure-does-not-show-original-and-retry';
  failModule=composition;
  await patchModule(composition,{reference_settings:{max_edge:512,preprocess:'blur',blur_strength:'medium'}});
  await until(()=>visible(errorRow(composition)),'error state');
  assert.equal(await noImage(composition),true,'failed preview cannot fall back to the source');
  await js(`document.querySelector(${JSON.stringify(errorRow(composition)+' button')}).click()`);
  assert.deepEqual(bytes(await ready(composition)),await blurReferenceImage(await resizeReferenceImage(source,512),'medium'));
  await patchModule(composition,{reference_settings:{max_edge:512,preprocess:'depth',blur_strength:'medium'}});
  await until(()=>visible(errorRow(composition)),'missing depth model error');
  assert.equal(await noImage(composition),true);

  stage='late-response-cannot-replace-new-settings';
  holdModule=composition;
  await patchModule(composition,{reference_settings:{max_edge:512,preprocess:'blur',blur_strength:'weak'}});
  await until(()=>Promise.resolve(!!held),'hold completed older response');
  assert.equal(await noImage(composition),true,'pending preview cannot show old pixels');
  const older=held;
  await patchModule(composition,{reference_settings:{max_edge:1024,preprocess:'blur',blur_strength:'strong'}});
  const latestUrl=await ready(composition);
  assert.deepEqual(bytes(latestUrl),await blurReferenceImage(await resizeReferenceImage(source,1024),'strong'));
  await until(()=>Promise.resolve(cancellations.includes(older.request.request_id)),'obsolete request cancellation');
  older.release();await wait(150);
  assert.equal(await ready(composition),latestUrl,'late old response ignored');

  stage='text-only-does-not-display-or-send-style-image';
  await clickText(`.module-card[data-module-id="${style}"] .reference-mode`,'仅描述');
  await until(async()=>!await visible(row(style)),'style image removed from generation chain');
  assert.equal((await controller.view()).chain.blocks.filter(b=>b.type==='image'&&b.source_module_id===style).length,0);
  await clickText(`.module-card[data-module-id="${style}"] .reference-mode`,'图文');
  await ready(style);

  stage='layout-and-large-preview';
  for(const [width,height] of [[1775,1050],[1120,800]]){
    win.setSize(width,height);await wait(150);
    await js(`document.querySelector(${JSON.stringify(row(composition))}).scrollIntoView({block:'center'});`);
    const layout=await js(`(()=>{const rows=[...document.querySelectorAll('.image-block-content')];return {overflow:rows.filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>el.dataset.moduleId),badImages:rows.flatMap(el=>[...el.querySelectorAll('img')]).filter(el=>{const r=el.getBoundingClientRect();return r.width<=0||r.height<=0||r.left<0||r.right>innerWidth+1;}).length};})()`);
    assert.deepEqual(layout.overflow,[]);assert.equal(layout.badImages,0);
    await screenshot(`chain-${width}x${height}`);
    await js(`document.querySelector(${JSON.stringify(row(composition)+' .chain-reference-preview')}).click()`);
    await until(()=>visible('.reference-preview-lightbox'),'large preview open');
    await until(()=>js(`(()=>{const img=document.querySelector('.reference-preview-lightbox img');return img?.complete&&img.naturalWidth>0;})()`),'large decoded');
    assert.equal(await js(`document.querySelector('.reference-preview-lightbox img').src`),latestUrl);
    const fits=await js(`(()=>{const image=document.querySelector('.reference-preview-lightbox img'),close=document.querySelector('button[aria-label="关闭参考大图"]');return [image,close].every(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;});})()`);
    assert.equal(fits,true);await screenshot(`chain-large-${width}x${height}`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(async()=>!await visible('.reference-preview-lightbox'),'Escape closes large preview');
  }
  assert.equal(providerCalls,0);assert.equal(win.isVisible(),false);
  const report={passed:true,base,providerCalls,maxActivePreviews,previewRequests:previews.length,cancelRequests:cancellations.length,screenshots,
    checks:['independent-concurrent-previews','same-asset-distinct-settings','none-clear-resize','original-subject-thumbnail','matches-captured-mock-request-bytes','editor-draft-does-not-change-chain','editor-save-refreshes-chain','preview-failure-no-original-fallback','retry','missing-depth-model-no-fallback','stale-response-ignored','obsolete-preview-cancelled','text-only-removes-image','same-large-preview-pixels','Escape-closes-preview','two-viewports-no-horizontal-overflow']};
  await writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));
  await controller.shutdown();controller=undefined;win.destroy();console.log(JSON.stringify(report));app.exit(0);
}).catch(async error=>{
  console.error('Stage: '+stage,error);
  if(base){await writeFile(path.join(base,'failure.json'),JSON.stringify({stage,error:error.stack??String(error),providerCalls},null,2)).catch(()=>{});if(frame)await writeFile(path.join(base,'failure.png'),frame).catch(()=>{});}
  if(controller)await controller.shutdown().catch(()=>{});
  app.exit(1);
});
