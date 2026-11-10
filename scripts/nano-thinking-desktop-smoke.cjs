// Real hidden Electron renderer + DesktopController against an isolated library.
// Generation is an explicit in-process image fixture. No discovery or provider
// request is allowed, and the user's installed/development runtime is not read.
const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');
const {mkdir,mkdtemp,writeFile,appendFile,readFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict'),sharp=require('sharp');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const adapter='gemini-generate-content',connectionId='connection_nano_smoke',legacyId='model_nano_21_smoke',unknownRemote='private-nano-studio-alias';
const gptAdapter='openai-images',gptConnectionId='connection_gpt_smoke',legacyOverrideId='model_legacy_nano_override_smoke';
const nano21='nano-banana-2.1',nanoPro='nano-banana-pro',gpt2='gpt-image-2',sunburst='gpt-image-2-5-sunburst';
let controller,win,base,runtime,lastFrame,frameSequence=0,lastStage='startup',providerCalls=0;
const commands=[],executions=[],captures=[],layouts=[];
globalThis.fetch=async()=>{providerCalls++;throw Error('External requests are forbidden in Nano thinking smoke.');};
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});
  base=await mkdtemp(path.join(root,'.local','nano-thinking-ui-'));runtime=path.join(base,'runtime');
  app.setPath('userData',path.join(base,'electron'));
  const phase=async stage=>{lastStage=stage;await appendFile(path.join(base,'stages.jsonl'),JSON.stringify({stage,time:new Date().toISOString()})+'\n');};
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {registerWindowChrome}=await import('../dist-host/desktop/window-chrome.js');
  const {modelForEnrollment}=await import('../dist-host/protocols/model-catalog.js');
  win=new BrowserWindow({width:1775,height:1050,show:false,backgroundColor:'#f6f5f1',
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,offscreen:true}});
  win.setMenuBarVisibility(false);registerWindowChrome(ipcMain,()=>win);
  win.webContents.on('paint',(_event,_dirty,image)=>{if(!image.isEmpty()){lastFrame={png:image.toPNG(),size:image.getSize()};frameSequence++;}});
  win.webContents.setFrameRate(30);
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{providerCalls++;callback({cancel:true});});
  const output=await sharp({create:{width:512,height:512,channels:3,background:'#c0cfb7'}}).png().toBuffer();
  const createController=async()=>{
    const next=await DesktopController.create(runtime,()=>win,{deferStartup:true,projectRoot:base,showMessage:async()=>{throw Error('Unexpected native dialog in Nano thinking smoke.');}});
    next.executors.probe=async()=>{providerCalls++;throw Error('Model discovery is forbidden in Nano thinking smoke.');};
    next.executors.execute=async(context,_signal,progress)=>{
      assert.equal(context.model.purpose,'generation');
      assert.ok([connectionId,gptConnectionId].includes(context.model.connection_id),'only an isolated fixture connection may execute');
      assert.equal(context.model.adapter_id,context.model.connection_id===connectionId?adapter:gptAdapter);
      executions.push({model:{model_config_id:context.model.model_config_id,model:context.model.model,adapter_id:context.model.adapter_id,model_variant_override:context.model.model_variant_override,nano_model_override:context.model.nano_model_override},parameters:structuredClone(context.job.recipe_snapshot.core_parameters),snapshot:structuredClone(context.job.model_snapshot),plan:structuredClone(context.job.execution_plan)});
      await progress('本地模拟图片返回',80);
      return {images:[{bytes:output,format:'png',width:512,height:512}]};
    };
    return next;
  };
  controller=await createController();
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  const allowed=new Set(['state','model:save','model:assign','recipe:save','project:save','job:start','recipe:select-model','recipe:reset-parameters']);
  ipcMain.handle('ediro:command',async(_event,command)=>{assert.ok(allowed.has(command.type),'unexpected UI command '+command.type);commands.push(command.type);return controller.execute(command);});
  const execute=async command=>{const response=await controller.execute(command);assert.equal(response.ok,true,response.error);if(response.state)win.webContents.send('ediro:state',response.state);return response;};
  const js=async code=>{const result=await win.webContents.executeJavaScript(`(()=>{try{return {ok:true,value:(${code})};}catch(error){return {ok:false,error:error.stack??String(error)};}})()`);if(!result.ok)throw Error(result.error);return result.value;};
  const until=async(check,label)=>{for(let attempt=0;attempt<300;attempt++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const visible=selector=>js(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const click=async(label,scope='.global-settings')=>{const button=`[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(el=>(el.textContent.trim()===${JSON.stringify(label)}||el.getAttribute('aria-label')===${JSON.stringify(label)})&&el.getClientRects().length)`;await until(()=>js(`(()=>{const button=${button};return !!button&&!button.disabled&&!button.closest('[inert]');})()`),'button ready: '+label);await js(`(()=>{const button=${button};if(!button||button.disabled||button.closest('[inert]'))throw Error('Button unavailable: '+${JSON.stringify(label)});button.click();})()`);await wait(40);};
  const clickSelector=async selector=>{await js(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled||button.closest('[inert]'))throw Error('Control unavailable: '+${JSON.stringify(selector)});button.click();})()`);await wait(40);};
  const select=async(selector,value)=>{await js(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field||field.disabled||field.closest('[inert]'))throw Error('Select unavailable: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(40);};
  const field=async(label,value,scope)=>{await js(`(()=>{const field=[...document.querySelectorAll(${JSON.stringify(scope+' label')})].find(el=>el.textContent.startsWith(${JSON.stringify(label)})&&el.getClientRects().length)?.querySelector('input');if(!field||field.disabled)throw Error('Field unavailable: '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(40);};
  const detail='.settings-model-detail',thinking=detail+' select[aria-label="推理强度"]',override=detail+' select[aria-label="家族型号"]';
  const library=()=>controller.workspace.models.snapshot(),model=id=>library().models.find(item=>item.model_config_id===id),thinkingValue=id=>model(id).defaults.extensions?.[adapter]?.thinking_level;
  const savedLibrary=async()=>JSON.parse(await readFile(path.join(runtime,'model-library.v3.json'),'utf8'));
  const load=async()=>{await win.loadFile(path.join(root,'dist','index.html'));await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'renderer loaded');};
  const openSettings=async id=>{if(!await visible('.global-settings'))await clickSelector('.settings-button');await until(()=>visible(detail),'model settings visible');await clickSelector(`[data-model-id="${id}"]`);await click('默认参数',detail);};
  const closeSettings=async()=>{await click('返回工作台','.settings-page-actions');await until(async()=>!await visible('.global-settings'),'settings closed');};
  const save=async(id,check)=>{await click('保存设置',detail);await until(()=>Promise.resolve(check(model(id))),'model settings persisted');await until(()=>js(`document.querySelector('.settings-model-detail .settings-status')?.textContent!=='未保存'`),'model draft clean');};
  const familyVariant=()=>js(`document.querySelector(${JSON.stringify(override)})?.value`);
  const qualityField=`[...document.querySelectorAll(${JSON.stringify(detail+' .model-parameter-form label')})].find(label=>label.textContent.startsWith('默认质量'))?.querySelector('select')`;
  const qualityValues=()=>js(`[...(${qualityField}).options].map(option=>option.value)`);
  const selectQuality=async value=>{await js(`(()=>{const field=${qualityField};if(!field||field.disabled)throw Error('Quality unavailable');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(40);};
  const checkIdentityControls=async()=>{
    assert.equal(await visible(override),true,'family model appears directly on the defaults page');
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(detail+' select[aria-label="型号识别方式"]')}).length`),0);
    assert.equal(await js(`[...document.querySelectorAll(${JSON.stringify(detail+' summary')})].some(element=>element.textContent.trim()==='修正型号识别')`),false);
    assert.doesNotMatch(await js(`document.querySelector(${JSON.stringify(detail)}).textContent`),/自动识别：|手动指定：/,'no separate identification-source notice');
    assert.equal(await js(`document.querySelector(${JSON.stringify(override)}).closest('details')===null`),true,'family model does not require expanding a disclosure');
  };
  const revealThinking=async()=>{await js(`(()=>{let element=document.querySelector(${JSON.stringify(thinking)});if(!element)throw Error('Nano thinking field missing');for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;})()`);};
  const checkThreeLevels=async()=>{await revealThinking();assert.deepEqual(await js(`[...document.querySelector(${JSON.stringify(thinking)}).options].map(option=>option.value)`),['','minimal','medium','high']);};
  const capture=async name=>{
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before=frameSequence;win.webContents.startPainting();win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>before&&lastFrame?.png.length),'fresh Nano settings screenshot');
    await wait(120);const settled=frameSequence;win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>settled&&lastFrame?.png.length),'settled Nano settings screenshot');
    const filename=path.join(base,name+'.png');await writeFile(filename,lastFrame.png);captures.push(filename);assert.equal(win.isVisible(),false);
  };
  const checkIdentityLayout=async width=>{
    win.setSize(width,1050);await wait(120);
    await js(`(()=>{const panel=document.querySelector(${JSON.stringify(detail)});panel.scrollTop=0;document.querySelector('.settings-columns').scrollLeft=0;})()`);
    const layout=await js(`(()=>{
      const panel=document.querySelector(${JSON.stringify(detail)}),identity=panel.querySelector('.settings-model-identity'),family=panel.querySelector('select[aria-label="家族型号"]');
      const name=panel.querySelector('input[aria-label="模型显示名称"]'),remote=panel.querySelector('input[aria-label="渠道模型 ID"]');
      if(!identity||!family||!name||!remote)throw Error('Default-page model identity controls missing');
      const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const labels=[name.closest('label'),remote.closest('label'),family.closest('label')],parameters=[...panel.querySelectorAll('.settings-parameter-grid>label')].filter(element=>element.getClientRects().length);
      const r=rect(panel),controls=[name,remote,family,...parameters.flatMap(label=>[...label.querySelectorAll('input,select')])];
      const overflow=controls.filter(element=>{const b=rect(element);return !element.getClientRects().length||b.width<=0||b.left<r.left-1||b.right>r.right+1;}).map(element=>element.getAttribute('aria-label')||element.closest('label').textContent.trim());
      return {width:innerWidth,panel:rect(panel),identity:rect(identity),name:rect(labels[0]),remote:rect(labels[1]),family:rect(labels[2]),summary:rect(panel.querySelector('.settings-preset-summary')),parameters:parameters.slice(0,2).map(rect),overflow,panelOverflow:panel.scrollWidth>panel.clientWidth+2};
    })()`);
    layouts.push(layout);assert.deepEqual(layout.overflow,[],`default-page controls fit at ${width}`);assert.equal(layout.panelOverflow,false,`default-page panel has no horizontal overflow at ${width}`);
    assert.ok(layout.name.top>=layout.summary.bottom-1,'identity controls follow the family description');
    assert.ok(layout.family.top>=Math.max(layout.name.bottom,layout.remote.bottom)-1,'family model occupies its own row');
    assert.ok(Math.abs(layout.family.left-Math.min(layout.name.left,layout.remote.left))<=2&&Math.abs(layout.family.right-Math.max(layout.name.right,layout.remote.right))<=2,'family model spans the identity row width');
    const paired=Math.abs(layout.name.top-layout.remote.top)<=2&&layout.remote.left>=layout.name.right-1;
    const stacked=layout.remote.top>=layout.name.bottom-1&&Math.abs(layout.name.left-layout.remote.left)<=2;
    assert.ok(paired||stacked,'name and channel ID are paired or cleanly stacked');assert.ok(layout.parameters.length===2,'basic parameter pair is available');
    const parametersPaired=Math.abs(layout.parameters[0].top-layout.parameters[1].top)<=2&&layout.parameters[1].left>=layout.parameters[0].right-1;
    const parametersStacked=layout.parameters[1].top>=layout.parameters[0].bottom-1&&Math.abs(layout.parameters[0].left-layout.parameters[1].left)<=2;
    assert.ok(parametersPaired||parametersStacked,'parameters are paired or cleanly stacked');
    if(width===1775){assert.equal(paired,true,'wide identity fields use two columns');assert.equal(parametersPaired,true,'wide parameters use two columns');}
    if(width===800){assert.equal(stacked,true,'narrow identity fields fall back to one column');assert.equal(parametersStacked,true,'narrow parameters fall back to one column');}
    await capture(`default-page-layout-${width}`);
  };
  const restart=async id=>{await controller.shutdown();controller=await createController();await load();await openSettings(id);};
  const generate=async(id,expectedThinking,expectedOverride,expectedQuality)=>{
    if(await visible('.global-settings'))await closeSettings();
    await execute({type:'project:create',name:'家族型号参数本地验证'});await execute({type:'recipe:select-model',model_config_id:id});await execute({type:'recipe:reset-parameters'});
    const recipe=structuredClone(controller.workspace.project.recipe),prompt=recipe.modules.find(item=>item.reference_type==='prompt');prompt.user_instruction='拍摄一件商品，保持结构清晰，使用柔和光线。';prompt.auto_prompt=false;
    await execute({type:'recipe:save',recipe});
    assert.equal(await js(`document.querySelectorAll('.workbench select[aria-label="推理强度"],.workbench select[aria-label="家族型号"]').length`),0,'Nano model defaults are absent from workbench controls');
    await until(()=>js(`!document.querySelector('.generate-button').disabled`),'generation ready');const before=executions.length;await clickSelector('.generate-button');
    await until(()=>Promise.resolve(executions.length===before+1),'isolated generation executor');
    await until(()=>Promise.resolve(controller.workspace.project.jobs.every(job=>['succeeded','failed','cancelled'].includes(job.status))),'isolated generation complete');
    const job=controller.workspace.project.jobs.at(-1);assert.equal(job.status,'succeeded',job.error);
    const execution=executions.at(-1);assert.equal(execution.model.model_config_id,id);assert.equal(execution.parameters.extensions?.[adapter]?.thinking_level,expectedThinking);assert.equal(execution.model.model_variant_override,expectedOverride);assert.equal(execution.snapshot.model_variant_override,expectedOverride);assert.equal(execution.model.nano_model_override,undefined);assert.equal(execution.snapshot.nano_model_override,undefined);
    if(expectedQuality!==undefined)assert.equal(execution.parameters.quality,expectedQuality);
    assert.equal(execution.model.model,model(id).model,'manual identification does not rewrite provider model ID');
    assert.equal(execution.snapshot.model,model(id).model,'original provider ID reaches the task snapshot');
    return execution;
  };
  const enroll=async(platformTitle,family,remote)=>{
    if(!await visible('.global-settings'))await clickSelector('.settings-button');
    await js(`(()=>{const platform=[...document.querySelectorAll('.platform-row')].find(el=>el.querySelector('b')?.textContent===${JSON.stringify(platformTitle)});if(!platform)throw Error('Fixture platform missing');platform.click();})()`);await wait(40);
    await click('＋ 添加模型','.settings-library-heading');await until(()=>visible('.settings-enrollment'),'manual enrollment opened');await click('手动添加','.settings-enrollment');
    await field('平台模型 ID',remote,'.enrollment-manual');await select('.enrollment-manual select[aria-label="模型家族"]',family);
    assert.equal(await js(`document.querySelectorAll('.enrollment-manual select[aria-label="家族型号"]').length`),0,'family enrollment has no additional variant step');
    await click('添加到模型库','.enrollment-manual');await until(()=>Promise.resolve(library().models.some(item=>item.model===remote)),'fixture family model enrolled');
    const id=library().models.find(item=>item.model===remote).model_config_id;
    await click('收起添加','.settings-enrollment');await openSettings(id);return id;
  };

  await phase('prepare-legacy-nano-21-library');
  await controller.workspace.models.saveConnection({connection_id:connectionId,title:'Nano 本地验收平台',adapter_id:adapter,endpoint:'https://nano-thinking.invalid/v1beta',enabled:true},'local-fixture-only-not-a-provider-key');
  await controller.workspace.models.saveConnection({connection_id:gptConnectionId,title:'GPT 本地验收平台',adapter_id:gptAdapter,endpoint:'https://gpt-variant.invalid/v1',enabled:true},'local-fixture-only-not-a-provider-key');
  const legacy=modelForEnrollment('nano',adapter,legacyId,connectionId,'gemini-nano-banana-2.1');
  delete legacy.preset_id;delete legacy.nano_model_override;legacy.title='旧版 Nano Banana 2.1';legacy.origin='user';legacy.independent_defaults=true;
  legacy.generation_contract.fields=legacy.generation_contract.fields.filter(item=>item.key!=='thinking_level');delete legacy.defaults.extensions?.[adapter]?.thinking_level;
  const legacyOverride=structuredClone(legacy);legacyOverride.model_config_id=legacyOverrideId;legacyOverride.model='legacy-private-nano-route';legacyOverride.title='旧字段 Nano 2.1';legacyOverride.nano_model_override='2.1';legacyOverride.defaults.extensions[adapter].thinking_level='medium';delete legacyOverride.model_variant_override;
  const fixture=library();fixture.models=[legacy,legacyOverride];fixture.assignments={generation_default:legacyId};
  await controller.shutdown();controller=undefined;await writeFile(path.join(runtime,'model-library.v3.json'),JSON.stringify(fixture,null,2));
  const rawLegacy=(await savedLibrary()).models.find(item=>item.model_config_id===legacyId);
  assert.equal(rawLegacy.preset_id,undefined);assert.equal(rawLegacy.generation_contract.fields.some(item=>item.key==='thinking_level'),false);assert.equal(rawLegacy.defaults.extensions?.[adapter]?.thinking_level,undefined);
  const rawOverride=(await savedLibrary()).models.find(item=>item.model_config_id===legacyOverrideId);assert.equal(rawOverride.nano_model_override,'2.1');assert.equal(rawOverride.model_variant_override,undefined);
  controller=await createController();await load();await openSettings(legacyId);

  await phase('legacy-model-identification-and-default-choice');
  assert.equal(model(legacyId).preset_id,undefined);await checkThreeLevels();assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)}).value`),'');await checkIdentityControls();assert.equal(await familyVariant(),nano21);
  await capture('legacy-nano-21-defaults');
  await phase('default-page-responsive-identity-and-parameters');
  for(const width of [1775,1120,800])await checkIdentityLayout(width);win.setSize(1775,1050);await wait(120);
  const originalTitle=model(legacyId).title;await field('模型显示名称','临时显示名称',detail);await click('还原修改',detail);
  assert.equal(await js(`document.querySelector(${JSON.stringify(detail+' input[aria-label="模型显示名称"]')}).value`),originalTitle,'revert restores the model display name');
  const editedTitle='默认页命名 Nano Banana 2.1';await field('模型显示名称',editedTitle,detail);
  await select(thinking,'high');await save(legacyId,entry=>entry.title===editedTitle&&entry.defaults.extensions?.[adapter]?.thinking_level==='high');
  assert.equal((await savedLibrary()).models.find(item=>item.model_config_id===legacyId).defaults.extensions[adapter].thinking_level,'high');
  await restart(legacyId);await checkThreeLevels();assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)}).value`),'high');assert.equal(model(legacyId).title,editedTitle);assert.equal(await familyVariant(),nano21);

  await phase('typing-channel-id-preserves-thinking-until-complete');
  const originalRemote=model(legacyId).model,previewRemote=originalRemote+'-preview';
  const channelInput=`[...document.querySelectorAll(${JSON.stringify(detail+' label')})].find(label=>label.textContent.startsWith('渠道模型 ID'))?.querySelector('input')`;
  await checkIdentityControls();
  await js(`(()=>{const input=${channelInput};if(!input||input.disabled)throw Error('Channel ID unavailable');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(originalRemote+'-')});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(40);
  assert.equal(await js(`document.activeElement===(${channelInput})`),true,'intermediate ID edit remains focused');
  assert.equal(model(legacyId).model,originalRemote);assert.equal(thinkingValue(legacyId),'high');
  assert.equal(await visible(detail+' button[aria-label="清除不适用参数thinking_level"]'),true,'intermediate unknown ID still retains its explicit thinking value');
  assert.equal(await js(`document.querySelector(${JSON.stringify(detail+' .settings-notice[role="status"]')})===null`),true,'typing alone must not clear the draft value');
  await js(`(()=>{const input=${channelInput};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(previewRemote)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(40);
  assert.equal(await js(`document.activeElement===(${channelInput})`),true);
  assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)}).value`),'high','recognized completed ID keeps thinking before blur');
  await js(`(${channelInput}).blur()`);await wait(40);await click('默认参数',detail);await checkThreeLevels();assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)}).value`),'high');
  await save(legacyId,entry=>entry.model===previewRemote&&entry.defaults.extensions?.[adapter]?.thinking_level==='high');
  await restart(legacyId);await checkThreeLevels();assert.equal(model(legacyId).model,previewRemote);assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)}).value`),'high');
  const previewExecution=await generate(legacyId,'high',undefined);assert.equal(previewExecution.model.model,previewRemote);assert.equal(previewExecution.snapshot.model,previewRemote,'complete provider ID reaches the execution snapshot');

  await phase('manual-identity-overrides-recognized-provider-id');
  await openSettings(legacyId);await select(override,nanoPro);
  assert.equal(await familyVariant(),nanoPro);assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)})===null`),true);
  await save(legacyId,entry=>entry.model_variant_override===nanoPro&&entry.nano_model_override===undefined);assert.equal(thinkingValue(legacyId),'high');assert.equal(model(legacyId).model,previewRemote);
  await select(override,'auto');await checkThreeLevels();assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)}).value`),'high');assert.equal(await familyVariant(),nano21,'auto command selects the detected variant');
  await save(legacyId,entry=>entry.model_variant_override===undefined&&entry.nano_model_override===undefined);assert.equal(model(legacyId).model,previewRemote);

  await phase('unknown-model-keeps-family-enrollment-and-omits-thinking');
  await openSettings(legacyId);
  await js(`(()=>{const platform=[...document.querySelectorAll('.platform-row')].find(el=>el.querySelector('b')?.textContent==='Nano 本地验收平台');if(!platform)throw Error('Fixture platform missing');platform.click();})()`);await wait(40);
  await click('＋ 添加模型','.settings-library-heading');await until(()=>visible('.settings-enrollment'),'manual enrollment opened');await click('手动添加','.settings-enrollment');
  await field('平台模型 ID',unknownRemote,'.enrollment-manual');await select('.enrollment-manual select[aria-label="模型家族"]','nano');
  assert.equal(await js(`document.querySelectorAll('.enrollment-manual select[aria-label="家族型号"]').length`),0,'enrollment remains a family choice');
  await click('添加到模型库','.enrollment-manual');await until(()=>Promise.resolve(library().models.some(item=>item.model===unknownRemote)),'unknown Nano ID enrolled');
  const unknownId=library().models.find(item=>item.model===unknownRemote).model_config_id;
  assert.equal(model(unknownId).family,'nano');assert.equal(model(unknownId).preset_id,undefined);assert.equal(thinkingValue(unknownId),undefined);assert.equal(model(unknownId).nano_model_override,undefined);
  await click('收起添加','.settings-enrollment');await openSettings(unknownId);
  assert.equal(await familyVariant(),'');assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)})===null`),true);await checkIdentityControls();
  await capture('unknown-nano-defaults');await generate(unknownId,undefined,undefined);

  await phase('manual-model-correction-persists-without-changing-id');
  await openSettings(unknownId);await select(override,nano21);await checkThreeLevels();await select(thinking,'medium');
  assert.equal(model(unknownId).model_variant_override,undefined,'correction stays in the editor until saved');assert.equal(model(unknownId).nano_model_override,undefined);assert.equal(thinkingValue(unknownId),undefined);
  await save(unknownId,entry=>entry.model_variant_override===nano21&&entry.nano_model_override===undefined&&entry.defaults.extensions?.[adapter]?.thinking_level==='medium');assert.equal(model(unknownId).model,unknownRemote);
  await restart(unknownId);await checkThreeLevels();assert.equal(await familyVariant(),nano21);assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)}).value`),'medium');
  await checkIdentityControls();
  await js(`(()=>{document.querySelector(${JSON.stringify(override)}).scrollIntoView({block:'center',behavior:'instant'});return true;})()`);await capture('manual-nano-21-defaults');
  await generate(unknownId,'medium',nano21);

  await phase('switch-pro-clears-incompatible-default');
  await openSettings(unknownId);await select(override,nanoPro);
  assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)})===null`),true);assert.match(await js(`document.querySelector(${JSON.stringify(detail)}).textContent`),/固定高/);
  assert.match(await js(`document.querySelector(${JSON.stringify(detail+' .settings-notice[role="status"]')})?.textContent??''`),/默认/);assert.equal(thinkingValue(unknownId),'medium','incompatible default is cleared in the draft before saving');
  await js(`(()=>{document.querySelector(${JSON.stringify(detail+' .settings-primary-parameter')}).scrollIntoView({block:'center',behavior:'instant'});return true;})()`);await capture('manual-pro-defaults');
  await save(unknownId,entry=>entry.model_variant_override===nanoPro&&entry.nano_model_override===undefined&&entry.defaults.extensions?.[adapter]?.thinking_level===undefined);assert.equal(model(unknownId).model,unknownRemote);
  await restart(unknownId);assert.equal(await familyVariant(),nanoPro);assert.equal(thinkingValue(unknownId),undefined);
  await generate(unknownId,undefined,nanoPro);

  await phase('restore-automatic-identification');
  await openSettings(unknownId);await select(override,'auto');assert.equal(await familyVariant(),'');await save(unknownId,entry=>entry.model_variant_override===undefined&&entry.nano_model_override===undefined);
  await restart(unknownId);assert.equal(await familyVariant(),'');assert.equal(thinkingValue(unknownId),undefined);assert.equal(model(unknownId).model,unknownRemote);
  await checkIdentityControls();await generate(unknownId,undefined,undefined);
  assert.equal(model(legacyId).defaults.extensions[adapter].thinking_level,'high','other model defaults remain independent');

  await phase('legacy-nano-override-readable-and-replaced-by-generic-choice');
  await openSettings(legacyOverrideId);await checkThreeLevels();assert.equal(await familyVariant(),nano21);assert.equal(await js(`document.querySelector(${JSON.stringify(thinking)}).value`),'medium');
  assert.equal(model(legacyOverrideId).model,'legacy-private-nano-route');
  await select(override,nano21);await save(legacyOverrideId,entry=>entry.model_variant_override===nano21&&entry.nano_model_override===undefined);
  await restart(legacyOverrideId);assert.equal(await familyVariant(),nano21);assert.equal(thinkingValue(legacyOverrideId),'medium');
  const migratedOverride=(await savedLibrary()).models.find(item=>item.model_config_id===legacyOverrideId);assert.equal(migratedOverride.model_variant_override,nano21);assert.equal(migratedOverride.nano_model_override,undefined);assert.equal(migratedOverride.model,'legacy-private-nano-route');

  await phase('gpt-family-enrollment-identifies-sunburst-without-extra-step');
  const knownGptId=await enroll('GPT 本地验收平台','gpt-image','gpt-image-2.5-sunburst');
  await checkIdentityControls();assert.equal(model(knownGptId).family,'gpt-image');assert.equal(await familyVariant(),sunburst);assert.equal(model(knownGptId).model_variant_override,undefined);
  assert.deepEqual(await qualityValues(),['auto','low','medium','high','xhigh','max']);
  await selectQuality('high');await save(knownGptId,entry=>entry.defaults.quality==='high');
  await restart(knownGptId);assert.equal(await familyVariant(),sunburst);assert.equal(await js(`(${qualityField}).value`),'high');
  await capture('gpt-sunburst-defaults');
  const knownGptDefaults=structuredClone(model(knownGptId).defaults),nanoDefaults=structuredClone(model(legacyId).defaults);

  await phase('gpt-unknown-alias-selects-image-2-with-independent-defaults');
  const unknownGptRemote='private-gpt-art-studio-alias',unknownGptId=await enroll('GPT 本地验收平台','gpt-image',unknownGptRemote);
  assert.equal(await familyVariant(),'');assert.equal(model(unknownGptId).model_variant_override,undefined);assert.equal(model(unknownGptId).nano_model_override,undefined);
  const unknownQualityValues=await qualityValues();
  await select(override,gpt2);assert.equal(await familyVariant(),gpt2);assert.deepEqual(await qualityValues(),['auto','low','medium','high']);
  await selectQuality('high');assert.equal(model(unknownGptId).model_variant_override,undefined,'GPT model choice is a draft until saved');
  await save(unknownGptId,entry=>entry.model_variant_override===gpt2&&entry.defaults.quality==='high');
  await restart(unknownGptId);assert.equal(await familyVariant(),gpt2);assert.equal(await js(`(${qualityField}).value`),'high');assert.equal(model(unknownGptId).model,unknownGptRemote);assert.equal(model(unknownGptId).nano_model_override,undefined);
  await capture('gpt-alias-image-2-defaults');await generate(unknownGptId,undefined,gpt2,'high');

  await phase('gpt-alias-sunburst-unlocks-quality-and-keeps-provider-id');
  await openSettings(unknownGptId);await select(override,sunburst);assert.equal(await familyVariant(),sunburst);assert.deepEqual(await qualityValues(),['auto','low','medium','high','xhigh','max']);
  await selectQuality('max');await save(unknownGptId,entry=>entry.model_variant_override===sunburst&&entry.defaults.quality==='max');
  await restart(unknownGptId);assert.equal(await familyVariant(),sunburst);assert.equal(await js(`(${qualityField}).value`),'max');assert.equal(model(unknownGptId).model,unknownGptRemote);
  assert.deepEqual(model(knownGptId).defaults,knownGptDefaults,'GPT entries keep independent defaults');assert.deepEqual(model(legacyId).defaults,nanoDefaults,'GPT variant edits do not affect Nano defaults');
  const savedGpt=(await savedLibrary()).models.find(item=>item.model_config_id===unknownGptId);assert.equal(savedGpt.model_variant_override,sunburst);assert.equal(savedGpt.nano_model_override,undefined);assert.equal(savedGpt.model,unknownGptRemote);
  await capture('gpt-alias-sunburst-defaults');await generate(unknownGptId,undefined,sunburst,'max');

  await phase('gpt-restore-automatic-identification-and-independent-defaults');
  await openSettings(unknownGptId);await select(override,'auto');assert.equal(await familyVariant(),'');assert.deepEqual(await qualityValues(),unknownQualityValues);
  await save(unknownGptId,entry=>entry.model_variant_override===undefined&&entry.nano_model_override===undefined);
  await restart(unknownGptId);assert.equal(await familyVariant(),'');assert.equal(model(unknownGptId).model,unknownGptRemote);
  assert.deepEqual(model(knownGptId).defaults,knownGptDefaults);assert.deepEqual(model(legacyId).defaults,nanoDefaults);
  await generate(unknownGptId,undefined,undefined,model(unknownGptId).defaults.quality);
  assert.equal(providerCalls,0);assert.equal(win.isVisible(),false);await phase('complete');
  const report={passed:true,base,runtime,providerCalls,commands,executions,captures,layouts,checks:['legacy-nano-21-without-preset-or-thinking-contract','automatic-model-identification','three-levels-and-model-default','thinking-default-save-and-restart','default-page-model-title-save-and-restart','default-page-identity-controls-after-family-summary','family-model-direct-select-without-old-disclosure-or-source-notice','family-model-select-shows-effective-variant','responsive-default-page-at-1775-1120-and-800','wide-identity-and-parameters-use-two-columns','narrow-identity-and-parameters-stack','family-model-occupies-full-row','unknown-id-enrolls-as-nano-family','unknown-model-omits-thinking','manual-correction-draft-only-until-save','manual-21-correction-save-and-restart','correction-keeps-provider-model-id','pro-clears-incompatible-thinking-default','pro-correction-save-and-restart','restore-auto-identification','other-model-defaults-remain-independent','workbench-hides-nano-thinking-control','generation-snapshot-retains-thinking-and-override','no-network']};
  report.checks.push('model-display-name-revert-restores-saved-value','intermediate-channel-id-keeps-thinking-draft','completed-preview-id-blur-save-restart-keeps-high','complete-channel-id-in-execution-snapshot','manual-correction-takes-priority-over-recognized-id');
  report.checks.push('legacy-nano-override-readable','ui-replaces-legacy-nano-override-with-generic-field','gpt-family-enrollment-no-extra-step','gpt-known-sunburst-identification','gpt-unknown-alias-image-2-quality-options','gpt-sunburst-expanded-quality-options','gpt-generic-override-save-and-restart','gpt-original-provider-id-preserved','gpt-and-nano-defaults-independent','gpt-restore-auto-identification','gpt-generation-snapshot-keeps-generic-override-and-quality');
  const reportPath=path.join(base,'report.json');await writeFile(reportPath,JSON.stringify(report,null,2));
  await controller.shutdown();controller=undefined;win.destroy();console.log(JSON.stringify({...report,report:reportPath}));app.exit(0);
}).catch(async error=>{
  console.error(error);
  if(base){
    await writeFile(path.join(base,'failure.json'),JSON.stringify({stage:lastStage,error:error.stack??String(error),providerCalls,executions,layouts},null,2)).catch(()=>{});
    if(win&&!win.isDestroyed()){
      await writeFile(path.join(base,'failure.html'),await win.webContents.executeJavaScript('document.documentElement.outerHTML')).catch(()=>{});
      if(lastFrame)await writeFile(path.join(base,'failure.png'),lastFrame.png).catch(()=>{});
    }
    console.error('Failure stage: '+lastStage+'; artifacts: '+base);
  }
  if(controller)try{await controller.shutdown();}catch{}
  app.exit(1);
});
