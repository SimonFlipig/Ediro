// Real hidden Electron renderer + DesktopController, with isolated runtime data.
// Run with Electron after npm run build. No user settings or provider are read.
const {app,BrowserWindow,ipcMain,protocol,net,dialog}=require('electron');
const {mkdir,mkdtemp,writeFile,appendFile,readFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),sharp=require('sharp');
const {Script}=require('node:vm');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let controller,win,base,lastFrame,frameSequence=0,lastStage='startup',providerCalls=0,lastRendererScript='';
const captures=[],commands=[],responses=[],inferences=[],nativeDialogs=[],openPaths=[],savePaths=[],rendererErrors=[],rendererConsole=[];
const emptyCustomizations=()=>({version:1,modules:{},roles:{}});
globalThis.fetch=async()=>{providerCalls++;throw Error('External requests are forbidden in prompt-settings smoke.');};
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});
dialog.showOpenDialog=async(...args)=>{
  assert.ok(openPaths.length,'Unexpected native open dialog');
  const filePath=openPaths.shift();nativeDialogs.push({kind:'open',title:args.at(-1)?.title,filePath});
  return filePath?{canceled:false,filePaths:[filePath]}:{canceled:true,filePaths:[]};
};
dialog.showSaveDialog=async(...args)=>{
  assert.ok(savePaths.length,'Unexpected native save dialog');
  const filePath=savePaths.shift();nativeDialogs.push({kind:'save',title:args.at(-1)?.title,filePath});
  return filePath?{canceled:false,filePath}:{canceled:true};
};
dialog.showMessageBox=async()=>{throw Error('Unexpected native message dialog in prompt-settings smoke.');};

app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});
  base=await mkdtemp(path.join(root,'.local','prompt-settings-ui-'));
  app.setPath('userData',path.join(base,'electron'));
  const runtime=path.join(base,'runtime');
  const phase=async name=>{lastStage=name;await appendFile(path.join(base,'stages.jsonl'),JSON.stringify({stage:name,time:new Date().toISOString()})+'\n');};
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {registerWindowChrome}=await import('../dist-host/desktop/window-chrome.js');
  const {promptRoles}=await import('../dist-host/core/prompt-roles.js');
  win=new BrowserWindow({width:1775,height:1050,show:false,backgroundColor:'#f6f5f1',
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,offscreen:true}});
  win.setMenuBarVisibility(false);registerWindowChrome(ipcMain,()=>win);
  win.webContents.on('paint',(_event,_dirty,image)=>{if(!image.isEmpty()){lastFrame={png:image.toPNG(),size:image.getSize()};frameSequence++;}});
  win.webContents.setFrameRate(30);
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{providerCalls++;callback({cancel:true});});
  win.webContents.on('preload-error',(_event,_file,error)=>rendererErrors.push(error.message));
  win.webContents.on('console-message',details=>{
    const entry={stage:lastStage,level:details.level,message:details.message,line:details.lineNumber,source:details.sourceId};
    rendererConsole.push(entry);if(details.level==='error')rendererErrors.push(details.message);
  });
  win.webContents.on('render-process-gone',(_event,details)=>rendererErrors.push('Renderer process gone: '+JSON.stringify(details)));
  const createController=async()=>{
    const next=await DesktopController.create(runtime,()=>win,{deferStartup:true,projectRoot:base,showMessage:async()=>{throw Error('Unexpected controller dialog in prompt-settings smoke.');}});
    next.workspace.models.adapters.push({adapter_id:'smoke-understanding',version:1,title:'提示词设置测试模型',kind:'mock',installed:true,purposes:['understanding'],requires_credential:false,supports_probe:false,interleaving:['native','separated'],operations:['understand'],parameters:[]});
    next.executors.probe=async()=>{providerCalls++;throw Error('No provider discovery in smoke.');};
    next.executors.execute=async(context,signal)=>{
      assert.equal(context.model.kind,'mock');assert.equal(context.model.purpose,'understanding','smoke never requests image generation');
      assert.equal(signal.aborted,false);
      for(const image of context.job.chain_snapshot.blocks.filter(block=>block.type==='image'))assert.ok((await context.readImage(image.asset_id)).length);
      inferences.push(structuredClone(context.job));
      return {images:[],text:`设置验证结果 ${inferences.length}：保持商品结构，用柔和光线突出主体。`};
    };
    return next;
  };
  controller=await createController();
  const factoryStyle=controller.workspace.registry.get('style').base_instruction;
  const factoryTexts=[...controller.workspace.registry.list().flatMap(definition=>[definition.base_instruction,definition.numbered_instruction]),...promptRoles.map(role=>role.instruction)].filter(text=>text&&text.length>20);
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  const allowed=new Set(['state','recipe:save','project:save','reference:preview','reference:cancel-preview','prompt-customizations:save','prompt-customizations:import','prompt-customizations:export']);
  ipcMain.handle('ediro:command',async(_event,command)=>{
    commands.push(command.type);
    try{
      assert.ok(allowed.has(command.type),'Unexpected UI command '+command.type);
      const response=await controller.execute(command);responses.push({type:command.type,ok:response.ok,error:response.error,cancelled:response.cancelled});return response;
    }catch(error){responses.push({type:command.type,ok:false,error:error.stack??String(error),bridgeError:true});throw error;}
  });
  const execute=async command=>{const response=await controller.execute(command);assert.equal(response.ok,true,response.error);return response;};
  const js=async code=>{
    lastRendererScript=`(()=>{try{return {ok:true,value:(${code})};}catch(error){return {ok:false,error:error.stack??String(error)};}})()`;
    try{
      // Validate generated snippets before Electron can replace syntax errors
      // with its generic "Script failed to execute" exception.
      new Script(lastRendererScript,{filename:'prompt-settings-renderer-check.js'});
      const result=await win.webContents.executeJavaScript(lastRendererScript);
      if(!result.ok)throw Error(result.error);return result.value;
    }catch(error){throw Error(`Renderer check failed during ${lastStage}: ${error.stack??String(error)}\nExpression:\n${code}`,{cause:error});}
  };
  const until=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const click=async selector=>{
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Control unavailable: '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});el.click();})()`);await wait(35);
  };
  const clickLabel=async(label,scope='.global-settings')=>{
    await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Button unavailable: '+${JSON.stringify(label)});el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});el.click();})()`);await wait(35);
  };
  const setValue=async(selector,value)=>{
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Field unavailable: '+${JSON.stringify(selector)});const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;el.focus();Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));el.blur();})()`);await wait(35);
  };
  const load=async()=>{await win.loadFile(path.join(root,'dist','index.html'));await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'renderer loaded');};
  const customizations=async()=>(await controller.view()).prompt_customizations;
  const current=type=>controller.workspace.project.recipe.modules.find(module=>module.reference_type===type);
  const assertFactoryHidden=async()=>{
    const parts=await js(`(()=>{const panel=document.querySelector('.global-settings');return [panel.innerText,...[...panel.querySelectorAll('textarea,input')].map(el=>el.value)];})()`);
    const content=parts.join('\n');
    const normalized=content.replace(/\s+/g,' ');
    for(const factory of factoryTexts)assert.ok(!normalized.includes(factory.replace(/\s+/g,' ')),'Factory instruction must not be rendered in settings: '+factory.slice(0,45));
  };
  const waitCommand=async(type,count)=>until(()=>Promise.resolve(responses.filter(item=>item.type===type).length>count),type+' completed');
  const lastResponse=type=>responses.findLast(item=>item.type===type);
  const screenshot=async(width,height,label)=>{
    win.setSize(width,height);await wait(120);
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before=frameSequence;win.webContents.startPainting();win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>before&&lastFrame?.png.length),'fresh settings screenshot');
    await wait(120);const settled=frameSequence;win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>settled&&lastFrame?.png.length),'settled settings screenshot');
    const layout=await js(`(()=>{
      const panel=document.querySelector('.global-settings'),clipped=[];
      for(const el of panel.querySelectorAll('button,input,textarea,select')){
        const b=el.getBoundingClientRect();if(!b.width||!b.height)continue;
        if(b.left<-.5||b.right>innerWidth+.5)clipped.push(el.getAttribute('aria-label')||el.textContent.trim());
      }
      return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,panelWidth:panel.scrollWidth,panelClientWidth:panel.clientWidth,clipped};
    })()`);
    assert.ok(layout.documentWidth<=layout.width+1,'Page must not overflow horizontally');
    assert.ok(layout.panelWidth<=layout.panelClientWidth+1,'Settings must not overflow horizontally');
    assert.deepEqual(layout.clipped,[],'Settings controls must fit viewport width');assert.equal(win.isVisible(),false);
    const file=path.join(base,`prompt-settings-${label}-${width}x${height}.png`);await writeFile(file,lastFrame.png);captures.push({file,layout,pixels:lastFrame.size});
  };

  await phase('prepare-isolated-project');
  const sourceModel=controller.workspace.models.snapshot().models.find(model=>model.model_config_id==='model_mock_native');
  await controller.workspace.models.saveModel({...sourceModel,model_config_id:'model_smoke_understanding',model:'smoke-understanding',title:'本地设置验证推理',adapter_id:'smoke-understanding',purpose:'understanding',capabilities:{...sourceModel.capabilities,operations:['understand']}});
  await controller.workspace.models.assign('understanding','model_smoke_understanding');
  for(const [type,color] of [['subject','#447359'],['composition','#8b6b54'],['style','#7c6a9c']]){
    const filename=path.join(base,`${type}.png`);await writeFile(filename,await sharp({create:{width:128,height:96,channels:3,background:color}}).png().toBuffer());
    await execute({type:'assets:drop',paths:[filename],module_id:current(type).module_id});
  }
  const recipe=structuredClone(controller.workspace.project.recipe),prompt=recipe.modules.find(module=>module.reference_type==='prompt');
  prompt.auto_prompt=true;prompt.prompt_role='merchandiser';
  await execute({type:'recipe:save',recipe});await execute({type:'project:save'});
  const infer=async()=>execute({type:'module:infer',request_id:'infer_settings_'+(inferences.length+1),project_id:controller.workspace.project.project_id,module_id:current('prompt').module_id,model_config_id:'model_smoke_understanding',text:current('prompt').user_instruction,allow_text_only:false,automatic:true});
  await infer();assert.equal((await controller.view()).auto_prompt.needs_inference,false);
  assert.deepEqual(await customizations(),emptyCustomizations());
  await load();

  const openCore=async()=>{
    await click('.settings-button');await clickLabel('核心指令','.settings-page-navigation');
    await until(()=>js(`!!document.querySelector('.prompt-settings')`),'core instruction settings');
  };
  const selectItem=async item=>{await click(`[data-prompt-item="${item}"]`);await until(()=>js(`document.querySelector(${JSON.stringify(`[data-prompt-item="${item}"]`)})?.getAttribute('aria-pressed')==='true'`),'selected '+item);};
  const previewText=kind=>js(`document.querySelector(${JSON.stringify(`[data-prompt-preview="${kind}"]`)})?.innerText??''`);
  const previewProse=async kind=>(await js(`[...document.querySelectorAll(${JSON.stringify(`[data-prompt-preview="${kind}"] pre`)})].map(el=>el.textContent)`)).join('\n');
  const apply=async expected=>{
    const count=responses.filter(item=>item.type==='prompt-customizations:save').length;
    await clickLabel('保存并应用','.prompt-settings-savebar');await waitCommand('prompt-customizations:save',count);
    assert.equal(lastResponse('prompt-customizations:save').ok,true,lastResponse('prompt-customizations:save').error);
    await until(async()=>JSON.stringify(await customizations())===JSON.stringify(expected),'customizations applied');
    await until(()=>js(`!document.querySelector('.prompt-settings')?.getAttribute('aria-busy')&&[...document.querySelectorAll('.prompt-settings-savebar button')].find(el=>el.textContent.trim()==='保存并应用')?.disabled===true`),'saved UI settled');
  };
  const expectApplied=async expected=>assert.deepEqual(await customizations(),expected);
  const expectNoDialog=()=>until(()=>js(`!document.querySelector('.app-dialog')`),'dialog closed');
  const activeStyleText=async()=>(await controller.view()).chain.blocks.find(block=>block.type==='text'&&block.text_role==='instruction'&&block.reference_type==='style');

  await phase('defaults-hidden-and-current-item-empty');
  await openCore();await assertFactoryHidden();
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),'');
  assert.equal(await js(`document.querySelector('#prompt-numbered_instruction').value`),'');
  assert.equal(await previewText('native'),'');assert.equal(await previewText('numbered'),'');
  await selectItem('role:merchandiser');
  assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),'');
  assert.equal(await previewText('role'),'');await assertFactoryHidden();

  await phase('single-module-native-and-numbered-preview');
  await selectItem('module:style');await setValue('select[aria-label="试编译图片数"]',2);
  let native='SMOKE_NATIVE: use the lighting from {images}; keep this custom style instruction isolated.';
  const numbered='SMOKE_NUMBERED: use only the color palette from {images}.';
  await click('input[aria-label="自定义原生图文顺序"]');await setValue('#prompt-native_instruction',native);
  assert.equal(await previewProse('native'),native.replace('{images}','image_1, image_2'));
  assert.equal(await previewText('numbered'),'','Uncustomized numbered expression must remain empty');
  assert.deepEqual(await js(`[...document.querySelectorAll('[data-prompt-preview="native"] .prompt-preview-image')].map(el=>el.textContent.trim())`),['▧ image_1','▧ image_2']);
  await expectApplied(emptyCustomizations());
  await click('input[aria-label="自定义文字＋图片集合"]');await setValue('#prompt-numbered_instruction',numbered);
  assert.equal(await previewProse('numbered'),numbered.replace('{images}','image_1, image_2'));
  assert.doesNotMatch(await previewText('numbered'),/SMOKE_NATIVE/);assert.doesNotMatch(await previewText('native'),/SMOKE_NUMBERED/);
  await assertFactoryHidden();
  // Changing the selected item retains the global draft, but its preview must
  // be based solely on the newly selected item, never the workbench project.
  await selectItem('module:subject');
  assert.equal(await previewText('native'),'');assert.equal(await previewText('numbered'),'');
  await selectItem('module:style');assert.match(await previewText('native'),/SMOKE_NATIVE/);
  await screenshot(1775,1050,'module-draft');await screenshot(1120,800,'module-draft');
  let saved={version:1,modules:{style:{native_instruction:native,numbered_instruction:numbered}},roles:{}};
  await apply(saved);
  const actualStyle=await activeStyleText();
  assert.match(actualStyle.text,/SMOKE_NATIVE: use the lighting from image_3/,'Real execution retains full-project image order');
  assert.match(actualStyle.numbered_text,/SMOKE_NUMBERED: use only the color palette from image_3/);
  assert.deepEqual(JSON.parse(await readFile(path.join(runtime,'prompt-customizations.v1.json'),'utf8')),saved);

  await phase('invalid-template-and-unsaved-navigation-guard');
  await setValue('#prompt-native_instruction',native+' {unknown}');
  assert.ok(await js(`!!document.querySelector('.prompt-settings [role="alert"]')`),'Invalid placeholder is shown');
  assert.equal(await js(`[...document.querySelectorAll('.prompt-settings-savebar button')].find(el=>el.textContent.trim()==='保存并应用').disabled`),true);
  await expectApplied(saved);await clickLabel('还原未应用修改','.prompt-settings-savebar');
  await setValue('#prompt-native_instruction',native+' UNSAVED_DISCARD');
  await clickLabel('模块设置','.settings-page-navigation');
  await until(()=>js(`document.querySelector('.app-dialog')?.textContent.includes('核心指令尚未应用')`),'navigation guard');
  await clickLabel('继续编辑','.app-dialog');await expectNoDialog();
  assert.match(await js(`document.querySelector('#prompt-native_instruction').value`),/UNSAVED_DISCARD/);await expectApplied(saved);
  await clickLabel('模块设置','.settings-page-navigation');await clickLabel('放弃修改','.app-dialog');await expectNoDialog();
  await until(()=>js(`!!document.querySelector('.global-settings[aria-label="模块设置"]')`),'module settings reached');
  await clickLabel('核心指令','.settings-page-navigation');await selectItem('module:style');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),native);
  native+=' SAVED_BY_GUARD';await setValue('#prompt-native_instruction',native);
  await clickLabel('返回工作台','.settings-page-actions');
  await until(()=>js(`!!document.querySelector('.app-dialog')`),'leave settings guard');
  await clickLabel('保存并继续','.app-dialog');await expectNoDialog();
  await until(()=>js(`!document.querySelector('.global-settings')`),'workbench after guarded save');
  saved={...saved,modules:{style:{native_instruction:native,numbered_instruction:numbered}}};await expectApplied(saved);
  await openCore();await selectItem('module:style');

  await phase('export-customizations-only');
  const exported=path.join(base,'custom-instructions.json');savePaths.push(exported);
  let count=responses.filter(item=>item.type==='prompt-customizations:export').length;
  await clickLabel('导出配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:export',count);
  assert.deepEqual(JSON.parse(await readFile(exported,'utf8')),saved,'Export contains only user overrides');
  await expectApplied(saved);assert.equal(inferences.length,1,'Preview, saving, and export must not run inference');

  await phase('role-customization-invalidates-and-enters-real-inference-plan');
  await infer();assert.equal((await controller.view()).auto_prompt.needs_inference,false);
  const priorKey=current('prompt').auto_prompt_input_key,callsBeforeRole=inferences.length;
  await selectItem('role:merchandiser');
  await click('input[aria-label="自定义角色指令"]');
  const role='ROLE_CUSTOM_SMOKE: arrange only two neutral props and soft side lighting; preserve all explicit product requirements.';
  await setValue('#prompt-role-instruction',role);
  assert.equal(await previewProse('role'),role);assert.equal(await js(`document.querySelectorAll('[data-prompt-preview="native"],[data-prompt-preview="numbered"]').length`),0);
  await assertFactoryHidden();await screenshot(1775,1050,'role-draft');await screenshot(1120,800,'role-draft');
  saved={...saved,roles:{merchandiser:role}};await apply(saved);
  assert.equal(inferences.length,callsBeforeRole,'Applying a role never spends an inference call');
  assert.equal(current('prompt').auto_prompt_input_key,priorKey,'Existing generated text keeps its historical input key');
  assert.equal((await controller.view()).auto_prompt.needs_inference,true,'Changed role content invalidates old automatic result');
  await infer();
  const inferenceText=inferences.at(-1).chain_snapshot.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  assert.ok(inferenceText.includes(role));assert.ok(!inferenceText.includes(promptRoles.find(item=>item.id==='merchandiser').instruction),'Custom role replaces the factory role');
  assert.equal((await controller.view()).auto_prompt.needs_inference,false);
  assert.notEqual(current('prompt').auto_prompt_input_key,priorKey);
  const generationText=(await controller.view()).chain.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  assert.ok(!generationText.includes(role),'Role instructions must not enter the image-generation chain');

  await phase('customizations-survive-controller-and-renderer-restart');
  await execute({type:'project:save'});const record=(await controller.view()).project_record_id;
  assert.ok(record);await controller.shutdown();controller=await createController();
  await execute({type:'workspace:resume',id:record});await load();await expectApplied(saved);
  assert.equal((await controller.view()).auto_prompt.needs_inference,false,'Restart preserves role-aware reuse');
  await openCore();await selectItem('role:merchandiser');
  assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),role);await assertFactoryHidden();

  await phase('invalid-import-preserves-current-and-draft-values');
  const invalid=path.join(base,'invalid-custom-instructions.json');
  await writeFile(invalid,JSON.stringify({version:999,modules:{style:{native_instruction:'INVALID_IMPORT_MUST_NOT_APPLY'}},roles:{}}));
  openPaths.push(invalid);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,false);await expectApplied(saved);
  assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),role);
  await until(()=>js(`!!document.querySelector('.prompt-settings-error[role="alert"]')`),'invalid import error shown');
  assert.deepEqual(JSON.parse(await readFile(path.join(runtime,'prompt-customizations.v1.json'),'utf8')),saved);

  await phase('valid-import-is-draft-until-explicit-application');
  openPaths.push(exported);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,true,lastResponse('prompt-customizations:import').error);await expectApplied(saved);
  await until(()=>js(`document.querySelector('[data-prompt-item="module:style"]')?.getAttribute('aria-pressed')==='true'`),'imported style selected');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),native);
  await selectItem('role:merchandiser');assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),'','Imported export has no role override');
  assert.equal(await previewText('role'),'');
  saved={...saved,roles:{}};await apply(saved);
  openPaths.push(null);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').cancelled,true);await expectApplied(saved);

  await phase('restore-current-and-all-defaults-explicitly');
  await selectItem('module:style');await clickLabel('恢复此项默认','.prompt-settings-current');
  assert.equal(await previewText('native'),'');assert.equal(await previewText('numbered'),'');await expectApplied(saved);
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),'');await assertFactoryHidden();
  await clickLabel('还原未应用修改','.prompt-settings-savebar');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),native);await expectApplied(saved);
  await clickLabel('全部恢复默认','.prompt-settings-transfer');
  await until(()=>js(`document.querySelector('.app-dialog')?.textContent.includes('恢复全部默认指令')`),'reset confirmation');
  await clickLabel('取消','.app-dialog');await expectNoDialog();await expectApplied(saved);
  await clickLabel('全部恢复默认','.prompt-settings-transfer');await clickLabel('恢复默认','.app-dialog');await expectNoDialog();
  await expectApplied(saved);assert.equal(await previewText('native'),'');assert.equal(await previewText('numbered'),'');
  await apply(emptyCustomizations());
  assert.equal(controller.workspace.registry.get('style').base_instruction,factoryStyle,'Reset restores this release\'s factory instruction');
  await assertFactoryHidden();
  const afterReset=path.join(base,'empty-custom-instructions.json');savePaths.push(afterReset);
  count=responses.filter(item=>item.type==='prompt-customizations:export').length;
  await clickLabel('导出配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:export',count);
  assert.deepEqual(JSON.parse(await readFile(afterReset,'utf8')),emptyCustomizations(),'Reset export must not expose factory instructions');
  await screenshot(1775,1050,'restored-defaults');await screenshot(1120,800,'restored-defaults');

  assert.equal(providerCalls,0);assert.equal(win.isVisible(),false);assert.deepEqual(rendererErrors,[]);
  assert.deepEqual(openPaths,[]);assert.deepEqual(savePaths,[]);
  await phase('complete');
  const report={passed:true,base,runtime,providerCalls,inferenceCalls:inferences.length,commands,responses,nativeDialogs,captures,rendererConsole,
    checks:['isolated-runtime-and-project','factory-text-not-in-dom-or-fields','empty-default-previews','only-current-item-preview','preview-image-placeholders-from-one','native-and-numbered-independent','preview-does-not-apply','real-compilation-retains-project-image-order','save-applies-and-persists','invalid-template-not-applied','dirty-navigation-continue-discard-save','export-overrides-only','role-preview-not-generation-preview','role-change-invalidates-auto-prompt','role-customization-in-real-inference-plan','role-not-in-image-generation','no-automatic-inference-on-settings-change','restart-persistence-and-auto-reuse','invalid-import-preserves-runtime-and-draft','valid-import-draft-only','cancel-import-preserves-values','restore-current-is-reversible-draft','reset-all-requires-apply','reset-restores-release-defaults','reset-export-empty','both-viewports-no-horizontal-overflow','no-network']};
  const filename=path.join(base,'report.json');await writeFile(filename,JSON.stringify(report,null,2));
  await controller.shutdown();controller=undefined;win.destroy();console.log(JSON.stringify({...report,report:filename}));app.exit(0);
}).catch(async error=>{
  console.error(error);
  if(base){
    await writeFile(path.join(base,'failure.json'),JSON.stringify({stage:lastStage,error:error.stack??String(error),providerCalls,inferenceCalls:inferences.length,commands,responses,nativeDialogs,rendererErrors,rendererConsole,lastRendererScript},null,2)).catch(()=>{});
    if(lastRendererScript)await writeFile(path.join(base,'failure-renderer-check.js'),lastRendererScript).catch(()=>{});
    if(win&&!win.isDestroyed()){
      await writeFile(path.join(base,'failure.html'),await win.webContents.executeJavaScript('document.documentElement.outerHTML')).catch(()=>{});
      if(lastFrame)await writeFile(path.join(base,'failure.png'),lastFrame.png).catch(()=>{});
    }
    console.error('Failure stage: '+lastStage+'; artifacts: '+base);
  }
  if(controller)try{await controller.shutdown();}catch{}
  app.exit(1);
});
