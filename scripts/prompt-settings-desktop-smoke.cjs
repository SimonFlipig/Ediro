// Real hidden Electron renderer + DesktopController, with isolated runtime data.
// Run with Electron after npm run build. No user settings or provider are read.
const {app,BrowserWindow,ipcMain,protocol,net,dialog}=require('electron');
const {mkdir,mkdtemp,writeFile,appendFile,readFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),sharp=require('sharp');
const {Script}=require('node:vm');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let controller,win,base,lastFrame,lastScreenshotLayout,frameSequence=0,lastStage='startup',providerCalls=0,lastRendererScript='';
const captures=[],commands=[],responses=[],inferences=[],nativeDialogs=[],openPaths=[],savePaths=[],rendererErrors=[],rendererConsole=[];
const emptyCustomizations=()=>({version:1,modules:{},roles:{}});
const requestedScaleFactor=process.env.EDIRO_SMOKE_SCALE_FACTOR?.trim()?Number(process.env.EDIRO_SMOKE_SCALE_FACTOR):null;
if(requestedScaleFactor!==null){
  assert.ok(Number.isFinite(requestedScaleFactor)&&requestedScaleFactor>0&&requestedScaleFactor<=4,'EDIRO_SMOKE_SCALE_FACTOR must be a number greater than 0 and at most 4');
}
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
  const {presetTarget}=await import('../dist-host/core/prompt-settings.js');
  const {defaultModuleInferenceInstructions}=await import('../dist-host/core/module-inference-instructions.js');
  win=new BrowserWindow({width:1775,height:1050,show:false,backgroundColor:'#f6f5f1',
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,offscreen:requestedScaleFactor===null?true:{deviceScaleFactor:requestedScaleFactor}}});
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
  const factoryInstructions=Object.fromEntries(['subject','composition','style','viewpoint'].map(type=>{const definition=controller.workspace.registry.get(type);return [type,{native_instruction:definition.base_instruction,numbered_instruction:definition.numbered_instruction??definition.base_instruction}];}));
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  const allowed=new Set(['state','recipe:save','project:save','reference:preview','reference:cancel-preview','prompt-customizations:save','prompt-settings:save','prompt-presets:save','prompt-customizations:import','prompt-customizations:export']);
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
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||el.readOnly||el.closest('[inert]'))throw Error('Field unavailable: '+${JSON.stringify(selector)});const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;el.focus();Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));el.blur();})()`);await wait(35);
  };
  const load=async()=>{await win.loadFile(path.join(root,'dist','index.html'));await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'renderer loaded');};
  const customizations=async()=>(await controller.view()).prompt_customizations;
  const settings=async()=>(await controller.view()).prompt_settings;
  const persistedSettings=async()=>JSON.parse(await readFile(path.join(runtime,'prompt-settings.v2.json'),'utf8'));
  const current=type=>controller.workspace.project.recipe.modules.find(module=>module.reference_type===type);
  const assertDefaultField=async(selector,expected)=>{
    const field=await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return {value:el.value,readOnly:el.readOnly,disabled:el.disabled};})()`);
    assert.equal(field.value,expected,'Default field displays the real release instruction');
    assert.equal(field.readOnly,true,'Default instruction is read-only');
    assert.equal(field.disabled,false,'Read-only defaults remain selectable and scrollable');
  };
  const waitCommand=async(type,count)=>until(()=>Promise.resolve(responses.filter(item=>item.type===type).length>count),type+' completed');
  const lastResponse=type=>responses.findLast(item=>item.type===type);
  const screenshot=async(width,height,label)=>{
    win.setSize(width,height);await wait(120);
    const inspectDefaultEditor=label==='default-instructions'||label==='restored-defaults';
    if(inspectDefaultEditor)await js(`(()=>{for(const el of document.querySelectorAll('.prompt-settings-editor,.prompt-settings-workspace'))el.scrollTop=0;})()`);
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before=frameSequence;win.webContents.startPainting();win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>before&&lastFrame?.png.length),'fresh settings screenshot');
    await wait(120);const settled=frameSequence;win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>settled&&lastFrame?.png.length),'settled settings screenshot');
    const layout=await js(`(()=>{
      const panel=document.querySelector('.global-settings'),clipped=[];
      const rect=el=>{if(!el)return null;const b=el.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};};
      for(const el of panel.querySelectorAll('button,input,textarea,select')){
        const b=el.getBoundingClientRect();if(!b.width||!b.height)continue;
        if(b.left<-.5||b.right>innerWidth+.5)clipped.push(el.getAttribute('aria-label')||el.textContent.trim());
      }
      const editor=document.querySelector('.prompt-settings-editor');
      return {width:innerWidth,height:innerHeight,devicePixelRatio,documentWidth:document.documentElement.scrollWidth,panelWidth:panel.scrollWidth,panelClientWidth:panel.clientWidth,clipped,
        toolbar:{bounds:rect(document.querySelector('.prompt-settings-intro')),title:rect(document.querySelector('.prompt-settings-intro h2')),actions:rect(document.querySelector('.prompt-settings-transfer')),buttons:[...document.querySelectorAll('.prompt-settings-transfer button')].map(rect)},
        context:{bounds:rect(document.querySelector('.prompt-settings-context')),current:rect(document.querySelector('.prompt-settings-context .prompt-settings-current')),preset:rect(document.querySelector('.prompt-settings-context .prompt-preset-bar'))},
        editor:{bounds:rect(editor),scrollTop:editor?.scrollTop,workspace:rect(document.querySelector('.prompt-settings-workspace')),savebar:rect(document.querySelector('.prompt-settings-savebar')),fields:[...document.querySelectorAll('.prompt-settings-editor textarea')].map(rect),templateHelp:rect(document.querySelector('.prompt-template-help')),emptyHint:rect(document.querySelector('.prompt-empty-hint'))}};
    })()`);
    lastScreenshotLayout=layout;
    assert.ok(layout.documentWidth<=layout.width+1,'Page must not overflow horizontally');
    assert.ok(layout.panelWidth<=layout.panelClientWidth+1,'Settings must not overflow horizontally');
    assert.deepEqual(layout.clipped,[],'Settings controls must fit viewport width');assert.equal(win.isVisible(),false);
    if(layout.width>=1100){
      const {bounds,title,actions,buttons}=layout.toolbar;
      assert.ok(bounds&&title&&actions&&buttons.length,'Compact settings toolbar contains its title and actions');
      assert.ok(Math.min(title.bottom,actions.bottom)>Math.max(title.top,actions.top),'Toolbar title and actions share one row');
      assert.ok(Math.min(...buttons.map(button=>button.bottom))>Math.max(...buttons.map(button=>button.top)),'Toolbar action buttons remain on one row');
      assert.ok(bounds.height<=Math.max(title.height,...buttons.map(button=>button.height))*2.5,'Toolbar height stays proportionate to its controls rather than forming a tall hero');
      const {bounds:context,current,preset}=layout.context;
      assert.ok(context&&current&&preset,'Module or role title and preset controls share a context wrapper');
      assert.ok(current.right<=preset.left+1,'Module or role title and preset controls are arranged side by side');
      assert.ok(Math.min(current.bottom,preset.bottom)>Math.max(current.top,preset.top),'Module or role title and preset controls overlap vertically in the same row');
    }
    if(inspectDefaultEditor&&width===1775&&height===1050){
      const editor=layout.editor;
      assert.equal(editor.fields.length,2);assert.ok(editor.templateHelp?.height>0&&editor.emptyHint?.height>0,'Both template and empty-value guidance are rendered');
      const visibleTop=Math.max(editor.bounds.top,editor.workspace.top,0),visibleBottom=Math.min(editor.bounds.bottom,editor.workspace.bottom,editor.savebar.top,layout.height);
      for(const [name,bounds] of [...editor.fields.map((field,index)=>['instruction '+(index+1),field]),['template help',editor.templateHelp],['empty-value hint',editor.emptyHint]]){
        assert.ok(bounds.top>=visibleTop-1&&bounds.bottom<=visibleBottom+1,`${name} is fully visible above the save bar without scrolling`);
      }
      assert.ok(editor.scrollTop<=1,'Default instruction editor starts without scrolling');
    }
    if(requestedScaleFactor!==null)assert.ok(Math.abs(layout.devicePixelRatio-requestedScaleFactor)<.01,'Renderer DPR matches EDIRO_SMOKE_SCALE_FACTOR');
    const metadata=await sharp(lastFrame.png).metadata();
    assert.ok(Math.abs(metadata.width-layout.width*layout.devicePixelRatio)<=3,'Screenshot width reflects the renderer device pixel ratio');
    assert.ok(Math.abs(metadata.height-layout.height*layout.devicePixelRatio)<=3,'Screenshot height reflects the renderer device pixel ratio');
    const file=path.join(base,`prompt-settings-${label}-${width}x${height}.png`);await writeFile(file,lastFrame.png);
    captures.push({file,layout,pixels:{width:metadata.width,height:metadata.height},paintSize:lastFrame.size,pixelRatio:{x:metadata.width/layout.width,y:metadata.height/layout.height}});
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
  const selectModuleMode=async mode=>{
    const label=mode==='inference'?'推理指令':'生图指令';await clickLabel(label,'.prompt-module-mode');
    await until(()=>js(`[...document.querySelectorAll('.prompt-module-mode button')].find(button=>button.textContent.trim()===${JSON.stringify(label)})?.getAttribute('aria-pressed')==='true'`),'selected '+label);
  };
  const previewText=kind=>js(`document.querySelector(${JSON.stringify(`[data-prompt-preview="${kind}"]`)})?.innerText??''`);
  const previewProse=async kind=>(await js(`[...document.querySelectorAll(${JSON.stringify(`[data-prompt-preview="${kind}"] pre`)})].map(el=>el.textContent)`)).join('\n');
  const apply=async expected=>{
    const count=responses.filter(item=>item.type==='prompt-settings:save').length;
    await clickLabel('保存并应用','.prompt-settings-savebar');await waitCommand('prompt-settings:save',count);
    assert.equal(lastResponse('prompt-settings:save').ok,true,lastResponse('prompt-settings:save').error);
    await until(async()=>JSON.stringify(await customizations())===JSON.stringify(expected),'customizations applied');
    await until(()=>js(`!document.querySelector('.prompt-settings')?.getAttribute('aria-busy')&&[...document.querySelectorAll('.prompt-settings-savebar button')].find(el=>el.textContent.trim()==='保存并应用')?.disabled===true`),'saved UI settled');
  };
  const expectApplied=async expected=>assert.deepEqual(await customizations(),expected);
  const expectNoDialog=()=>until(()=>js(`!document.querySelector('.app-dialog')`),'dialog closed');
  const activeStyleText=async()=>(await controller.view()).chain.blocks.find(block=>block.type==='text'&&block.text_role==='instruction'&&block.reference_type==='style');
  const exportCurrent=async filename=>{
    savePaths.push(filename);const count=responses.filter(item=>item.type==='prompt-customizations:export').length;
    const label=await js(`[...document.querySelectorAll('.prompt-settings-transfer button')].find(button=>button.textContent.trim().startsWith('导出'))?.textContent.trim()`);
    await clickLabel(label,'.prompt-settings-transfer');await waitCommand('prompt-customizations:export',count);
    assert.equal(lastResponse('prompt-customizations:export').ok,true,lastResponse('prompt-customizations:export').error);
    return JSON.parse(await readFile(filename,'utf8'));
  };
  const saveNewPreset=async(name,target='style')=>{
    await clickLabel('另存为预设');await until(()=>js(`!!document.querySelector('input[aria-label="预设名称"]')`),'preset name dialog');
    await setValue('input[aria-label="预设名称"]',name);
    const count=responses.filter(item=>item.type==='prompt-presets:save').length;
    await clickLabel('保存预设','.app-dialog');await waitCommand('prompt-presets:save',count);await expectNoDialog();
    assert.equal(lastResponse('prompt-presets:save').ok,true,lastResponse('prompt-presets:save').error);
    return (await settings()).presets.find(preset=>presetTarget(preset)===target&&preset.name===name);
  };
  const assertNoUnsupportedFieldHelp=async()=>{
    const help=await js(`[...document.querySelectorAll('.prompt-template-help,.prompt-settings-editor .settings-hint,.prompt-field-description')].map(element=>element.textContent).join('\\n')`);
    assert.doesNotMatch(help,/不支持|不会替换|不做替换|不进行替换|无效字段/,'Instruction help only describes supported fields and actions');
  };
  const presetAction=async label=>{
    // The menu is intentionally opened before interacting with its actions.
    const menu=await js(`(()=>{const summary=[...document.querySelectorAll('.prompt-settings summary')].find(el=>/更多|预设/.test(el.textContent));return summary&&!summary.parentElement.open?true:false;})()`);
    if(menu)await js(`(()=>{const summary=[...document.querySelectorAll('.prompt-settings summary')].find(el=>/更多|预设/.test(el.textContent));summary.click();})()`);
    await clickLabel(label);
  };

  await phase('defaults-visible-read-only-and-current-item-preview');
  await openCore();
  await assertDefaultField('#prompt-native_instruction',factoryInstructions.subject.native_instruction);
  await assertDefaultField('#prompt-numbered_instruction',factoryInstructions.subject.numbered_instruction);
  assert.ok((await previewText('native')).length);assert.ok((await previewText('numbered')).length);
  await screenshot(1775,1050,'default-instructions');await screenshot(1120,800,'default-instructions');
  for(const item of ['module:subject','module:composition','module:style','module:viewpoint','role:general']){await selectItem(item);await assertNoUnsupportedFieldHelp();}
  await selectItem('role:merchandiser');
  await assertDefaultField('#prompt-role-instruction',promptRoles.find(role=>role.id==='merchandiser').instruction);
  assert.equal(await previewProse('role'),promptRoles.find(role=>role.id==='merchandiser').instruction);
  await assertNoUnsupportedFieldHelp();
  await screenshot(1775,1050,'role-default-presets');await screenshot(1120,800,'role-default-presets');

  await phase('single-module-native-and-numbered-preview');
  await selectItem('module:style');await setValue('select[aria-label="试编译图片数"]',2);
  let native='SMOKE_NATIVE: use the lighting from {images}; keep this custom style instruction isolated.';
  const numbered='SMOKE_NUMBERED: use only the color palette from {images}.';
  await click('input[aria-label="自定义原生图文顺序"]');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),factoryInstructions.style.native_instruction,'Starting custom editing copies the factory instruction');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').readOnly`),false);
  await setValue('#prompt-native_instruction',native);
  assert.equal(await previewProse('native'),native.replace('{images}','image_1, image_2'));
  assert.ok((await previewText('numbered')).length,'Uncustomized expression previews its current default');
  assert.doesNotMatch(await previewText('numbered'),/SMOKE_NATIVE/);
  assert.deepEqual(await js(`[...document.querySelectorAll('[data-prompt-preview="native"] .prompt-preview-image')].map(el=>el.textContent.trim())`),['▧ image_1','▧ image_2']);
  await expectApplied(emptyCustomizations());
  await click('input[aria-label="自定义文字＋图片集合"]');await setValue('#prompt-numbered_instruction',numbered);
  assert.equal(await previewProse('numbered'),numbered.replace('{images}','image_1, image_2'));
  assert.doesNotMatch(await previewText('numbered'),/SMOKE_NATIVE/);assert.doesNotMatch(await previewText('native'),/SMOKE_NUMBERED/);
  // Changing the selected item retains the global draft, but its preview must
  // be based solely on the newly selected item, never the workbench project.
  await selectItem('module:subject');
  await assertDefaultField('#prompt-native_instruction',factoryInstructions.subject.native_instruction);
  assert.doesNotMatch(await previewText('native'),/SMOKE_NATIVE|SMOKE_NUMBERED/);assert.doesNotMatch(await previewText('numbered'),/SMOKE_NATIVE|SMOKE_NUMBERED/);
  await selectItem('module:style');assert.match(await previewText('native'),/SMOKE_NATIVE/);
  await screenshot(1775,1050,'module-draft');await screenshot(1120,800,'module-draft');
  let saved={version:1,modules:{style:{native_instruction:native,numbered_instruction:numbered}},roles:{}};
  await apply(saved);
  const actualStyle=await activeStyleText();
  assert.match(actualStyle.text,/SMOKE_NATIVE: use the lighting from image_3/,'Real execution retains full-project image order');
  assert.match(actualStyle.numbered_text,/SMOKE_NUMBERED: use only the color palette from image_3/);
  assert.deepEqual((await persistedSettings()).customizations,saved);

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

  await phase('named-preset-save-does-not-apply');
  const presetNative=native+' PRESET_ONLY';await setValue('#prompt-native_instruction',presetNative);
  await phase('preset-name-dialog-keyboard-focus-and-escape');
  const presetsBeforeEscape=structuredClone((await settings()).presets);
  await clickLabel('另存为预设');
  await until(()=>js(`document.activeElement?.getAttribute('aria-label')==='预设名称'`),'preset name receives initial focus');
  const focusLabel=()=>js(`document.activeElement?.getAttribute('aria-label')??document.activeElement?.textContent.trim()`);
  for(const expected of ['取消','保存预设','预设名称']){
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    await until(async()=>await focusLabel()===expected,'Tab focuses '+expected);
    assert.equal(await js(`!!document.activeElement?.closest('.app-dialog')`),true,'Tab remains inside the name dialog');
  }
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});
  await until(async()=>await focusLabel()==='保存预设','Shift+Tab wraps to the last dialog button');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await expectNoDialog();assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),presetNative,'Escape dismisses naming without discarding instruction edits');
  assert.deepEqual((await settings()).presets,presetsBeforeEscape);await expectApplied(saved);
  await phase('named-preset-save-does-not-apply');
  const presetA=await saveNewPreset('柔和光线');assert.ok(presetA?.id);
  assert.deepEqual(presetA.instructions,{native_instruction:presetNative,numbered_instruction:numbered});
  await expectApplied(saved);assert.deepEqual((await persistedSettings()).customizations,saved,'Saving a preset never applies draft instructions');

  await phase('preset-duplicate-name-and-rename');
  const presetCount=(await settings()).presets.length;
  await clickLabel('另存为预设');await setValue('input[aria-label="预设名称"]','柔和光线');
  const duplicateDisabled=await js(`[...document.querySelectorAll('.app-dialog button')].find(button=>button.textContent.trim()==='保存预设')?.disabled`);
  if(!duplicateDisabled)await clickLabel('保存预设','.app-dialog');
  await until(()=>js(`!!document.querySelector('.app-dialog [role="alert"]')||[...document.querySelectorAll('.app-dialog button')].find(button=>button.textContent.trim()==='保存预设')?.disabled===true`),'duplicate name rejected');
  assert.equal((await settings()).presets.length,presetCount);await clickLabel('取消','.app-dialog');await expectNoDialog();
  await phase('valid-preset-library-actions-ignore-other-module-invalid-draft');
  await selectItem('module:subject');
  await assertDefaultField('#prompt-native_instruction',factoryInstructions.subject.native_instruction);
  await click('input[aria-label="自定义原生图文顺序"]');await setValue('#prompt-native_instruction','UNRELATED_INVALID_DRAFT {unknown}');
  assert.ok(await js(`!!document.querySelector('.prompt-settings [role="alert"]')`));
  await selectItem('module:style');
  assert.equal(await js(`[...document.querySelectorAll('.prompt-settings-savebar button')].find(button=>button.textContent.trim()==='保存并应用')?.disabled`),true,'The invalid unrelated draft still blocks whole-system application');
  await presetAction('重命名预设');await setValue('input[aria-label="预设名称"]','柔和光线 · 商品');
  let count=responses.filter(item=>item.type==='prompt-presets:save').length;
  await clickLabel('保存名称','.app-dialog');await waitCommand('prompt-presets:save',count);await expectNoDialog();
  assert.equal((await settings()).presets.find(preset=>preset.id===presetA.id).name,'柔和光线 · 商品','Renaming retains stable preset identity');await expectApplied(saved);

  await phase('update-and-select-preset-until-apply');
  const presetB=await saveNewPreset('色调优先');assert.ok(presetB?.id);assert.notEqual(presetB.id,presetA.id);
  const updatedNative=presetNative+' UPDATED_PRESET';await setValue('#prompt-native_instruction',updatedNative);
  count=responses.filter(item=>item.type==='prompt-presets:save').length;
  await clickLabel('更新此预设');await waitCommand('prompt-presets:save',count);
  assert.equal(lastResponse('prompt-presets:save').ok,true,lastResponse('prompt-presets:save').error);
  assert.equal((await settings()).presets.find(preset=>preset.id===presetB.id).instructions.native_instruction,updatedNative);
  assert.equal((await settings()).presets.length,2,'Updating overwrites the selected preset instead of creating another');await expectApplied(saved);
  assert.deepEqual((await persistedSettings()).customizations,saved,'Saving a valid preset never persists another module\'s invalid draft');
  await selectItem('module:subject');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),'UNRELATED_INVALID_DRAFT {unknown}','Preset library actions preserve unrelated in-progress edits');
  assert.equal(await js(`document.querySelector('input[aria-label="自定义原生图文顺序"]').checked`),true);
  await click('input[aria-label="自定义原生图文顺序"]');await assertDefaultField('#prompt-native_instruction',factoryInstructions.subject.native_instruction);
  await selectItem('module:style');assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),updatedNative,'Restoring only the unrelated field preserves the valid preset edit');
  native=updatedNative;saved={...saved,modules:{style:{native_instruction:native,numbered_instruction:numbered}}};await apply(saved);
  assert.equal((await settings()).selected_presets.style,presetB.id);
  await selectItem('module:subject');
  const subjectPresets=await js(`[...document.querySelector('select[aria-label="主体指令预设"]').options].map(option=>option.value)`);
  assert.ok(!subjectPresets.includes(`preset:${presetA.id}`)&&!subjectPresets.includes(`preset:${presetB.id}`),'A module only lists its own presets');
  await selectItem('module:style');assert.equal(await js(`document.querySelector('select[aria-label="风格指令预设"]').value`),`preset:${presetB.id}`);
  await phase('switch-preset-protects-unsaved-edit');
  await setValue('#prompt-native_instruction',native+' UNSAVED_PRESET_SWITCH');
  await setValue('select[aria-label="风格指令预设"]',`preset:${presetA.id}`);
  await until(()=>js(`document.querySelector('.app-dialog')?.textContent.includes('保留当前指令修改')`),'preset switch guard');
  await clickLabel('继续编辑','.app-dialog');await expectNoDialog();
  assert.match(await js(`document.querySelector('#prompt-native_instruction').value`),/UNSAVED_PRESET_SWITCH/);await expectApplied(saved);
  await setValue('select[aria-label="风格指令预设"]',`preset:${presetA.id}`);
  await clickLabel('放弃修改并切换','.app-dialog');await expectNoDialog();
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),presetNative);
  await expectApplied(saved);native=presetNative;saved={...saved,modules:{style:{native_instruction:native,numbered_instruction:numbered}}};await apply(saved);
  assert.equal((await settings()).selected_presets.style,presetA.id);
  await screenshot(1775,1050,'named-presets');await screenshot(1120,800,'named-presets');await screenshot(800,720,'named-presets');

  await phase('delete-active-preset-retains-current-text');
  await presetAction('删除预设');
  await until(()=>js(`!!document.querySelector('.app-dialog')`),'delete preset confirmation');
  count=responses.filter(item=>item.type==='prompt-presets:save').length;
  await clickLabel('删除预设','.app-dialog');await waitCommand('prompt-presets:save',count);await expectNoDialog();
  assert.equal((await settings()).presets.length,1);assert.equal((await settings()).presets[0].id,presetB.id);
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),native);await expectApplied(saved);
  assert.equal((await settings()).selected_presets.style,undefined);

  await phase('export-entire-prompt-system');
  const exported=path.join(base,'custom-instructions.json');
  const exportedSettings=await exportCurrent(exported);
  assert.equal(exportedSettings.version,2);assert.deepEqual(exportedSettings.customizations,saved);
  assert.deepEqual(exportedSettings.presets,(await settings()).presets,'Whole-system export includes the entire preset library');
  assert.deepEqual(exportedSettings.selected_presets,(await settings()).selected_presets);
  await expectApplied(saved);assert.equal(inferences.length,1,'Preview, saving, and export must not run inference');

  await phase('role-customization-invalidates-and-enters-real-inference-plan');
  await infer();assert.equal((await controller.view()).auto_prompt.needs_inference,false);
  const priorKey=current('prompt').auto_prompt_input_key,callsBeforeRole=inferences.length;
  await selectItem('role:merchandiser');
  await click('input[aria-label="自定义角色指令"]');
  const role='ROLE_CUSTOM_SMOKE: arrange only two neutral props and soft side lighting; preserve all explicit product requirements.';
  await setValue('#prompt-role-instruction',role);
  assert.equal(await previewProse('role'),role);assert.equal(await js(`document.querySelectorAll('[data-prompt-preview="native"],[data-prompt-preview="numbered"]').length`),0);
  await screenshot(1775,1050,'role-draft');await screenshot(1120,800,'role-draft');
  saved={...saved,roles:{merchandiser:role}};await apply(saved);
  assert.equal(inferences.length,callsBeforeRole,'Applying a role never spends an inference call');
  assert.equal(current('prompt').auto_prompt_input_key,priorKey,'Existing generated text keeps its historical input key');
  assert.equal((await controller.view()).auto_prompt.needs_inference,true,'Changed role content invalidates old automatic result');
  await infer();
  const inferenceText=inferences.at(-1).chain_snapshot.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  const compiledSystem=inferences.at(-1).chain_snapshot.system_instruction;
  assert.ok(compiledSystem.includes(role),'custom role text survives compilation unchanged');
  assert.ok(compiledSystem.length>role.length,'shared task rules remain alongside the custom role');
  assert.equal(inferences.at(-1).adapted_input.system_instruction,compiledSystem);
  const inferenceContext=JSON.parse(inferences.at(-1).chain_snapshot.blocks[0].text);
  assert.ok(inferenceContext&&typeof inferenceContext==='object'&&!Array.isArray(inferenceContext),'user begins with structured task context');
  assert.ok(Array.isArray(inferenceContext.references),'task context retains the reference list');
  assert.ok(!inferenceText.includes(role),'Custom role is separate from user content');
  assert.ok(!inferenceText.includes(promptRoles.find(item=>item.id==='merchandiser').instruction),'Custom role replaces the factory role');
  assert.equal((await controller.view()).auto_prompt.needs_inference,false);
  assert.notEqual(current('prompt').auto_prompt_input_key,priorKey);
  const generationText=(await controller.view()).chain.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  assert.ok(!generationText.includes(role),'Role instructions must not enter the image-generation chain');
  assert.equal((await controller.view()).chain.system_instruction,undefined);

  await phase('customizations-survive-controller-and-renderer-restart');
  await execute({type:'project:save'});const record=(await controller.view()).project_record_id;
  assert.ok(record);await controller.shutdown();controller=await createController();
  await execute({type:'workspace:resume',id:record});await load();await expectApplied(saved);
  assert.equal((await controller.view()).auto_prompt.needs_inference,false,'Restart preserves role-aware reuse');
  await openCore();await selectItem('role:merchandiser');
  assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),role);
  assert.deepEqual((await settings()).presets,exportedSettings.presets,'Restart restores the entire named preset library');
  const retainedPresets=structuredClone((await settings()).presets);
  await execute({type:'prompt-presets:save',presets:[...retainedPresets,{id:'preset_smoke_local_only',name:'本地额外预设',module:'subject',instructions:{native_instruction:'LOCAL_ONLY: preserve {images}.'}}]});
  await load();await openCore();await selectItem('role:merchandiser');
  assert.equal((await settings()).presets.length,2);

  await phase('invalid-import-preserves-current-and-draft-values');
  const invalid=path.join(base,'invalid-custom-instructions.json');
  await writeFile(invalid,JSON.stringify({version:999,modules:{style:{native_instruction:'INVALID_IMPORT_MUST_NOT_APPLY'}},roles:{}}));
  openPaths.push(invalid);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,false);await expectApplied(saved);
  assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),role);
  await until(()=>js(`!!document.querySelector('.prompt-settings-error[role="alert"]')`),'invalid import error shown');
  assert.deepEqual((await persistedSettings()).customizations,saved);assert.equal((await settings()).presets.length,2);

  await phase('valid-import-is-draft-until-explicit-application');
  openPaths.push(exported);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,true,lastResponse('prompt-customizations:import').error);await expectApplied(saved);
  assert.equal((await settings()).presets.length,2,'Importing a full package only stages its library until application');
  await until(()=>js(`document.querySelector('[data-prompt-item="module:style"]')?.getAttribute('aria-pressed')==='true'`),'imported style selected');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),native);
  await selectItem('role:merchandiser');await assertDefaultField('#prompt-role-instruction',promptRoles.find(role=>role.id==='merchandiser').instruction);
  assert.equal(await previewProse('role'),promptRoles.find(role=>role.id==='merchandiser').instruction);
  saved={...saved,roles:{}};await apply(saved);
  assert.deepEqual((await settings()).presets,retainedPresets,'Applying a complete package restores its library, including removal of local-only entries');
  openPaths.push(null);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').cancelled,true);await expectApplied(saved);

  await phase('imported-reserved-preset-id-and-unapplied-library-switch-guard');
  const reservedInstructions={native_instruction:'RESERVED_ID_PRESET: preserve the lighting in {images}.',numbered_instruction:'RESERVED_ID_NUMBERED: reference {images}.'};
  const reservedPackage=structuredClone(await settings());
  reservedPackage.presets.push({id:'default',name:'名称与系统选项独立',module:'style',instructions:reservedInstructions});
  const reservedFile=path.join(base,'reserved-preset-id.json');await writeFile(reservedFile,JSON.stringify(reservedPackage));
  openPaths.push(reservedFile);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,true,lastResponse('prompt-customizations:import').error);
  await selectItem('module:style');
  const reservedOptions=await js(`[...document.querySelector('select[aria-label="风格指令预设"]').options].map(option=>option.value)`);
  assert.ok(reservedOptions.includes('default')&&reservedOptions.includes('preset:default'),'Factory default and a preset whose ID is default have distinct option values');
  assert.equal(await js(`[...document.querySelectorAll('.prompt-preset-actions button')].find(button=>button.textContent.trim()==='另存为预设')?.disabled`),true,'Unapplied imported library cannot be mutated separately');
  await setValue('#prompt-native_instruction',native+' UNAPPLIED_LIBRARY_EDIT');
  await setValue('select[aria-label="风格指令预设"]','preset:default');
  await until(()=>js(`document.querySelector('.app-dialog')?.textContent.includes('保留当前指令修改')`),'imported library switch guard');
  assert.equal(await js(`[...document.querySelectorAll('.app-dialog button')].some(button=>button.textContent.trim()==='先存为预设')`),false,'An unapplied imported library must not offer the unavailable save-before-switch branch');
  assert.ok(await js(`document.querySelector('.app-dialog').textContent.includes('导入的预设库尚未应用')`));
  await clickLabel('继续编辑','.app-dialog');await expectNoDialog();
  assert.match(await js(`document.querySelector('#prompt-native_instruction').value`),/UNAPPLIED_LIBRARY_EDIT/);await expectApplied(saved);
  assert.deepEqual((await settings()).presets,retainedPresets,'Switch guard leaves the applied preset library unchanged');
  await setValue('select[aria-label="风格指令预设"]','preset:default');
  await clickLabel('放弃修改并切换','.app-dialog');await expectNoDialog();
  assert.equal(await js(`document.querySelector('select[aria-label="风格指令预设"]').value`),'preset:default');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),reservedInstructions.native_instruction);
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').readOnly`),false,'Selecting preset ID default must not restore read-only factory text');
  await expectApplied(saved);
  await apply({...saved,modules:{...saved.modules,style:reservedInstructions}});
  assert.equal((await settings()).selected_presets.style,'default');assert.equal((await persistedSettings()).selected_presets.style,'default');
  assert.equal(controller.workspace.registry.get('style').base_instruction,reservedInstructions.native_instruction);
  // Restore the earlier exported package so the remaining compatibility and
  // reset assertions retain their original library and instruction expectations.
  openPaths.push(exported);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,true,lastResponse('prompt-customizations:import').error);
  await apply(saved);assert.deepEqual((await settings()).presets,retainedPresets);assert.deepEqual((await settings()).selected_presets,exportedSettings.selected_presets);

  await phase('legacy-import-retains-preset-library-and-explicit-empty-text');
  const legacyFile=path.join(base,'legacy-v1-customizations.json');
  const legacy={version:1,modules:{subject:{native_instruction:''},style:{native_instruction:native,numbered_instruction:numbered}},roles:{}};
  await writeFile(legacyFile,JSON.stringify(legacy));openPaths.push(legacyFile);
  count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,true,lastResponse('prompt-customizations:import').error);await expectApplied(saved);
  await selectItem('module:subject');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),'');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').readOnly`),false,'Explicit empty string remains a custom value');
  assert.equal(await previewProse('native'),'');await assertDefaultField('#prompt-numbered_instruction',factoryInstructions.subject.numbered_instruction);
  saved=legacy;await apply(saved);assert.deepEqual((await settings()).presets,retainedPresets,'A v1 file with no library field cannot erase existing presets');

  await phase('restore-current-and-all-defaults-explicitly');
  await selectItem('module:style');await clickLabel('恢复此项默认','.prompt-settings-context');
  await assertDefaultField('#prompt-native_instruction',factoryInstructions.style.native_instruction);
  await assertDefaultField('#prompt-numbered_instruction',factoryInstructions.style.numbered_instruction);
  assert.ok((await previewText('native')).length);assert.ok((await previewText('numbered')).length);await expectApplied(saved);
  await clickLabel('还原未应用修改','.prompt-settings-savebar');
  assert.equal(await js(`document.querySelector('#prompt-native_instruction').value`),native);await expectApplied(saved);
  await clickLabel('全部恢复默认','.prompt-settings-transfer');
  await until(()=>js(`document.querySelector('.app-dialog')?.textContent.includes('恢复全部默认指令')`),'reset confirmation');
  await clickLabel('取消','.app-dialog');await expectNoDialog();await expectApplied(saved);
  await clickLabel('全部恢复默认','.prompt-settings-transfer');await clickLabel('恢复默认','.app-dialog');await expectNoDialog();
  await expectApplied(saved);await assertDefaultField('#prompt-native_instruction',factoryInstructions.style.native_instruction);
  assert.ok((await previewText('native')).length);assert.ok((await previewText('numbered')).length);
  await apply(emptyCustomizations());
  assert.equal(controller.workspace.registry.get('style').base_instruction,factoryStyle,'Reset restores this release\'s factory instruction');
  assert.deepEqual((await settings()).presets,retainedPresets,'Resetting all instructions preserves the preset library');
  assert.deepEqual((await settings()).selected_presets,{});
  const afterReset=path.join(base,'reset-with-presets.json'),resetExport=await exportCurrent(afterReset);
  assert.deepEqual(resetExport.customizations,emptyCustomizations());assert.deepEqual(resetExport.presets,retainedPresets,'Export after reset still includes every saved preset');
  assert.deepEqual(resetExport.selected_presets,{});
  await screenshot(1775,1050,'restored-defaults');await screenshot(1120,800,'restored-defaults');

  await phase('role-named-presets-save-update-rename-without-application');
  saved=emptyCustomizations();
  const callsBeforeRolePresets=inferences.length;
  await selectItem('role:general');await assertNoUnsupportedFieldHelp();
  await assertDefaultField('#prompt-role-instruction',promptRoles.find(item=>item.id==='general').instruction);
  await click('input[aria-label="自定义角色指令"]');
  const fineRole='ROLE_FINE_PRESET: refine product details and keep literal notes {images}, {viewpoint}, and {module} exactly as written.';
  await setValue('#prompt-role-instruction',fineRole);
  const rolePresetA=await saveNewPreset('精修','general');assert.ok(rolePresetA?.id);
  assert.equal(rolePresetA.role,'general');assert.equal(rolePresetA.module,undefined);assert.equal(rolePresetA.instruction,fineRole);
  await expectApplied(saved);assert.equal((await persistedSettings()).customizations.roles.general,undefined,'Saving a role preset does not apply its instruction');
  const creativeRole='ROLE_CREATIVE_PRESET: introduce soft light and restrained supporting props.';
  await setValue('#prompt-role-instruction',creativeRole);
  const rolePresetB=await saveNewPreset('创意补全','general');assert.ok(rolePresetB?.id);assert.notEqual(rolePresetB.id,rolePresetA.id);
  const updatedCreativeRole=creativeRole+' Keep the product silhouette unchanged.';
  await setValue('#prompt-role-instruction',updatedCreativeRole);
  count=responses.filter(item=>item.type==='prompt-presets:save').length;
  await clickLabel('更新此预设');await waitCommand('prompt-presets:save',count);
  assert.equal(lastResponse('prompt-presets:save').ok,true,lastResponse('prompt-presets:save').error);
  assert.equal((await settings()).presets.find(preset=>preset.id===rolePresetB.id).instruction,updatedCreativeRole);
  await presetAction('重命名预设');await setValue('input[aria-label="预设名称"]','创意补全 · 柔光');
  count=responses.filter(item=>item.type==='prompt-presets:save').length;
  await clickLabel('保存名称','.app-dialog');await waitCommand('prompt-presets:save',count);await expectNoDialog();
  assert.equal((await settings()).presets.find(preset=>preset.id===rolePresetB.id).name,'创意补全 · 柔光');
  assert.equal((await settings()).presets.filter(preset=>preset.role==='general').length,2);await expectApplied(saved);

  await phase('role-preset-selection-isolation-and-system-instruction');
  await setValue('select[aria-label="通用指令预设"]',`preset:${rolePresetA.id}`);
  assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),fineRole);assert.equal(await previewProse('role'),fineRole);await expectApplied(saved);
  const appliedFineRole={version:1,modules:{},roles:{general:fineRole}};
  await apply(appliedFineRole);saved=appliedFineRole;
  assert.equal((await settings()).selected_presets.general,rolePresetA.id);
  const generalOptions=await js(`[...document.querySelector('select[aria-label="通用指令预设"]').options].map(option=>option.value)`);
  assert.ok(generalOptions.includes(`preset:${rolePresetA.id}`)&&generalOptions.includes(`preset:${rolePresetB.id}`));
  for(const preset of retainedPresets)assert.ok(!generalOptions.includes(`preset:${preset.id}`),'Role preset selector excludes module presets');
  await selectItem('role:merchandiser');
  const merchandiserOptions=await js(`[...document.querySelector('select[aria-label="陈列师指令预设"]').options].map(option=>option.value)`);
  assert.ok(!merchandiserOptions.includes(`preset:${rolePresetA.id}`)&&!merchandiserOptions.includes(`preset:${rolePresetB.id}`),'Each role has its own preset list');
  await selectItem('module:style');
  const styleOptions=await js(`[...document.querySelector('select[aria-label="风格指令预设"]').options].map(option=>option.value)`);
  assert.ok(styleOptions.includes(`preset:${presetB.id}`));
  assert.ok(!styleOptions.includes(`preset:${rolePresetA.id}`)&&!styleOptions.includes(`preset:${rolePresetB.id}`),'Module preset selector excludes role presets');
  await selectItem('role:general');
  assert.equal(await js(`document.querySelector('select[aria-label="通用指令预设"]').value`),`preset:${rolePresetA.id}`);
  assert.equal(inferences.length,callsBeforeRolePresets,'Role preset management and application never trigger inference');
  const roleRecipe=structuredClone(controller.workspace.project.recipe);
  roleRecipe.modules.find(module=>module.reference_type==='prompt').prompt_role='general';
  await execute({type:'recipe:save',recipe:roleRecipe});await infer();
  const rolePresetInference=inferences.at(-1);
  assert.ok(rolePresetInference.chain_snapshot.system_instruction.includes(fineRole),'The selected role preset is used verbatim in the actual mock inference system instruction');
  assert.equal(rolePresetInference.adapted_input.system_instruction,rolePresetInference.chain_snapshot.system_instruction);
  assert.ok(!rolePresetInference.chain_snapshot.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n').includes(fineRole),'Role preset instruction stays separate from user input');
  assert.ok(!(await controller.view()).chain.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n').includes(fineRole),'Role preset does not enter the image-generation prompt');
  assert.equal((await controller.view()).chain.system_instruction,undefined);
  await screenshot(1775,1050,'role-named-presets');await screenshot(1120,800,'role-named-presets');await screenshot(800,720,'role-named-presets');

  await phase('role-preset-full-export-and-restart-persistence');
  const roleExportFile=path.join(base,'whole-system-with-role-presets.json'),roleExport=await exportCurrent(roleExportFile);
  assert.deepEqual(roleExport.customizations,appliedFineRole);
  assert.equal(roleExport.selected_presets.general,rolePresetA.id);
  assert.deepEqual(roleExport.presets,(await settings()).presets);
  assert.equal(roleExport.presets.find(preset=>preset.id===rolePresetA.id).instruction,fineRole);
  assert.equal(roleExport.presets.filter(preset=>preset.role==='general').length,2);
  const allRolePresets=structuredClone(roleExport.presets);
  await execute({type:'project:save'});const roleRecord=(await controller.view()).project_record_id;
  assert.ok(roleRecord);await controller.shutdown();controller=await createController();
  await execute({type:'workspace:resume',id:roleRecord});await load();await expectApplied(appliedFineRole);
  assert.deepEqual((await settings()).presets,allRolePresets);assert.equal((await settings()).selected_presets.general,rolePresetA.id);
  assert.equal((await controller.view()).auto_prompt.needs_inference,false,'Restart preserves role-preset-aware inference reuse');
  await openCore();await selectItem('role:general');
  assert.equal(await js(`document.querySelector('select[aria-label="通用指令预设"]').value`),`preset:${rolePresetA.id}`);
  assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),fineRole);

  await phase('legacy-role-import-and-reset-preserve-role-preset-library');
  const legacyRole={version:1,modules:{},roles:{general:'LEGACY_ROLE: preserve the literal text {module}.'}};
  const legacyRoleFile=path.join(base,'legacy-role-v1.json');await writeFile(legacyRoleFile,JSON.stringify(legacyRole));
  openPaths.push(legacyRoleFile);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,true,lastResponse('prompt-customizations:import').error);await expectApplied(appliedFineRole);
  await selectItem('role:general');assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),legacyRole.roles.general);
  await apply(legacyRole);assert.deepEqual((await settings()).presets,allRolePresets);assert.equal((await settings()).selected_presets.general,undefined);
  await clickLabel('全部恢复默认','.prompt-settings-transfer');await clickLabel('恢复默认','.app-dialog');await expectNoDialog();
  await apply(emptyCustomizations());assert.deepEqual((await settings()).presets,allRolePresets);assert.deepEqual((await settings()).selected_presets,{});
  await assertDefaultField('#prompt-role-instruction',promptRoles.find(item=>item.id==='general').instruction);
  assert.equal(await js(`document.querySelector('select[aria-label="通用指令预设"]').value`),'default');await assertNoUnsupportedFieldHelp();
  openPaths.push(roleExportFile);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,true,lastResponse('prompt-customizations:import').error);
  await apply(appliedFineRole);assert.deepEqual((await settings()).presets,allRolePresets);assert.equal((await settings()).selected_presets.general,rolePresetA.id);

  await phase('delete-selected-role-preset-keeps-current-instruction');
  await selectItem('role:general');await presetAction('删除预设');
  count=responses.filter(item=>item.type==='prompt-presets:save').length;
  await clickLabel('删除预设','.app-dialog');await waitCommand('prompt-presets:save',count);await expectNoDialog();
  assert.equal(lastResponse('prompt-presets:save').ok,true,lastResponse('prompt-presets:save').error);
  assert.ok(!(await settings()).presets.some(preset=>preset.id===rolePresetA.id));
  assert.ok((await settings()).presets.some(preset=>preset.id===rolePresetB.id));
  for(const preset of retainedPresets)assert.ok((await settings()).presets.some(item=>item.id===preset.id));
  assert.equal((await settings()).selected_presets.general,undefined);await expectApplied(appliedFineRole);
  assert.equal((await persistedSettings()).customizations.roles.general,fineRole);
  assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),fineRole);
  assert.equal(await js(`document.querySelector('#prompt-role-instruction').readOnly`),false);
  assert.equal(await js(`document.querySelector('select[aria-label="通用指令预设"]').value`),'custom');

  await phase('four-module-inference-defaults-and-independent-editor');
  const callsBeforeModuleInference=inferences.length;
  const moduleTitles={subject:'主体',composition:'构图',style:'风格',viewpoint:'视角'};
  const beforeInferenceSettings=structuredClone(await settings());
  for(const module of Object.keys(moduleTitles)){
    await selectItem(`module:${module}`);await selectModuleMode('inference');
    await assertDefaultField('#prompt-inference-instruction',defaultModuleInferenceInstructions[module]);
    assert.equal(await previewProse('inference'),defaultModuleInferenceInstructions[module]);
    assert.equal(await js(`document.querySelectorAll('.prompt-settings-editor textarea').length`),1);
    assert.equal(await js(`document.querySelectorAll('.prompt-preview-options,[data-prompt-preview="native"],[data-prompt-preview="numbered"]').length`),0,'Inference instructions use a plain current-item preview');
    assert.ok(await js(`!!document.querySelector(${JSON.stringify(`select[aria-label="${moduleTitles[module]}推理指令预设"]`)})`));
    await assertNoUnsupportedFieldHelp();
  }
  await selectItem('module:subject');await selectModuleMode('generation');
  await assertDefaultField('#prompt-native_instruction',factoryInstructions.subject.native_instruction);
  await selectModuleMode('inference');await click('input[aria-label="自定义推理指令"]');
  assert.equal(await js(`document.querySelector('#prompt-inference-instruction').value`),defaultModuleInferenceInstructions.subject,'Custom inference editing starts from the default');
  const inferenceSubject='INFERENCE_SUBJECT_SENTINEL: preserve literal {images}, {viewpoint}, and {unknown}; describe only the requested product identity.';
  await setValue('#prompt-inference-instruction',inferenceSubject);assert.equal(await previewProse('inference'),inferenceSubject);
  const inferencePresetA=await saveNewPreset('识别重点','inference:subject');assert.ok(inferencePresetA?.id);
  assert.equal(inferencePresetA.kind,'inference');assert.equal(inferencePresetA.module,'subject');assert.equal(inferencePresetA.instruction,inferenceSubject);assert.equal(inferencePresetA.instructions,undefined);
  assert.deepEqual((await settings()).inference_instructions,beforeInferenceSettings.inference_instructions);await expectApplied(beforeInferenceSettings.customizations);
  const inferenceAlternative='INFERENCE_ALTERNATIVE: identify only the material and silhouette.';
  await setValue('#prompt-inference-instruction',inferenceAlternative);
  const inferencePresetB=await saveNewPreset('材质识别','inference:subject');assert.ok(inferencePresetB?.id);
  const inferenceAlternativeUpdated=inferenceAlternative+' Keep user wording intact.';
  await setValue('#prompt-inference-instruction',inferenceAlternativeUpdated);
  count=responses.filter(item=>item.type==='prompt-presets:save').length;
  await clickLabel('更新此预设');await waitCommand('prompt-presets:save',count);
  assert.equal(lastResponse('prompt-presets:save').ok,true,lastResponse('prompt-presets:save').error);
  assert.equal((await settings()).presets.find(preset=>preset.id===inferencePresetB.id).instruction,inferenceAlternativeUpdated);
  await presetAction('重命名预设');await setValue('input[aria-label="预设名称"]','材质与轮廓');
  count=responses.filter(item=>item.type==='prompt-presets:save').length;
  await clickLabel('保存名称','.app-dialog');await waitCommand('prompt-presets:save',count);await expectNoDialog();
  assert.equal((await settings()).presets.find(preset=>preset.id===inferencePresetB.id).name,'材质与轮廓');
  await setValue('select[aria-label="主体推理指令预设"]',`preset:${inferencePresetA.id}`);
  assert.equal(await js(`document.querySelector('#prompt-inference-instruction').value`),inferenceSubject);

  await phase('module-inference-drafts-and-presets-isolated-from-generation-and-roles');
  const inferenceComposition='INFERENCE_COMPOSITION_SENTINEL: describe relative placement and framing only.';
  const inferenceViewpoint='INFERENCE_UNUSED_VIEWPOINT_SENTINEL: use the supplied camera angle.';
  for(const [module,text] of [['composition',inferenceComposition],['style',''],['viewpoint',inferenceViewpoint]]){
    await selectItem(`module:${module}`);await click('input[aria-label="自定义推理指令"]');await setValue('#prompt-inference-instruction',text);
    const options=await js(`[...document.querySelector('#prompt-preset-select').options].map(option=>option.value)`);
    assert.ok(!options.includes(`preset:${inferencePresetA.id}`)&&!options.includes(`preset:${inferencePresetB.id}`),'Each module has an independent inference preset list');
    if(module==='style')assert.equal(await previewProse('inference'),'','Explicitly empty inference instruction is not replaced with the default');
  }
  await selectItem('role:general');assert.equal(await js(`document.querySelector('#prompt-role-instruction').value`),fineRole);
  const roleInferenceOptions=await js(`[...document.querySelector('#prompt-preset-select').options].map(option=>option.value)`);
  assert.ok(!roleInferenceOptions.includes(`preset:${inferencePresetA.id}`));
  await selectItem('module:subject');await selectModuleMode('generation');
  await assertDefaultField('#prompt-native_instruction',factoryInstructions.subject.native_instruction);
  const generationInferenceOptions=await js(`[...document.querySelector('#prompt-preset-select').options].map(option=>option.value)`);
  assert.ok(!generationInferenceOptions.includes(`preset:${inferencePresetA.id}`)&&!generationInferenceOptions.includes(`preset:${inferencePresetB.id}`),'Generation presets do not include inference presets from the same module');
  await selectModuleMode('inference');assert.equal(await js(`document.querySelector('#prompt-inference-instruction').value`),inferenceSubject,'Mode and category changes preserve each draft');
  await expectApplied(beforeInferenceSettings.customizations);assert.deepEqual((await settings()).inference_instructions,beforeInferenceSettings.inference_instructions);
  const inferenceOverrides={subject:inferenceSubject,composition:inferenceComposition,style:'',viewpoint:inferenceViewpoint};
  await apply(beforeInferenceSettings.customizations);
  assert.deepEqual((await settings()).inference_instructions,inferenceOverrides);assert.deepEqual((await persistedSettings()).inference_instructions,inferenceOverrides);
  assert.equal((await settings()).selected_presets['inference:subject'],inferencePresetA.id);
  assert.deepEqual((await settings()).customizations,beforeInferenceSettings.customizations,'Applying inference instructions preserves generation and role content');
  assert.equal(inferences.length,callsBeforeModuleInference,'Editing, previewing, and saving inference instructions does not call a model');
  await screenshot(1775,1050,'module-inference-presets');await screenshot(1120,800,'module-inference-presets');await screenshot(800,720,'module-inference-presets');

  await phase('module-inference-preset-switch-and-navigation-protect-draft');
  await setValue('#prompt-inference-instruction',inferenceSubject+' UNSAVED_INFERENCE');
  await setValue('select[aria-label="主体推理指令预设"]',`preset:${inferencePresetB.id}`);
  await until(()=>js(`document.querySelector('.app-dialog')?.textContent.includes('保留当前指令修改')`),'inference preset switch guard');
  await clickLabel('继续编辑','.app-dialog');await expectNoDialog();
  assert.match(await js(`document.querySelector('#prompt-inference-instruction').value`),/UNSAVED_INFERENCE/);
  await clickLabel('返回工作台','.settings-page-actions');
  await until(()=>js(`document.querySelector('.app-dialog')?.textContent.includes('核心指令尚未应用')`),'inference navigation guard');
  await clickLabel('继续编辑','.app-dialog');await expectNoDialog();
  await setValue('select[aria-label="主体推理指令预设"]',`preset:${inferencePresetB.id}`);
  await clickLabel('放弃修改并切换','.app-dialog');await expectNoDialog();
  assert.equal(await js(`document.querySelector('#prompt-inference-instruction').value`),inferenceAlternativeUpdated);
  assert.deepEqual((await settings()).inference_instructions,inferenceOverrides,'Selecting an inference preset remains a draft');
  await setValue('select[aria-label="主体推理指令预设"]',`preset:${inferencePresetA.id}`);
  assert.equal(await js(`document.querySelector('#prompt-inference-instruction').value`),inferenceSubject);

  await phase('module-inference-custom-rule-in-real-controller-request');
  const inferenceRecipe=structuredClone(controller.workspace.project.recipe),unusedViewpoint=inferenceRecipe.modules.find(module=>module.reference_type==='viewpoint');
  if(unusedViewpoint)unusedViewpoint.enabled=false;
  await execute({type:'recipe:save',recipe:inferenceRecipe});await infer();
  const inferenceRuleJob=inferences.at(-1),ruleSystem=inferenceRuleJob.chain_snapshot.system_instruction;
  assert.ok(ruleSystem.includes(inferenceSubject),'Participating subject instruction reaches the actual controller inference request');
  assert.ok(ruleSystem.includes(inferenceComposition),'Participating composition instruction reaches the request');
  assert.ok(!ruleSystem.includes(inferenceViewpoint),'A nonparticipating module does not inject its inference instruction');
  assert.ok(!ruleSystem.includes(defaultModuleInferenceInstructions.style),'Explicit empty override removes the style rule');
  assert.ok(ruleSystem.includes(fineRole),'The selected role instruction is preserved alongside module rules');
  assert.equal(inferenceRuleJob.adapted_input.system_instruction,ruleSystem);
  assert.ok(!inferenceRuleJob.chain_snapshot.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n').includes(inferenceSubject),'Module inference rules remain system instructions');
  assert.ok(!(await controller.view()).chain.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n').includes(inferenceSubject),'Module inference rules never enter image generation');

  await phase('module-inference-full-export-restart-and-legacy-import');
  const inferenceExportFile=path.join(base,'whole-system-with-inference-presets.json'),inferenceExport=await exportCurrent(inferenceExportFile);
  assert.deepEqual(inferenceExport.inference_instructions,inferenceOverrides);assert.equal(inferenceExport.selected_presets['inference:subject'],inferencePresetA.id);
  assert.equal(inferenceExport.presets.filter(preset=>preset.kind==='inference').length,2);
  const allInferencePresets=structuredClone(inferenceExport.presets);
  await execute({type:'project:save'});const inferenceRecord=(await controller.view()).project_record_id;
  assert.ok(inferenceRecord);await controller.shutdown();controller=await createController();
  await execute({type:'workspace:resume',id:inferenceRecord});await load();
  assert.deepEqual((await settings()).inference_instructions,inferenceOverrides);assert.deepEqual((await settings()).presets,allInferencePresets);
  assert.equal((await settings()).selected_presets['inference:subject'],inferencePresetA.id);
  await openCore();await selectItem('module:subject');await selectModuleMode('inference');
  assert.equal(await js(`document.querySelector('#prompt-inference-instruction').value`),inferenceSubject);
  assert.equal(await js(`document.querySelector('#prompt-preset-select').value`),`preset:${inferencePresetA.id}`);
  const inferenceLegacyFile=path.join(base,'legacy-v1-without-inference.json');await writeFile(inferenceLegacyFile,JSON.stringify(emptyCustomizations()));
  openPaths.push(inferenceLegacyFile);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,true,lastResponse('prompt-customizations:import').error);
  await apply(emptyCustomizations());
  assert.deepEqual((await settings()).inference_instructions,inferenceOverrides);assert.deepEqual((await settings()).presets,allInferencePresets);
  assert.equal((await settings()).selected_presets['inference:subject'],inferencePresetA.id,'Legacy imports retain inference configuration and its selection');
  openPaths.push(inferenceExportFile);count=responses.filter(item=>item.type==='prompt-customizations:import').length;
  await clickLabel('导入配置','.prompt-settings-transfer');await waitCommand('prompt-customizations:import',count);
  assert.equal(lastResponse('prompt-customizations:import').ok,true,lastResponse('prompt-customizations:import').error);
  await apply(inferenceExport.customizations);assert.deepEqual((await settings()).inference_instructions,inferenceOverrides);

  await phase('module-inference-delete-and-reset-preserve-other-content-and-library');
  await selectItem('module:subject');await selectModuleMode('inference');
  await clickLabel('恢复此项默认','.prompt-settings-context');await assertDefaultField('#prompt-inference-instruction',defaultModuleInferenceInstructions.subject);
  await apply(inferenceExport.customizations);
  assert.deepEqual((await settings()).inference_instructions,{composition:inferenceComposition,style:'',viewpoint:inferenceViewpoint},'Reset current inference only changes the selected module');
  assert.deepEqual((await settings()).presets,allInferencePresets);
  await setValue('select[aria-label="主体推理指令预设"]',`preset:${inferencePresetA.id}`);await apply(inferenceExport.customizations);
  await presetAction('删除预设');count=responses.filter(item=>item.type==='prompt-presets:save').length;
  await clickLabel('删除预设','.app-dialog');await waitCommand('prompt-presets:save',count);await expectNoDialog();
  assert.equal(lastResponse('prompt-presets:save').ok,true,lastResponse('prompt-presets:save').error);
  assert.equal(await js(`document.querySelector('#prompt-inference-instruction').value`),inferenceSubject);assert.equal(await js(`document.querySelector('#prompt-preset-select').value`),'custom');
  assert.deepEqual((await settings()).inference_instructions,inferenceOverrides);assert.equal((await settings()).selected_presets['inference:subject'],undefined);
  assert.ok(!(await settings()).presets.some(preset=>preset.id===inferencePresetA.id));assert.ok((await settings()).presets.some(preset=>preset.id===inferencePresetB.id));
  const inferenceLibraryAfterDelete=structuredClone((await settings()).presets);
  await clickLabel('全部恢复默认','.prompt-settings-transfer');await clickLabel('恢复默认','.app-dialog');await expectNoDialog();await apply(emptyCustomizations());
  assert.equal(Object.keys((await settings()).inference_instructions??{}).length,0);assert.deepEqual((await settings()).presets,inferenceLibraryAfterDelete);assert.deepEqual((await settings()).selected_presets,{});
  await assertDefaultField('#prompt-inference-instruction',defaultModuleInferenceInstructions.subject);
  const resetInferenceExport=await exportCurrent(path.join(base,'reset-with-inference-library.json'));
  assert.equal(Object.keys(resetInferenceExport.inference_instructions??{}).length,0);assert.deepEqual(resetInferenceExport.presets,inferenceLibraryAfterDelete);

  assert.equal(providerCalls,0);assert.equal(win.isVisible(),false);assert.deepEqual(rendererErrors,[]);
  assert.deepEqual(openPaths,[]);assert.deepEqual(savePaths,[]);
  await phase('complete');
  const report={passed:true,base,runtime,requestedScaleFactor,providerCalls,inferenceCalls:inferences.length,commands,responses,nativeDialogs,captures,rendererConsole,
    checks:['isolated-runtime-and-project','factory-text-visible-read-only-selectable','default-current-item-previews','custom-edit-starts-from-default','only-current-item-preview','preview-image-placeholders-from-one','native-and-numbered-independent','preview-does-not-apply','real-compilation-retains-project-image-order','save-applies-and-persists','invalid-template-not-applied','dirty-navigation-continue-discard-save','preset-save-without-application','duplicate-preset-name-rejected','preset-rename-keeps-id','preset-update-without-duplication','preset-selection-draft-until-apply','delete-active-preset-preserves-text','export-entire-system-including-library','role-preview-not-generation-preview','role-change-invalidates-auto-prompt','role-customization-in-real-inference-plan','role-not-in-image-generation','no-automatic-inference-on-settings-change','restart-persistence-and-auto-reuse','invalid-import-preserves-runtime-and-draft','full-import-restores-library-only-on-application','legacy-import-keeps-library','empty-custom-vs-default-preserved','cancel-import-preserves-values','restore-current-is-reversible-draft','reset-all-requires-apply','reset-preserves-library','reset-export-keeps-presets','three-viewports-no-horizontal-overflow','no-network']};
  report.checks.push('reserved-preset-id-selects-and-applies-user-content','unapplied-import-library-switch-guard-has-no-save-branch','preset-name-initial-focus-tab-loop-and-escape','valid-preset-save-ignores-unrelated-invalid-draft');
  report.checks.push('compact-single-row-settings-toolbar','wide-module-and-role-title-presets-side-by-side','default-fields-and-help-visible-above-savebar','no-unsupported-field-help','screenshot-pixels-match-device-scale');
  report.checks.push('role-presets-save-update-rename-without-application','role-presets-isolated-by-role-and-from-modules','selected-role-preset-enters-system-verbatim-only','role-presets-export-and-restart-with-selection','legacy-import-and-reset-preserve-role-library','delete-selected-role-preset-retains-instruction');
  report.checks.push('four-module-inference-read-only-defaults','inference-plain-preview-and-default-copy','inference-presets-save-update-rename-isolated-from-generation-and-roles','all-four-inference-drafts-preserved-across-modes','inference-preset-and-navigation-draft-protection','participating-inference-rule-in-real-controller-request','nonparticipating-inference-rule-excluded','inference-full-export-restart-and-legacy-import','inference-current-reset-and-delete-preserve-other-content','reset-all-keeps-inference-preset-library');
  const filename=path.join(base,'report.json');await writeFile(filename,JSON.stringify(report,null,2));
  await controller.shutdown();controller=undefined;win.destroy();console.log(JSON.stringify({...report,report:filename}));app.exit(0);
}).catch(async error=>{
  console.error(error);
  if(base){
    await writeFile(path.join(base,'failure.json'),JSON.stringify({stage:lastStage,error:error.stack??String(error),requestedScaleFactor,lastScreenshotLayout,paintSize:lastFrame?.size,providerCalls,inferenceCalls:inferences.length,commands,responses,nativeDialogs,rendererErrors,rendererConsole,lastRendererScript},null,2)).catch(()=>{});
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
