// Real hidden Electron renderer + DesktopController. All inference and image
// execution is an explicit in-process fixture; external requests are forbidden.
// Run with Electron after npm run build. Never reads the user's runtime.
const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');
const {mkdir,mkdtemp,writeFile,appendFile,readFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let controller,win,base,lastFrame,frameSequence=0,lastStage='startup',providerCalls=0;
const captures=[],inferences=[],generations=[],commands=[];
let failNextInference=false,holdNextInference=false,releaseInference;
globalThis.fetch=async()=>{providerCalls++;throw Error('External requests are forbidden in automatic-prompt smoke.');};
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});
  base=await mkdtemp(path.join(root,'.local','auto-prompt-ui-'));
  app.setPath('userData',path.join(base,'electron'));
  const phase=async name=>{lastStage=name;await appendFile(path.join(base,'stages.jsonl'),JSON.stringify({stage:name,time:new Date().toISOString()})+'\n');};
  const runtime=path.join(base,'runtime');
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {registerWindowChrome}=await import('../dist-host/desktop/window-chrome.js');
  win=new BrowserWindow({width:1775,height:1050,show:false,backgroundColor:'#f6f5f1',
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,offscreen:true}});
  win.setMenuBarVisibility(false);registerWindowChrome(ipcMain,()=>win);
  win.webContents.on('paint',(_event,_dirty,image)=>{if(!image.isEmpty()){lastFrame={png:image.toPNG(),size:image.getSize()};frameSequence++;}});
  win.webContents.setFrameRate(30);
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{providerCalls++;callback({cancel:true});});
  const output=await sharp({create:{width:512,height:512,channels:3,background:'#c0cfb7'}}).png().toBuffer();
  const createController=async()=>{
    const next=await DesktopController.create(runtime,()=>win,{deferStartup:true,projectRoot:base,showMessage:async()=>{throw Error('Unexpected native dialog in automatic-prompt smoke.');}});
    // A mock-only adapter lets the real model library perform its normal
    // readiness/default selection without storing a credential or endpoint.
    next.workspace.models.adapters.push({adapter_id:'smoke-understanding',version:1,title:'自动提示词测试模型',kind:'mock',installed:true,purposes:['understanding'],requires_credential:false,supports_probe:false,interleaving:['native','separated'],operations:['understand'],parameters:[]});
    next.executors.probe=async()=>{providerCalls++;throw Error('No model discovery in smoke.');};
    next.executors.execute=async(context,signal,progress)=>{
      assert.equal(context.model.kind,'mock','only explicit mock models can execute');
      const imageBlocks=context.job.chain_snapshot.blocks.filter(block=>block.type==='image');
      for(const image of imageBlocks)assert.ok((await context.readImage(image.asset_id)).length,'every admitted image is readable');
      if(context.model.purpose==='understanding'){
        inferences.push({job:structuredClone(context.job),images:imageBlocks.map(block=>block.asset_id)});
        if(failNextInference){failNextInference=false;throw Error('模拟推理失败，旧文字应保留');}
        if(holdNextInference){
          holdNextInference=false;
          await new Promise((resolve,reject)=>{
            const cancel=()=>{releaseInference=undefined;reject(Error('模拟推理已取消'));};
            releaseInference=()=>{signal.removeEventListener('abort',cancel);releaseInference=undefined;resolve();};
            if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
          });
        }
        return {images:[],text:`自动结果 ${inferences.length}：保持商品结构，居中偏左构图，暖色环境与柔和光线。`};
      }
      generations.push({job:structuredClone(context.job),images:imageBlocks.map(block=>block.asset_id)});
      await progress('模拟图像返回',80);
      return {images:[{bytes:output,format:'png',width:512,height:512}]};
    };
    return next;
  };
  controller=await createController();
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  const allowed=new Set(['state','recipe:save','project:save','module:infer','module:cancel-inference','job:start','module:copy','module:add','model:assign','recipe:select-model','reference:preview','reference:cancel-preview','module-settings:save']);
  ipcMain.handle('ediro:command',async(_event,command)=>{assert.ok(allowed.has(command.type),'unexpected UI command '+command.type);commands.push(command.type);return controller.execute(command);});
  const execute=async command=>{const response=await controller.execute(command);assert.equal(response.ok,true,response.error);return response;};
  const js=async code=>{
    const result=await win.webContents.executeJavaScript(`(()=>{try{return {ok:true,value:(${code})};}catch(error){return {ok:false,error:error.stack??String(error)};}})()`);
    if(!result.ok)throw Error(result.error);return result.value;
  };
  const until=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const click=async selector=>{
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Control unavailable: '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});el.click();})()`);await wait(35);
  };
  const setText=async(selector,value)=>{
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Text field unavailable');el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.blur();})()`);await wait(35);
  };
  const select=async(selector,value)=>{
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Select unavailable');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(35);
  };
  const clickLabel=async(label,scope)=>{
    await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Button unavailable: '+${JSON.stringify(label)});el.click();})()`);await wait(35);
  };
  const current=type=>controller.workspace.project.recipe.modules.find(module=>module.reference_type===type);
  const promptText=()=>current('prompt').user_instruction;
  const buttonText=()=>js(`document.querySelector('.generate-button span')?.textContent.trim()`);
  const waitButton=label=>until(async()=>(await buttonText())===`✦ ${label}`&&await js(`!document.querySelector('.generate-button').disabled`),label+' button ready');
  const jobsDone=()=>until(()=>Promise.resolve(controller.workspace.project.jobs.every(job=>['succeeded','failed','cancelled'].includes(job.status))),'image jobs complete');
  const load=async()=>{await win.loadFile(path.join(root,'dist','index.html'));await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'renderer loaded');};
  const clearError=async()=>{if(await js(`!!document.querySelector('button[aria-label="关闭错误提示"]')`))await click('button[aria-label="关闭错误提示"]');};
  const screenshot=async(width,height,focus='prompt')=>{
    win.setSize(width,height);await wait(120);
    await js(`(()=>{document.querySelector(${JSON.stringify('.module-card.type-'+focus)})?.scrollIntoView({block:'nearest',inline:'center',behavior:'instant'});})()`);
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before=frameSequence;win.webContents.startPainting();win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>before&&lastFrame?.png.length),'fresh screenshot');
    await wait(120);const settled=frameSequence;win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>settled&&lastFrame?.png.length),'settled screenshot');
    const layout=await js(`(()=>{
      const clipped=[];const card=document.querySelector('.module-card.type-prompt');const r=card.getBoundingClientRect();
      for(const el of card.querySelectorAll('.auto-prompt-controls button,.auto-prompt-controls select,textarea,.module-footer button')){
        const b=el.getBoundingClientRect();if(b.height<=0||b.width<=0||b.top<r.top-1||b.bottom>r.bottom+1||b.left<r.left-1||b.right>r.right+1)clipped.push(el.getAttribute('aria-label')||el.textContent.trim());
      }
      for(const card of document.querySelectorAll('.module-card.type-composition,.module-card.type-style')){const r=card.getBoundingClientRect();for(const el of card.querySelectorAll('.reference-mode button')){const b=el.getBoundingClientRect();if(b.height<=0||b.width<=0||b.top<r.top-1||b.bottom>r.bottom+1||b.left<r.left-1||b.right>r.right+1)clipped.push(el.textContent.trim());}}
      return {width:innerWidth,height:innerHeight,clipped,promptHeight:r.height,promptTextHeight:card.querySelector('textarea').getBoundingClientRect().height};
    })()`);
    assert.deepEqual(layout.clipped,[],'card controls must fit');assert.ok(layout.promptTextHeight>=28);assert.equal(win.isVisible(),false);
    const file=path.join(base,`automatic-${focus}-${width}x${height}.png`);await writeFile(file,lastFrame.png);captures.push({file,layout,pixels:lastFrame.size});
  };
  const screenshotPanel=async(width,height,panel)=>{
    win.setSize(width,height);await wait(120);
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const before=frameSequence;win.webContents.startPainting();win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>before&&lastFrame?.png.length),'fresh role screenshot');
    await wait(120);const settled=frameSequence;win.webContents.invalidate();
    await until(()=>Promise.resolve(frameSequence>settled&&lastFrame?.png.length),'settled role screenshot');
    const selector=panel==='editor'?'.module-editor select[aria-label="提示词角色"],.module-editor .editor-text textarea,.module-editor footer button,.module-editor .inference-actions button':'.global-settings select[aria-label="提示词默认角色"],.settings-page-navigation button,.settings-page-actions button';
    const layout=await js(`(()=>{const clipped=[];for(const el of document.querySelectorAll(${JSON.stringify(selector)})){const b=el.getBoundingClientRect();if(b.width<=0||b.height<=0||b.left<0||b.top<0||b.right>innerWidth+1||b.bottom>innerHeight+1)clipped.push(el.getAttribute('aria-label')||el.textContent.trim());}return {width:innerWidth,height:innerHeight,clipped};})()`);
    assert.deepEqual(layout.clipped,[],'role controls must fit viewport');assert.equal(win.isVisible(),false);
    const file=path.join(base,`prompt-role-${panel}-${width}x${height}.png`);await writeFile(file,lastFrame.png);captures.push({file,layout,pixels:lastFrame.size});
  };

  await phase('prepare-isolated-mock-model-and-images');
  const sourceModel=controller.workspace.models.snapshot().models.find(model=>model.model_config_id==='model_mock_native');
  await controller.workspace.models.saveModel({...sourceModel,model_config_id:'model_smoke_understanding',model:'smoke-understanding',title:'本地测试推理',adapter_id:'smoke-understanding',purpose:'understanding',capabilities:{...sourceModel.capabilities,operations:['understand']}});
  await controller.workspace.models.assign('understanding','model_smoke_understanding');
  for(const [type,color] of [['subject','#447359'],['composition','#8b6b54'],['style','#7c6a9c']]){
    const filename=path.join(base,`${type}.png`);await writeFile(filename,await sharp({create:{width:1200,height:800,channels:3,background:color}}).png().toBuffer());
    await execute({type:'assets:drop',paths:[filename],module_id:current(type).module_id});
  }
  await execute({type:'project:save'});
  const sourceIds=Object.fromEntries(['subject','composition','style'].map(type=>[type,current(type).asset_ids[0]]));
  await load();
  await phase('independent-reference-controls');
  const palette=await js(`[...document.querySelectorAll('.module-library button')].map(el=>el.textContent)`);
  for(const label of ['主体参考','构图参考','风格参考'])assert.ok(palette.some(text=>text.includes(label)),label+' is independently available');
  assert.equal(await js(`document.querySelectorAll('.reference-role').length`),0);
  assert.equal(await js(`document.querySelectorAll('.type-subject .reference-mode').length`),0);
  assert.equal(await js(`document.querySelectorAll('.reference-mode').length`),2);
  await click('.type-style .reference-mode button:nth-child(2)');
  await until(()=>Promise.resolve(current('style').reference_mode==='text_only'),'style text only saved');
  let state=await controller.view();
  assert.deepEqual(state.chain.blocks.filter(block=>block.type==='image').map(block=>block.asset_id),[sourceIds.subject,sourceIds.composition]);
  assert.equal(state.chain.blocks.some(block=>block.source_module_id===current('style').module_id&&block.type==='text'&&block.text_role==='instruction'),false);
  assert.deepEqual(current('style').asset_ids,[sourceIds.style],'text mode retains source image');
  await click('.type-prompt button[role="switch"]');
  await waitButton('生成提示词');
  await phase('stale-automatic-draft-rejected-before-execution');
  const beforeStale=inferences.length;
  const staleResponse=await controller.execute({type:'module:infer',request_id:'infer_stale_smoke',project_id:controller.workspace.project.project_id,module_id:current('prompt').module_id,model_config_id:'model_smoke_understanding',text:'已经过期的旧草稿',allow_text_only:false,automatic:true});
  assert.equal(staleResponse.ok,false);assert.match(staleResponse.error,/文字已变化/);assert.equal(inferences.length,beforeStale);assert.equal(promptText(),'');
  await screenshot(1775,1050);await screenshot(1120,800);await screenshot(1120,800,'composition');await screenshot(1120,800,'style');

  await phase('first-click-only-infers-and-writes-text');
  await click('.generate-button');
  await waitButton('生成图片');
  assert.equal(inferences.length,1);assert.equal(generations.length,0);assert.equal(controller.workspace.project.jobs.length,0);
  assert.deepEqual(inferences[0].images,[sourceIds.subject,sourceIds.composition,sourceIds.style]);
  assert.match(promptText(),/^自动结果 1/);assert.ok(current('prompt').auto_prompt_input_key);
  const baseline=current('prompt').auto_prompt_input_key;
  assert.equal(await js(`document.querySelector('.type-prompt textarea').value`),promptText());
  await select('select[aria-label="输出数量"]','2');await waitButton('生成图片');assert.equal(current('prompt').auto_prompt_input_key,baseline);
  await select('select[aria-label="输出数量"]','1');await waitButton('生成图片');assert.equal(inferences.length,1);

  await phase('manual-edit-and-repeat-generation-reuse');
  const edited=promptText()+' 用户手动补充：留出标题空间。';
  await setText('.type-prompt textarea',edited);await until(()=>Promise.resolve(promptText()===edited),'edited prompt saved');
  assert.equal((await controller.view()).auto_prompt.needs_inference,false);assert.equal(current('prompt').auto_prompt_input_key,baseline);
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===1),'second click starts generation');await jobsDone();
  assert.equal(inferences.length,1);assert.deepEqual(generations[0].images,[sourceIds.subject,sourceIds.composition]);
  assert.ok(generations[0].job.chain_snapshot.blocks.some(block=>block.type==='text'&&block.text===edited));
  await select('#generation-model','model_mock_separated');await waitButton('生成图片');
  assert.equal(current('prompt').auto_prompt_input_key,baseline);
  await select('#input-strategy','numbered_flat');await waitButton('生成图片');
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===2),'repeat generation');await jobsDone();assert.equal(inferences.length,1);
  assert.equal(generations[1].job.adapted_input.kind,'separated_inputs');assert.deepEqual(generations[1].job.adapted_input.image_asset_ids,[sourceIds.subject,sourceIds.composition]);
  await select('#generation-model','model_mock_native');await select('#input-strategy','auto');await waitButton('生成图片');

  await phase('upstream-change-failure-and-retry');
  await setText('.type-composition textarea','构图要求：主体稍向左。');await waitButton('更新提示词');
  failNextInference=true;await click('.generate-button');
  await until(()=>js(`document.querySelector('.error-banner')?.textContent.includes('模拟推理失败')`),'inference failure visible');
  await waitButton('更新提示词');assert.equal(promptText(),edited);assert.equal(current('prompt').auto_prompt_input_key,baseline);
  await clearError();await click('.generate-button');await waitButton('生成图片');assert.equal(inferences.length,3);assert.equal(generations.length,2);assert.match(promptText(),/^自动结果 3/);

  await phase('switch-reference-mode-requires-update');
  await click('.type-composition .reference-mode button:nth-child(2)');await waitButton('更新提示词');
  await click('.generate-button');await waitButton('生成图片');
  assert.equal(inferences.length,4);assert.deepEqual(inferences[3].images,[sourceIds.subject,sourceIds.composition,sourceIds.style]);
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===3),'both text references generation');await jobsDone();
  assert.deepEqual(generations[2].images,[sourceIds.subject]);

  await phase('cancel-and-disable-remain-recoverable');
  await setText('.type-style textarea','增加柔和侧光。');await waitButton('更新提示词');
  const beforeCancel=promptText();holdNextInference=true;await click('.generate-button');
  await until(()=>Promise.resolve(!!releaseInference),'pending inference');
  await until(()=>js(`document.querySelector('.generate-button')?.disabled&&!!document.querySelector('.auto-prompt-cancel')`),'inference busy UI');
  await click('.auto-prompt-cancel');await waitButton('更新提示词');
  await until(()=>Promise.resolve(!releaseInference),'cancel delivered to executor');assert.equal(promptText(),beforeCancel);
  holdNextInference=true;await click('.generate-button');await until(()=>Promise.resolve(!!releaseInference),'second pending inference');
  await click('.type-prompt button[role="switch"]');
  await until(()=>Promise.resolve(!current('prompt').auto_prompt&&!releaseInference),'toggle off cancels inference');
  await until(()=>js(`!document.querySelector('.generate-button').disabled`),'normal generation recovers');
  assert.equal(promptText(),beforeCancel);await click('.generate-button');await until(()=>Promise.resolve(generations.length===4),'ordinary generation with switch off');await jobsDone();
  await click('.type-prompt button[role="switch"]');await waitButton('更新提示词');await click('.generate-button');await waitButton('生成图片');

  await phase('project-reopen-reuses-persisted-output');
  await execute({type:'project:save'});state=await controller.view();const record=state.project_record_id,storedText=promptText(),storedKey=current('prompt').auto_prompt_input_key,priorInferences=inferences.length;
  assert.ok(record);await controller.shutdown();controller=await createController();await execute({type:'workspace:resume',id:record});await load();await waitButton('生成图片');
  assert.equal(promptText(),storedText);assert.equal(current('prompt').auto_prompt_input_key,storedKey);assert.equal(inferences.length,priorInferences);

  await phase('explicit-reinference-from-ready');
  const jobsBeforeReinfer=generations.length;
  await click('.type-prompt .auto-prompt-heading .text-button');await waitButton('生成图片');
  assert.equal(inferences.length,priorInferences+1);assert.equal(generations.length,jobsBeforeReinfer);
  const rerunText=promptText();assert.notEqual(rerunText,storedText);

  await phase('pending-edit-and-focused-title-preserve-new-result');
  const beforeQueued=promptText(),beforeQueuedInferences=inferences.length,beforeQueuedJobs=generations.length;
  holdNextInference=true;await click('.type-prompt .auto-prompt-heading .text-button');
  await until(()=>Promise.resolve(!!releaseInference),'pending inference for queued edit');
  const queuedComposition='推理等待期间改构图，保持主体偏右。';
  await setText('.type-composition textarea',queuedComposition);
  await js(`document.querySelector('.module-card.type-prompt .module-title').focus()`);
  releaseInference();
  await until(()=>Promise.resolve(inferences.length===beforeQueuedInferences+1&&promptText()!==beforeQueued&&current('composition').user_instruction===queuedComposition),'queued edit applies after automatic output');
  await waitButton('更新提示词');
  assert.equal(await js(`document.querySelector('.type-prompt textarea').value`),promptText(),'focused title must not block generated body update');
  assert.equal(generations.length,beforeQueuedJobs);
  const latestText=promptText();

  await phase('one-automatic-target-and-copy-off');
  await click('.type-prompt button[aria-label="复制提示词模块"]');
  await until(()=>Promise.resolve(controller.workspace.project.recipe.modules.filter(module=>module.reference_type==='prompt').length===2),'copy prompt');
  const prompts=controller.workspace.project.recipe.modules.filter(module=>module.reference_type==='prompt');
  assert.equal(prompts[1].auto_prompt,false);assert.equal(prompts[1].auto_prompt_input_key,undefined);assert.equal(prompts[1].user_instruction,latestText);
  await click(`[data-module-id="${prompts[1].module_id}"] button[role="switch"]`);
  await until(()=>Promise.resolve(controller.workspace.project.recipe.modules.find(module=>module.module_id===prompts[1].module_id).auto_prompt),'new automatic target');
  assert.equal(controller.workspace.project.recipe.modules.filter(module=>module.auto_prompt).length,1);
  assert.equal(controller.workspace.project.recipe.modules.find(module=>module.module_id===prompts[0].module_id).user_instruction,latestText);
  assert.equal((await controller.view()).auto_prompt.module_id,prompts[1].module_id);
  await phase('unknown-module-view-remains-editable');
  await execute({type:'project:save'});
  const unknownModule=current('style'),originalType=unknownModule.reference_type;
  try{
    unknownModule.reference_type='smoke_unknown';
    const unknownView=await controller.view();
    assert.equal(unknownView.project.project_id,controller.workspace.project.project_id);
    assert.match(unknownView.adaptation_error,/未安装/);assert.equal(unknownView.auto_prompt,undefined);
  }finally{unknownModule.reference_type=originalType;}
  assert.equal((await controller.view()).auto_prompt.module_id,prompts[1].module_id);
  await phase('prompt-role-editor-draft-and-cancel');
  const rolePromptId=current('prompt').module_id,roleCard=`[data-module-id="${rolePromptId}"]`;
  const roleSelect='.module-editor select[aria-label="提示词角色"]';
  const openRoleEditor=async()=>{await click(roleCard+' .expand-module');await until(()=>js(`!!document.querySelector(${JSON.stringify(roleSelect)})`),'prompt role editor');};
  const closeRoleEditor=()=>until(()=>js(`!document.querySelector('.module-editor')`),'role editor closed');
  const roleInstruction=()=>inferences.at(-1).job.chain_snapshot.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  assert.equal(current('prompt').prompt_role,'general');
  assert.equal(await js(`document.querySelectorAll('.module-card select[aria-label="提示词角色"]').length`),0,'role selector only appears in expanded editor');
  const beforeRoleEdit=promptText();await openRoleEditor();await select(roleSelect,'merchandiser');
  assert.equal(current('prompt').prompt_role,'general','unsaved role stays local');
  await screenshotPanel(1775,1050,'editor');await screenshotPanel(1120,800,'editor');
  await clickLabel('取消','.module-editor footer');await closeRoleEditor();
  assert.equal(current('prompt').prompt_role,'general');assert.equal(promptText(),beforeRoleEdit);

  await phase('manual-inference-uses-unsaved-role-and-clears-obsolete-suggestion');
  await openRoleEditor();await select(roleSelect,'merchandiser');
  const beforeManualRole=inferences.length;
  await click('.module-editor .inference-actions button');
  await until(()=>js(`!!document.querySelector('.module-editor .inference-result')`),'role optimization suggestion');
  assert.equal(inferences.length,beforeManualRole+1);assert.match(roleInstruction(),/commercial product stylist and set designer/);
  assert.equal(inferences.at(-1).job.recipe_snapshot.modules.find(module=>module.module_id===rolePromptId).prompt_role,'merchandiser');
  assert.equal(current('prompt').prompt_role,'general');assert.equal(promptText(),beforeRoleEdit);
  await select(roleSelect,'general');await until(()=>js(`!document.querySelector('.module-editor .inference-result')`),'role switch clears old suggestion');
  await select(roleSelect,'merchandiser');await click('.module-editor .inference-actions button');
  await until(()=>js(`!!document.querySelector('.module-editor .inference-result')`),'second role suggestion');
  await clickLabel('采用到编辑框','.module-editor .inference-adopt');
  assert.equal(current('prompt').prompt_role,'general','adoption does not persist editor draft');
  await clickLabel('保存并关闭','.module-editor footer');await closeRoleEditor();
  assert.equal(current('prompt').prompt_role,'merchandiser');assert.notEqual(promptText(),beforeRoleEdit);
  await openRoleEditor();assert.equal(await js(`document.querySelector(${JSON.stringify(roleSelect)}).value`),'merchandiser');await clickLabel('取消','.module-editor footer');await closeRoleEditor();

  await phase('automatic-role-and-manual-edit-reuse');
  await click(roleCard+' button[role="switch"]');await waitButton('更新提示词');
  const beforeAutomaticRole=inferences.length;await click('.generate-button');await waitButton('生成图片');
  assert.equal(inferences.length,beforeAutomaticRole+1);assert.match(roleInstruction(),/commercial product stylist and set designer/);
  const roleKey=current('prompt').auto_prompt_input_key;
  await setText(roleCard+' textarea',promptText()+' 保留用户手动调整。');await waitButton('生成图片');
  assert.equal(current('prompt').auto_prompt_input_key,roleKey);assert.equal((await controller.view()).auto_prompt.needs_inference,false);
  await openRoleEditor();await select(roleSelect,'general');await clickLabel('保存并关闭','.module-editor footer');await closeRoleEditor();await waitButton('更新提示词');
  await openRoleEditor();await select(roleSelect,'merchandiser');await clickLabel('保存并关闭','.module-editor footer');await closeRoleEditor();await waitButton('生成图片');
  assert.equal(inferences.length,beforeAutomaticRole+1,'changing role does not run inference automatically');
  const chainText=(await controller.view()).chain.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  assert.doesNotMatch(chainText,/commercial product stylist and set designer|Act as an image-generation prompt editor/,'role instructions do not enter generation');
  const idsBeforeRoleCopy=new Set(controller.workspace.project.recipe.modules.map(module=>module.module_id));
  await click(roleCard+' button[aria-label="复制提示词模块"]');
  await until(()=>Promise.resolve(controller.workspace.project.recipe.modules.some(module=>!idsBeforeRoleCopy.has(module.module_id))),'copy selected role');
  const roleCopy=controller.workspace.project.recipe.modules.find(module=>!idsBeforeRoleCopy.has(module.module_id));
  assert.equal(roleCopy.prompt_role,'merchandiser');assert.equal(roleCopy.auto_prompt,false);

  await phase('default-role-settings-and-restart');
  const existingRoles=controller.workspace.project.recipe.modules.filter(module=>module.reference_type==='prompt').map(module=>[module.module_id,module.prompt_role]);
  await click('.settings-button');await clickLabel('模块设置','.settings-page-navigation');
  await until(()=>js(`!!document.querySelector('select[aria-label="提示词默认角色"]')`),'role settings');
  await select('select[aria-label="提示词默认角色"]','merchandiser');
  await until(()=>Promise.resolve(controller.workspace.moduleSettings.prompt.role==='merchandiser'),'default role saved');
  await until(()=>js(`!document.querySelector('select[aria-label="提示词默认角色"]').disabled`),'default role controls ready');
  assert.equal(JSON.parse(await readFile(path.join(runtime,'module-settings.v1.json'),'utf8')).prompt.role,'merchandiser');
  assert.deepEqual(controller.workspace.project.recipe.modules.filter(module=>module.reference_type==='prompt').map(module=>[module.module_id,module.prompt_role]),existingRoles,'defaults preserve all existing roles');
  await screenshotPanel(1775,1050,'settings');await screenshotPanel(1120,800,'settings');
  await clickLabel('返回工作台','.settings-page-actions');await execute({type:'project:save'});
  const roleRecord=(await controller.view()).project_record_id;
  await controller.shutdown();controller=await createController();await execute({type:'workspace:resume',id:roleRecord});await load();
  assert.equal(controller.workspace.moduleSettings.prompt.role,'merchandiser');
  assert.deepEqual(controller.workspace.project.recipe.modules.filter(module=>module.reference_type==='prompt').map(module=>[module.module_id,module.prompt_role]),existingRoles,'project roles survive restart');
  const idsBeforeDefaultAdd=new Set(controller.workspace.project.recipe.modules.map(module=>module.module_id));
  await click('.chain-add');await until(()=>Promise.resolve(controller.workspace.project.recipe.modules.some(module=>!idsBeforeDefaultAdd.has(module.module_id))),'new prompt uses persisted role');
  assert.equal(controller.workspace.project.recipe.modules.find(module=>!idsBeforeDefaultAdd.has(module.module_id)).prompt_role,'merchandiser');
  assert.deepEqual(controller.workspace.project.recipe.modules.filter(module=>existingRoles.some(([id])=>id===module.module_id)).map(module=>[module.module_id,module.prompt_role]),existingRoles);
  assert.equal(providerCalls,0);assert.equal(win.isVisible(),false);
  await phase('complete');
  const report={passed:true,base,runtime,providerCalls,inferenceCalls:inferences.length,generationCalls:generations.length,commands,captures,
    checks:['independent-module-palette','no-reference-type-dropdown','subject-no-mode-switch','text-mode-keeps-source','generation-excludes-text-reference-images-and-core','stale-automatic-draft-rejected-before-execution','two-click-flow','one-global-inference-includes-all-reference-images','output-direct-writeback','manual-edit-does-not-invalidate','repeat-generation-reuses','generation-model-switch-does-not-invalidate','output-count-does-not-invalidate','native-and-numbered-generation-exclude-text-reference','upstream-change-invalidates','failed-inference-preserves-text-and-key','explicit-retry','reference-mode-change-invalidates','cancel-restores-controls','switch-off-cancels-and-allows-generation','project-reopen-retains-reusable-result','explicit-reinfer-from-ready','pending-upstream-edit-preserves-new-result','focused-title-does-not-block-generated-body','copy-disables-auto','single-automatic-target','unknown-module-view-remains-editable','controls-fit-two-viewports','prompt-role-editor-only','role-draft-cancel-preserves-project','manual-inference-uses-unsaved-role','role-switch-clears-obsolete-suggestion','role-adopt-and-save','automatic-inference-uses-saved-role','role-change-invalidates-automatic-result','manual-edit-preserves-role-result','role-instructions-excluded-from-generation','copy-preserves-role','default-role-disk-and-restart','default-role-preserves-existing-modules','new-prompt-uses-default-role','editor-and-settings-roles-fit-two-viewports','no-network']};
  const filename=path.join(base,'report.json');await writeFile(filename,JSON.stringify(report,null,2));
  await controller.shutdown();controller=undefined;win.destroy();console.log(JSON.stringify({...report,report:filename}));app.exit(0);
}).catch(async error=>{
  console.error(error);
  if(base){
    await writeFile(path.join(base,'failure.json'),JSON.stringify({stage:lastStage,error:error.stack??String(error),providerCalls,inferenceCalls:inferences.length,generationCalls:generations.length},null,2)).catch(()=>{});
    if(win&&!win.isDestroyed()){
      await writeFile(path.join(base,'failure.html'),await win.webContents.executeJavaScript('document.documentElement.outerHTML')).catch(()=>{});
      if(lastFrame)await writeFile(path.join(base,'failure.png'),lastFrame.png).catch(()=>{});
    }
    console.error('Failure stage: '+lastStage+'; artifacts: '+base);
  }
  if(controller)try{await controller.shutdown();}catch{}
  app.exit(1);
});
