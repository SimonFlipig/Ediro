// Real hidden Electron renderer + DesktopController. All inference and image
// execution is an explicit in-process fixture; external requests are forbidden.
// Run with Electron after npm run build. Never reads the user's runtime.
const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');
const {mkdir,mkdtemp,writeFile,appendFile,readFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let controller,win,base,lastFrame,frameSequence=0,lastStage='startup',providerCalls=0;
const captures=[],inferences=[],generations=[],commands=[],automaticCommands=[],typewriterChecks=[],actionChecks=[];
let failNextInference=false,holdNextInference=false,releaseInference,nextInferenceChunk;
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
        const number=inferences.length+1,chunk=nextInferenceChunk;nextInferenceChunk=undefined;
        const partial=chunk??`自动结果 ${number}：保持商品结构，`,text=chunk??partial+'居中偏左构图，暖色环境与柔和光线。';
        const fail=failNextInference,hold=holdNextInference;failNextInference=false;holdNextInference=false;
        inferences.push({job:structuredClone(context.job),images:imageBlocks.map(block=>block.asset_id),partial,text,emit:context.onTextDelta});
        if(chunk!==undefined)context.onTextDelta?.(chunk);
        else if(context.onTextDelta){
          context.onTextDelta(`自动结果 ${number}：`);await wait(70);
          context.onTextDelta('保持商品结构，');await wait(70);
        }
        if(hold){
          await new Promise((resolve,reject)=>{
            const cancel=()=>{releaseInference=undefined;reject(Error('模拟推理已取消'));};
            releaseInference=()=>{signal.removeEventListener('abort',cancel);releaseInference=undefined;resolve();};
            if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
          });
        }
        if(fail)throw Error('模拟推理失败，旧文字应保留');
        if(chunk===undefined)context.onTextDelta?.(text.slice(partial.length));
        return {images:[],text};
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
  ipcMain.handle('ediro:command',async(_event,command)=>{assert.ok(allowed.has(command.type),'unexpected UI command '+command.type);commands.push(command.type);if(command.type==='module:infer'&&command.automatic)automaticCommands.push(structuredClone(command));return controller.execute(command);});
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
  const promptSnapshot=()=>({text:promptText(),key:current('prompt').auto_prompt_input_key});
  const storedPrompt=async()=>{const module=(await controller.workspace.repository.load()).recipe.modules.find(module=>module.module_id===current('prompt').module_id);return {text:module.user_instruction,key:module.auto_prompt_input_key};};
  const previewText=()=>js(`document.querySelector('.type-prompt textarea').value`);
  const startPromptFrames=()=>js(`(()=>{window.smokePromptFrames=[];const sample=now=>{const field=document.querySelector('.type-prompt textarea');window.smokePromptFrames.push({time:now,text:field?.value??'',streaming:field?.dataset.streaming==='true',skip:!!document.querySelector('.auto-prompt-skip'),cancel:!!document.querySelector('.auto-prompt-cancel'),button:document.querySelector('.infer-button span')?.textContent.trim().replace(/^[✦\\s]+/,'')??'',disabled:document.querySelector('.infer-button')?.disabled??false});window.smokePromptFrameId=requestAnimationFrame(sample);};window.smokePromptFrameId=requestAnimationFrame(sample);})()`);
  const stopPromptFrames=()=>js(`(()=>{cancelAnimationFrame(window.smokePromptFrameId);return window.smokePromptFrames;})()`);
  const checkGrowingFrames=(frames,text,label)=>{
    const prefixes=frames.filter(frame=>frame.streaming&&frame.text.length>0&&frame.text.length<text.length&&text.startsWith(frame.text));
    const lengths=[...new Set(prefixes.map(frame=>frame.text.length))];
    typewriterChecks.push({label,partialFrameCount:prefixes.length,distinctLengths:lengths,firstFrameTime:prefixes[0]?.time,lastFrameTime:prefixes.at(-1)?.time,finalLength:text.length});
    assert.ok(lengths.length>=3,label+' must show multiple partial frames');
    assert.ok(lengths.every((length,index)=>index===0||length>lengths[index-1]),label+' must grow in order');
  };
  const checkPreview=async(before)=>{
    const partial=inferences.at(-1).partial;
    await until(async()=>await previewText()===partial,'incremental automatic prompt visible');
    assert.equal(await js(`document.querySelector('.type-prompt textarea').dataset.streaming`),'true');
    assert.equal(await js(`(()=>{const field=document.querySelector('.type-prompt textarea');return field.readOnly||field.disabled;})()`),true,'streaming prompt cannot be edited');
    assert.deepEqual(promptSnapshot(),before,'streaming leaves the live recipe unchanged');
    assert.deepEqual(await storedPrompt(),before,'streaming leaves the saved recipe unchanged');
    return partial;
  };
  const sendProgress=async(command,text,overrides={})=>{win.webContents.send('ediro:inference-progress',{request_id:command.request_id,project_id:command.project_id,module_id:command.module_id,text,...overrides});await wait(100);};
  const checkProgressSubscription=async()=>{
    await js(`(()=>{window.smokeProgressCount=0;for(let i=0;i<3;i++){const stop=window.ediro.onInferenceProgress(()=>window.smokeProgressCount++);stop();stop();}window.smokeStopProgress=window.ediro.onInferenceProgress(()=>window.smokeProgressCount++);})()`);
    await sendProgress({request_id:'infer_subscription_probe',project_id:'project_subscription_probe',module_id:'module_subscription_probe'},'订阅清理测试');
    assert.equal(await js('window.smokeProgressCount'),1,'only the active progress subscription receives an event');
    await js('window.smokeStopProgress()');
    await sendProgress({request_id:'infer_subscription_probe',project_id:'project_subscription_probe',module_id:'module_subscription_probe'},'退订后测试');
    assert.equal(await js('window.smokeProgressCount'),1,'removed progress subscriptions stay removed');
  };
  const buttonText=()=>js(`document.querySelector('.generate-button span')?.textContent.trim()`);
  const waitButton=label=>until(async()=>label==='生成提示词'||label==='更新提示词'
    ?await js(`document.querySelector('.generation-actions')?.classList.contains('is-split')&&document.querySelector('.infer-button small')?.textContent.trim()===${JSON.stringify(label)}&&!document.querySelector('.infer-button').disabled`)
    :(await buttonText())===`✦ ${label}`&&await js(`!document.querySelector('.generate-button').disabled&&!document.querySelector('.generation-actions')?.classList.contains('is-split')`),label+' button ready');
  const jobsDone=()=>until(()=>Promise.resolve(controller.workspace.project.jobs.every(job=>['succeeded','failed','cancelled'].includes(job.status))),'image jobs complete');
  const chainText=job=>job.chain_snapshot.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  const adaptedText=job=>job.adapted_input.kind==='native_blocks'
    ?job.adapted_input.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n'):job.adapted_input.prompt;
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
    const streaming=await js(`document.querySelector('.type-prompt textarea')?.dataset.streaming==='true'`);
    const file=path.join(base,`automatic-${focus}${streaming?'-streaming':''}-${width}x${height}.png`);await writeFile(file,lastFrame.png);captures.push({file,layout,pixels:lastFrame.size});
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
  const actionLayout=()=>js(`(()=>{const group=document.querySelector('.generation-actions'),infer=document.querySelector('.infer-button'),generate=document.querySelector('.generate-button'),bounds=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};return {split:group.classList.contains('is-split'),group:bounds(group),infer:bounds(infer),generate:bounds(generate),width:innerWidth,height:innerHeight,clipped:[infer,generate].filter(el=>{const b=el.getBoundingClientRect(),p=group.getBoundingClientRect();return b.width<=0||b.height<=0||b.left<p.left-1||b.right>p.right+1||b.top<0||b.bottom>innerHeight+1||el.scrollWidth>el.clientWidth+1;}).map(el=>el.className),transition:getComputedStyle(group).transitionDuration};})()`);
  const checkSplitLayout=async(width,height,label)=>{
    await screenshot(width,height);await wait(300);
    const layout=await actionLayout();assert.equal(layout.split,true);assert.deepEqual(layout.clipped,[],'split actions fit the current viewport');
    assert.ok(Math.abs(layout.generate.width/layout.infer.width-2)<.05,'generation receives two thirds of button space');
    assert.ok(layout.infer.right<layout.generate.left,'split actions remain side by side');
    actionChecks.push({label,...layout});
    const file=path.join(base,`automatic-actions-${label}-${width}x${height}.png`);await writeFile(file,lastFrame.png);captures.push({file,layout,pixels:lastFrame.size});
  };
  const setMotion=async value=>{
    if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value}]});
    assert.equal(await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`),value==='reduce');
  };
  const startActionFrames=()=>js(`(()=>{window.smokeActionFrames=[];const sample=now=>{const group=document.querySelector('.generation-actions'),infer=document.querySelector('.infer-button'),generate=document.querySelector('.generate-button');window.smokeActionFrames.push({time:now,split:group.classList.contains('is-split'),infer:infer.getBoundingClientRect().width,generate:generate.getBoundingClientRect().width});window.smokeActionFrameId=requestAnimationFrame(sample);};window.smokeActionFrameId=requestAnimationFrame(sample);})()`);
  const stopActionFrames=()=>js(`(()=>{cancelAnimationFrame(window.smokeActionFrameId);return window.smokeActionFrames;})()`);

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
  await phase('progress-subscription-cleanup');await checkProgressSubscription();
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
  const compositionExtra='构图额外说明：主体靠右，左侧留白。',styleExtra='风格额外说明：采用柔和侧光，不要植物。',subjectExtra='主体额外说明：保留商品把手。';
  await setText('.type-composition textarea',compositionExtra);await setText('.type-style textarea',styleExtra);await setText('.type-subject textarea',subjectExtra);
  await click('.type-prompt button[role="switch"]');
  await waitButton('生成提示词');
  await phase('stale-automatic-draft-rejected-before-execution');
  const beforeStale=inferences.length;
  const staleResponse=await controller.execute({type:'module:infer',request_id:'infer_stale_smoke',project_id:controller.workspace.project.project_id,module_id:current('prompt').module_id,model_config_id:'model_smoke_understanding',text:'已经过期的旧草稿',allow_text_only:false,automatic:true});
  assert.equal(staleResponse.ok,false);assert.match(staleResponse.error,/文字已变化/);assert.equal(inferences.length,beforeStale);assert.equal(promptText(),'');
  await screenshot(1775,1050);await screenshot(1120,800);await screenshot(1120,800,'composition');await screenshot(1120,800,'style');
  await phase('first-automatic-draft-can-generate-without-inference');
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===1),'first blank automatic draft directly generates');await jobsDone();
  assert.equal(inferences.length,0);assert.equal(promptText(),'');assert.equal(current('prompt').auto_prompt_input_key,undefined);
  assert.equal(chainText(generations[0].job).includes(compositionExtra),false,'image-and-text composition extra is inference input only');
  assert.equal(chainText(generations[0].job).includes(styleExtra),false,'text-only style extra is inference input only');
  assert.equal(chainText(generations[0].job).includes(subjectExtra),false,'subject extra is inference input only');
  for(const type of ['subject','composition'])assert.ok(generations[0].job.chain_snapshot.blocks.some(block=>block.source_module_id===current(type).module_id&&block.type==='text'&&block.text_role==='instruction'),'image reference core remains for '+type);
  const initialGenerationCalls=generations.length;

  await phase('first-click-only-infers-and-writes-text');
  const beforeFirst=promptSnapshot();holdNextInference=true;await click('.infer-button');
  await until(()=>Promise.resolve(!!releaseInference),'first streaming inference pending');
  const firstPartial=await checkPreview(beforeFirst),firstCommand=automaticCommands.at(-1);
  for(const overrides of [{request_id:'infer_obsolete_smoke'},{project_id:'project_unrelated_smoke'},{module_id:'module_unrelated_smoke'}]){
    await sendProgress(firstCommand,'不属于当前任务的文字',overrides);assert.equal(await previewText(),firstPartial,'mismatched progress must be ignored');
  }
  await screenshot(1120,800);releaseInference();
  await waitButton('生成图片');
  assert.equal(inferences.length,1);assert.equal(generations.length,initialGenerationCalls);assert.equal(controller.workspace.project.jobs.length,initialGenerationCalls);
  assert.deepEqual(inferences[0].images,[sourceIds.subject,sourceIds.composition,sourceIds.style]);
  assert.equal(chainText(inferences[0].job).includes(compositionExtra),true);assert.equal(chainText(inferences[0].job).includes(styleExtra),true);
  const firstConditions=JSON.parse(inferences[0].job.chain_snapshot.blocks[0].text);
  assert.equal(firstConditions.references.find(reference=>reference.use==='主体参考').requirements,subjectExtra,'subject extra reaches inference with its image');
  assert.match(promptText(),/^自动结果 1/);assert.ok(current('prompt').auto_prompt_input_key);
  const baseline=current('prompt').auto_prompt_input_key;
  await phase('module-reorder-keeps-current-prompt');
  const dragBefore=async(from,to)=>{
    await js(`(()=>{const source=document.querySelector('.type-'+${JSON.stringify(from)}+' .drag-handle'),target=document.querySelector('.module-card.type-'+${JSON.stringify(to)}),dataTransfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));})()`);
    await until(()=>Promise.resolve(controller.workspace.project.recipe.modules.findIndex(m=>m.reference_type===from)<controller.workspace.project.recipe.modules.findIndex(m=>m.reference_type===to)),'module reorder saved');
  };
  const beforeReorder=promptSnapshot(),beforeReorderCalls=inferences.length,beforeReorderStored=(await controller.workspace.repository.load()).recipe;
  await dragBefore('composition','subject');await waitButton('生成图片');
  assert.equal((await controller.view()).auto_prompt.needs_inference,false);
  assert.deepEqual(promptSnapshot(),beforeReorder);assert.equal(inferences.length,beforeReorderCalls);
  assert.deepEqual((await controller.workspace.repository.load()).recipe,beforeReorderStored,'reordering applies in memory without an automatic disk save');
  await execute({type:'project:save'});
  assert.equal((await controller.workspace.repository.load()).recipe.modules[0].reference_type,'composition');
  await dragBefore('subject','composition');await waitButton('生成图片');
  assert.equal((await controller.workspace.repository.load()).recipe.modules[0].reference_type,'composition','restoring the module order remains pending until the next checkpoint');
  assert.equal(await js(`document.querySelector('.type-prompt textarea').value`),promptText());
  assert.deepEqual(await storedPrompt(),promptSnapshot(),'completed text and input key are persisted together');
  assert.notEqual(await js(`document.querySelector('.type-prompt textarea').dataset.streaming`),'true');
  await select('select[aria-label="输出数量"]','2');await waitButton('生成图片');assert.equal(current('prompt').auto_prompt_input_key,baseline);
  await select('select[aria-label="输出数量"]','1');await waitButton('生成图片');assert.equal(inferences.length,1);

  await phase('manual-edit-and-repeat-generation-reuse');
  const edited=promptText()+' 用户手动修订：移除商品把手，留出标题空间。',beforeManualEditStored=await storedPrompt();
  await setText('.type-prompt textarea',edited);await until(()=>Promise.resolve(promptText()===edited),'edited prompt saved');
  assert.deepEqual(await storedPrompt(),beforeManualEditStored,'manual prompt editing applies in memory without an automatic disk save');
  assert.equal((await controller.view()).auto_prompt.needs_inference,false);assert.equal(current('prompt').auto_prompt_input_key,baseline);
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===initialGenerationCalls+1),'second click starts generation');await jobsDone();
  assert.equal(inferences.length,1);assert.deepEqual(generations.at(-1).images,[sourceIds.subject,sourceIds.composition]);
  assert.ok(generations.at(-1).job.chain_snapshot.blocks.some(block=>block.type==='text'&&block.text===edited));
  assert.ok(adaptedText(generations.at(-1).job).includes('移除商品把手'),'native input uses the reviewed final requirement');
  assert.ok(!adaptedText(generations.at(-1).job).includes(subjectExtra),'native input does not restore the superseded subject extra');
  assert.deepEqual(await storedPrompt(),promptSnapshot(),'generation checkpoint persists the reviewed manual edit');
  await select('#generation-model','model_mock_separated');await waitButton('生成图片');
  assert.equal(current('prompt').auto_prompt_input_key,baseline);
  await select('#input-strategy','numbered_flat');await waitButton('生成图片');
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===initialGenerationCalls+2),'repeat generation');await jobsDone();assert.equal(inferences.length,1);
  assert.equal(generations.at(-1).job.adapted_input.kind,'separated_inputs');assert.deepEqual(generations.at(-1).job.adapted_input.image_asset_ids,[sourceIds.subject,sourceIds.composition]);
  assert.ok(adaptedText(generations.at(-1).job).includes('移除商品把手'),'numbered input uses the reviewed final requirement');
  assert.ok(!adaptedText(generations.at(-1).job).includes(subjectExtra),'numbered input does not restore the superseded subject extra');
  await select('#generation-model','model_mock_native');await select('#input-strategy','auto');await waitButton('生成图片');

  await phase('upstream-change-failure-and-retry');
  await setText('.type-composition textarea','待更新的构图条件');await waitButton('更新提示词');
  await dragBefore('composition','subject');await waitButton('更新提示词');
  assert.equal((await controller.view()).auto_prompt.needs_inference,true);
  assert.equal(current('prompt').auto_prompt_input_key,baseline);assert.equal(inferences.length,beforeReorderCalls);
  await dragBefore('subject','composition');await waitButton('更新提示词');
  await setText('.type-composition textarea','构图要求：主体稍向左。');await waitButton('更新提示词');
  const beforeFailure=promptSnapshot();failNextInference=true;holdNextInference=true;await click('.infer-button');
  await until(()=>Promise.resolve(!!releaseInference),'failing streaming inference pending');await checkPreview(beforeFailure);releaseInference();
  assert.equal(chainText(inferences.at(-1).job).includes(beforeFailure.text),false,'automatic reinference excludes previous target text');
  await until(()=>js(`document.querySelector('.error-banner')?.textContent.includes('模拟推理失败')`),'inference failure visible');
  await waitButton('更新提示词');assert.equal(promptText(),edited);assert.equal(current('prompt').auto_prompt_input_key,baseline);
  assert.equal(await previewText(),edited);assert.deepEqual(await storedPrompt(),beforeFailure);
  assert.notEqual(await js(`document.querySelector('.type-prompt textarea').dataset.streaming`),'true');
  await clearError();await click('.infer-button');await waitButton('生成图片');assert.equal(inferences.length,3);assert.equal(generations.length,initialGenerationCalls+2);assert.match(promptText(),/^自动结果 3/);

  await phase('switch-reference-mode-suggests-update');
  await click('.type-composition .reference-mode button:nth-child(2)');await waitButton('更新提示词');
  await click('.infer-button');await waitButton('生成图片');
  assert.equal(inferences.length,4);assert.deepEqual(inferences[3].images,[sourceIds.subject,sourceIds.composition,sourceIds.style]);
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===initialGenerationCalls+3),'both text references generation');await jobsDone();
  assert.deepEqual(generations.at(-1).images,[sourceIds.subject]);

  await phase('cancel-and-disable-remain-recoverable');
  await setText('.type-style textarea','增加柔和侧光。');await waitButton('更新提示词');
  const beforeCancel=promptText(),beforeCancelSnapshot=promptSnapshot();holdNextInference=true;await click('.infer-button');
  await until(()=>Promise.resolve(!!releaseInference),'pending inference');
  await checkPreview(beforeCancelSnapshot);const cancelledCommand=automaticCommands.at(-1),cancelledEmit=inferences.at(-1).emit;
  await until(()=>js(`document.querySelector('.generate-button')?.disabled&&!!document.querySelector('.auto-prompt-cancel')`),'inference busy UI');
  await click('.auto-prompt-cancel');await waitButton('更新提示词');
  await until(()=>Promise.resolve(!releaseInference),'cancel delivered to executor');assert.equal(promptText(),beforeCancel);
  assert.equal(await previewText(),beforeCancel);assert.deepEqual(await storedPrompt(),beforeCancelSnapshot);
  cancelledEmit('取消后执行器仍返回的迟到文字');await sendProgress(cancelledCommand,'取消后迟到的 IPC 文字');assert.equal(await previewText(),beforeCancel);
  holdNextInference=true;await click('.infer-button');await until(()=>Promise.resolve(!!releaseInference),'second pending inference');
  const nextPartial=await checkPreview(beforeCancelSnapshot);
  cancelledEmit('上一请求迟到文字');await sendProgress(cancelledCommand,'上一请求迟到 IPC');assert.equal(await previewText(),nextPartial,'old request cannot overwrite the next preview');
  await click('.type-prompt button[role="switch"]');
  await until(()=>Promise.resolve(!current('prompt').auto_prompt&&!releaseInference),'toggle off cancels inference');
  await until(()=>js(`!document.querySelector('.generate-button').disabled`),'normal generation recovers');
  assert.equal(promptText(),beforeCancel);assert.equal(await previewText(),beforeCancel);assert.deepEqual(await storedPrompt(),beforeCancelSnapshot);
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===initialGenerationCalls+4),'ordinary generation with switch off');await jobsDone();
  for(const type of ['subject','composition','style'])assert.ok(adaptedText(generations.at(-1).job).includes(current(type).user_instruction),'switching automatic prompts off restores direct extra requirements for '+type);
  await click('.type-prompt button[role="switch"]');await waitButton('更新提示词');await click('.infer-button');await waitButton('生成图片');

  await phase('project-reopen-reuses-persisted-output');
  await execute({type:'project:save'});state=await controller.view();const record=state.project_record_id,storedText=promptText(),storedKey=current('prompt').auto_prompt_input_key,priorInferences=inferences.length;
  assert.ok(record);await controller.shutdown();controller=await createController();await execute({type:'workspace:resume',id:record});await load();await waitButton('生成图片');
  assert.equal(promptText(),storedText);assert.equal(current('prompt').auto_prompt_input_key,storedKey);assert.equal(inferences.length,priorInferences);

  await phase('explicit-reinference-from-ready');
  const jobsBeforeReinfer=generations.length;
  await click('.type-prompt .auto-prompt-heading .text-button');await waitButton('生成图片');
  assert.equal(inferences.length,priorInferences+1);assert.equal(generations.length,jobsBeforeReinfer);
  const rerunText=promptText();assert.notEqual(rerunText,storedText);

  await phase('changed-reference-offers-animated-choice-and-direct-generation');
  await setMotion('no-preference');await startActionFrames();await wait(60);
  await click('.type-composition .reference-mode button:nth-child(1)');await waitButton('更新提示词');await wait(350);
  const splitFrames=await stopActionFrames(),expandedWidth=splitFrames.at(-1).infer;
  const growingWidths=[...new Set(splitFrames.filter(frame=>frame.split&&frame.infer>1&&frame.infer<expandedWidth-1).map(frame=>Math.round(frame.infer*10)/10))];
  assert.ok(splitFrames.some(frame=>!frame.split),'animation starts from a single generation action');
  assert.ok(growingWidths.length>=3,'reference change expands the inference action over multiple frames');
  actionChecks.push({label:'normal-motion-split',intermediateWidths:growingWidths,frameCount:splitFrames.length});
  await checkSplitLayout(1775,1050,'wide');await checkSplitLayout(1120,800,'narrow');
  const changedReferenceFile=path.join(base,'composition-changed.png');
  await writeFile(changedReferenceFile,await sharp({create:{width:1200,height:800,channels:3,background:'#496b96'}}).png().toBuffer());
  const addedReference=await execute({type:'assets:drop',paths:[changedReferenceFile],module_id:current('composition').module_id});win.webContents.send('ediro:state',addedReference.state);
  await until(()=>js(`document.querySelectorAll('.type-composition .remove-reference').length===2`),'replacement reference available');
  await click('.type-composition .remove-reference');
  await until(()=>Promise.resolve(current('composition').asset_ids.length===1),'old composition reference removed');
  const changedReferenceId=current('composition').asset_ids[0],beforeDirect=promptSnapshot(),beforeDirectCalls=inferences.length,beforeDirectJobs=generations.length;
  assert.notEqual(changedReferenceId,sourceIds.composition);
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===beforeDirectJobs+1),'outdated prompt directly generates');await jobsDone();
  assert.equal(inferences.length,beforeDirectCalls,'direct generation never invokes inference');assert.deepEqual(promptSnapshot(),beforeDirect);
  assert.deepEqual(generations.at(-1).images,[sourceIds.subject,changedReferenceId]);
  assert.equal(chainText(generations.at(-1).job).includes(beforeDirect.text),true,'generation retains the reviewed prompt');
  assert.equal(chainText(generations.at(-1).job).includes(current('composition').user_instruction),false,'updated image-and-text composition extra stays out of generation until synthesized');
  assert.equal(chainText(generations.at(-1).job).includes(current('style').user_instruction),false,'text-only style extra stays out of generation');
  assert.equal((await controller.view()).auto_prompt.needs_inference,true,'direct generation preserves the optional update suggestion');

  await phase('missing-inference-model-still-allows-direct-generation');
  const understandingModels=controller.workspace.models.snapshot().models.filter(model=>model.purpose==='understanding'&&model.enabled);
  try{
    for(const entry of understandingModels)await controller.workspace.models.saveModel({...entry,enabled:false});
    win.webContents.send('ediro:state',await controller.view());
    await until(()=>js(`document.querySelector('.infer-button').disabled&&!document.querySelector('.generate-button').disabled`),'generation remains available without an inference model');
    const beforeMissingJobs=generations.length;await click('.generate-button');await until(()=>Promise.resolve(generations.length===beforeMissingJobs+1),'direct generation without inference model');await jobsDone();
    assert.equal(inferences.length,beforeDirectCalls);assert.deepEqual(promptSnapshot(),beforeDirect);
  }finally{
    for(const entry of understandingModels)await controller.workspace.models.saveModel(entry);
    win.webContents.send('ediro:state',await controller.view());
  }
  await waitButton('更新提示词');await click('.infer-button');await waitButton('生成图片');
  assert.equal(chainText(inferences.at(-1).job).includes(beforeDirect.text),false,'reinference after direct generation still excludes old target text');
  await until(()=>js(`(()=>{const button=document.querySelector('.infer-button');return button.disabled||button.tabIndex===-1||!!button.closest('[inert]');})()`),'collapsed inference action is not interactive');

  await phase('reduced-motion-choice-and-reversed-reference-routing');
  await setMotion('reduce');await startActionFrames();await wait(60);
  await click('.type-composition .reference-mode button:nth-child(2)');await click('.type-style .reference-mode button:nth-child(1)');await waitButton('更新提示词');await wait(120);
  const reducedFrames=await stopActionFrames(),reducedLayout=await actionLayout();
  assert.ok(reducedLayout.transition.split(',').every(duration=>parseFloat(duration)===0),'reduced motion disables the split transition');
  actionChecks.push({label:'reduced-motion-split',frames:reducedFrames,transition:reducedLayout.transition});
  await checkSplitLayout(1120,800,'reduced-motion');
  const beforeReversedJobs=generations.length,beforeReversedCalls=inferences.length;
  await click('.generate-button');await until(()=>Promise.resolve(generations.length===beforeReversedJobs+1),'reversed reference modes directly generate');await jobsDone();
  assert.equal(inferences.length,beforeReversedCalls);assert.deepEqual(generations.at(-1).images,[sourceIds.subject,sourceIds.style]);
  assert.equal(chainText(generations.at(-1).job).includes(current('composition').user_instruction),false,'text-only composition extra stays out of generation');
  assert.equal(chainText(generations.at(-1).job).includes(current('style').user_instruction),false,'image-and-text style extra stays out of generation until synthesized');
  await click('.infer-button');await waitButton('生成图片');await setMotion('no-preference');

  await phase('single-chunk-response-reveals-across-frames');
  const burstText='单块即时结果：'+'维持商品原有结构，采用居中偏左构图，搭配暖色环境、细腻材质与柔和侧光。'.repeat(90);
  const beforeBurstCalls=inferences.length;
  nextInferenceChunk=burstText;await startPromptFrames();await click('.type-prompt .auto-prompt-heading .text-button');await waitButton('生成图片');
  const burstFrames=await stopPromptFrames();checkGrowingFrames(burstFrames,burstText,'single-chunk-success');
  assert.equal(inferences.length,beforeBurstCalls+1,'revealing a single chunk does not repeat inference');
  assert.equal(await previewText(),burstText);assert.equal(promptText(),burstText);assert.deepEqual(await storedPrompt(),promptSnapshot());
  const tailFrames=burstFrames.filter(frame=>frame.skip);
  assert.ok(tailFrames.length>0,'completed request keeps a short visible tail');
  assert.ok(tailFrames.every(frame=>frame.button==='显示中'&&frame.disabled&&!frame.cancel),'saved tail clearly offers display completion instead of request cancellation');
  assert.ok(tailFrames.at(-1).time-tailFrames[0].time<1800,'saved tail drains within a short bounded interval');

  await phase('skip-saved-tail-without-new-request');
  const skipText='完整内容操作：'+'保持商品轮廓与品牌细节，逐步明确道具、材质、构图、色调以及灯光关系。'.repeat(90);
  const beforeSkipCalls=inferences.length,beforeSkipCancels=commands.filter(type=>type==='module:cancel-inference').length;
  nextInferenceChunk=skipText;await startPromptFrames();await click('.type-prompt .auto-prompt-heading .text-button');
  await until(()=>js(`!!document.querySelector('.auto-prompt-skip')`),'saved-tail show-complete control');
  assert.equal(promptText(),skipText,'successful result is already authoritative during display tail');
  const skipState=await js(`(()=>{const button=document.querySelector('.auto-prompt-skip');if(!button||button.disabled)throw Error('Show-complete control unavailable');const state={button:document.querySelector('.infer-button span').textContent.trim().replace(/^[✦\\s]+/,''),cancel:!!document.querySelector('.auto-prompt-cancel'),text:document.querySelector('.type-prompt textarea').value,label:button.textContent.trim()};button.click();return state;})()`);
  assert.equal(skipState.button,'显示中');assert.equal(skipState.cancel,false);assert.equal(skipState.label,'显示完整内容');
  assert.ok(skipState.text.length<skipText.length&&skipText.startsWith(skipState.text),'show-complete is exercised before the tail has finished');
  await waitButton('生成图片');await stopPromptFrames();
  assert.equal(await previewText(),skipText);assert.equal(await js(`document.querySelector('.type-prompt textarea').disabled`),false);
  assert.equal(inferences.length,beforeSkipCalls+1);assert.equal(commands.filter(type=>type==='module:cancel-inference').length,beforeSkipCancels);
  assert.deepEqual(await storedPrompt(),promptSnapshot());
  typewriterChecks.push({label:'skip-saved-tail',displayedLength:skipState.text.length,finalLength:skipText.length});

  await phase('cancel-active-reveal-never-revives-preview');
  const beforeRevealCancel=promptSnapshot(),cancelText='取消中的逐字预览：'+'这段临时内容只用于验证取消时清理计时器，不能覆盖旧正文或进入工程保存。'.repeat(90);
  nextInferenceChunk=cancelText;holdNextInference=true;await startPromptFrames();await click('.type-prompt .auto-prompt-heading .text-button');
  await until(()=>Promise.resolve(!!releaseInference),'single chunk held before completion');
  await until(()=>js(`(()=>{const target=${JSON.stringify(cancelText)},frames=window.smokePromptFrames.filter(frame=>frame.streaming&&frame.text.length>0&&frame.text.length<target.length&&target.startsWith(frame.text));return new Set(frames.map(frame=>frame.text.length)).size>=3&&document.querySelector('.type-prompt textarea').value.length<target.length;})()`),'active reveal has multiple partial frames');
  assert.deepEqual(promptSnapshot(),beforeRevealCancel);assert.deepEqual(await storedPrompt(),beforeRevealCancel);
  const activeRevealCommand=automaticCommands.at(-1),activeRevealEmit=inferences.at(-1).emit;
  await click('.auto-prompt-cancel');await waitButton('生成图片');await until(()=>Promise.resolve(!releaseInference),'active reveal cancellation reached executor');
  const cancelledAt=await js('performance.now()');
  activeRevealEmit('取消后的迟到片段');await sendProgress(activeRevealCommand,'取消后的迟到进度');await wait(1600);
  const cancelFrames=await stopPromptFrames();checkGrowingFrames(cancelFrames,cancelText,'cancel-during-reveal');
  const afterCancelFrames=cancelFrames.filter(frame=>frame.time>=cancelledAt);
  assert.ok(afterCancelFrames.length>=3);assert.ok(afterCancelFrames.every(frame=>frame.text===beforeRevealCancel.text&&!frame.streaming),'cancelled reveal timers never restore temporary text');
  assert.deepEqual(promptSnapshot(),beforeRevealCancel);assert.deepEqual(await storedPrompt(),beforeRevealCancel);

  await phase('paused-display-tail-does-not-block-recipe-save');
  const pausedText='后台显示队列测试：'+'成功结果已经保存，剩余逐字显示不能阻止用户继续编辑其他模块。'.repeat(90);
  const pausedComposition='逐字动画暂停期间保存的新构图要求：主体向右，左侧留白。';
  const beforePausedCalls=inferences.length,beforePausedCancels=commands.filter(type=>type==='module:cancel-inference').length;
  await js(`(()=>{const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,pending=new Map();let nextId=-1;window.requestAnimationFrame=callback=>{const id=nextId--;pending.set(id,callback);return id;};window.cancelAnimationFrame=id=>{if(!pending.delete(id))cancel.call(window,id);};window.smokeResumeFrames=()=>{window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;const callbacks=[...pending.values()];pending.clear();delete window.smokeResumeFrames;for(const callback of callbacks)request.call(window,callback);};})()`);
  try{
    nextInferenceChunk=pausedText;await click('.type-prompt .auto-prompt-heading .text-button');
    await until(()=>js(`!!document.querySelector('.auto-prompt-skip')`),'successful result awaits suspended display frames');
    assert.equal(promptText(),pausedText);assert.deepEqual(await storedPrompt(),promptSnapshot());
    assert.ok((await previewText()).length<pausedText.length,'display remains incomplete while frames are suspended');
    const beforePausedComposition=(await controller.workspace.repository.load()).recipe.modules.find(module=>module.module_id===current('composition').module_id).user_instruction;
    await setText('.type-composition textarea',pausedComposition);
    await until(()=>Promise.resolve(current('composition').user_instruction===pausedComposition),'recipe edit is accepted before display finishes');
    assert.equal((await controller.workspace.repository.load()).recipe.modules.find(module=>module.module_id===current('composition').module_id).user_instruction,beforePausedComposition,'background recipe editing stays in memory before a save checkpoint');
    await execute({type:'project:save'});
    assert.equal((await controller.workspace.repository.load()).recipe.modules.find(module=>module.module_id===current('composition').module_id).user_instruction,pausedComposition,'explicit save persists the recipe with animation still suspended');
    assert.equal(await js(`!!document.querySelector('.auto-prompt-skip')`),true,'saved display tail is still waiting during the independent recipe save');
    assert.ok((await previewText()).length<pausedText.length);assert.equal(promptText(),pausedText);assert.deepEqual(await storedPrompt(),promptSnapshot());
    await click('.auto-prompt-skip');await waitButton('更新提示词');assert.equal(await previewText(),pausedText);
    assert.equal(inferences.length,beforePausedCalls+1);assert.equal(commands.filter(type=>type==='module:cancel-inference').length,beforePausedCancels);
    typewriterChecks.push({label:'paused-tail-independent-recipe-save',framesSuspended:true,recipeSavedBeforeDisplayFinished:true,finalLength:pausedText.length});
  }finally{await js('window.smokeResumeFrames?.()');}

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

  await phase('project-switch-drops-late-stream');
  await execute({type:'project:save'});const switchRecord=(await controller.view()).project_record_id,beforeSwitch=promptSnapshot();
  holdNextInference=true;await click('.type-prompt .auto-prompt-heading .text-button');
  await until(()=>Promise.resolve(!!releaseInference),'stream before project switch');await checkPreview(beforeSwitch);
  const oldProjectCommand=automaticCommands.at(-1),oldProjectEmit=inferences.at(-1).emit;
  const created=await execute({type:'project:create',name:'流式隔离测试'});win.webContents.send('ediro:state',created.state);
  await until(()=>Promise.resolve(!releaseInference),'project switch cancels executor');
  await until(async()=>await previewText()==='','new project prompt is empty');
  oldProjectEmit('切工程后执行器迟到文字');await sendProgress(oldProjectCommand,'切工程后迟到的 IPC 文字');
  assert.equal(await previewText(),'');assert.equal(promptText(),'');assert.equal(current('prompt').auto_prompt_input_key,undefined);
  assert.notEqual(await js(`document.querySelector('.type-prompt textarea').dataset.streaming`),'true');
  const resumed=await execute({type:'workspace:resume',id:switchRecord});win.webContents.send('ediro:state',resumed.state);await waitButton('更新提示词');
  assert.deepEqual(promptSnapshot(),beforeSwitch);assert.deepEqual(await storedPrompt(),beforeSwitch);
  await sendProgress(oldProjectCommand,'回到原工程后仍应忽略的旧请求');assert.equal(await previewText(),beforeSwitch.text);
  await checkProgressSubscription();

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
  const roleInstruction=()=>{
    const job=inferences.at(-1).job,role=job.chain_snapshot.system_instruction;
    assert.equal(job.adapted_input.system_instruction,role);
    assert.ok(!chainText(job).includes(role),'Role instructions stay outside user content');
    const conditions=JSON.parse(job.chain_snapshot.blocks[0].text);
    assert.ok(!Array.isArray(conditions)&&Array.isArray(conditions.references),'prompt user content contains the simplified conditions object');
    return role;
  };
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
  const manualSystem=roleInstruction();
  assert.equal(JSON.parse(inferences.at(-1).job.chain_snapshot.blocks[0].text).draft,beforeRoleEdit,'manual inference includes current editor text');
  assert.equal(inferences.at(-1).emit,undefined,'manual optimization keeps its existing suggestion flow');
  assert.equal(inferences.at(-1).job.recipe_snapshot.modules.find(module=>module.module_id===rolePromptId).prompt_role,'merchandiser');
  assert.equal(current('prompt').prompt_role,'general');assert.equal(promptText(),beforeRoleEdit);
  await select(roleSelect,'general');await until(()=>js(`!document.querySelector('.module-editor .inference-result')`),'role switch clears old suggestion');
  await select(roleSelect,'merchandiser');await click('.module-editor .inference-actions button');
  await until(()=>js(`!!document.querySelector('.module-editor .inference-result')`),'second role suggestion');
  await clickLabel('采用到编辑框','.module-editor .inference-adopt');
  assert.equal(current('prompt').prompt_role,'general','adoption does not persist editor draft');
  await clickLabel('应用并关闭','.module-editor footer');await closeRoleEditor();
  assert.equal(current('prompt').prompt_role,'merchandiser');assert.notEqual(promptText(),beforeRoleEdit);
  await openRoleEditor();assert.equal(await js(`document.querySelector(${JSON.stringify(roleSelect)}).value`),'merchandiser');await clickLabel('取消','.module-editor footer');await closeRoleEditor();

  await phase('automatic-role-and-manual-edit-reuse');
  await click(roleCard+' button[role="switch"]');await waitButton('更新提示词');
  const beforeAutomaticRole=inferences.length;await click('.infer-button');await waitButton('生成图片');
  assert.equal(inferences.length,beforeAutomaticRole+1);assert.match(roleInstruction(),/commercial product stylist and set designer/);
  assert.equal(roleInstruction(),manualSystem,'automatic and manual inference share the same system rules');
  assert.equal(JSON.parse(inferences.at(-1).job.chain_snapshot.blocks[0].text).draft,undefined,'automatic inference excludes previous target text');
  const roleKey=current('prompt').auto_prompt_input_key;
  await setText(roleCard+' textarea',promptText()+' 保留用户手动调整。');await waitButton('生成图片');
  assert.equal(current('prompt').auto_prompt_input_key,roleKey);assert.equal((await controller.view()).auto_prompt.needs_inference,false);
  await openRoleEditor();await select(roleSelect,'general');await clickLabel('应用并关闭','.module-editor footer');await closeRoleEditor();await waitButton('更新提示词');
  await openRoleEditor();await select(roleSelect,'merchandiser');await clickLabel('应用并关闭','.module-editor footer');await closeRoleEditor();await waitButton('生成图片');
  assert.equal(inferences.length,beforeAutomaticRole+1,'changing role does not run inference automatically');
  const roleGenerationText=(await controller.view()).chain.blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  assert.doesNotMatch(roleGenerationText,/commercial product stylist and set designer|Act as an image-generation prompt editor/,'role instructions do not enter generation');
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
  const report={passed:true,base,runtime,providerCalls,inferenceCalls:inferences.length,generationCalls:generations.length,commands,captures,typewriterChecks,actionChecks,
    checks:['independent-module-palette','no-reference-type-dropdown','subject-no-mode-switch','text-mode-keeps-source','generation-excludes-text-reference-images-and-core','stale-automatic-draft-rejected-before-execution','two-click-flow','one-global-inference-includes-all-reference-images','output-direct-writeback','stream-preview-before-completion','stream-preview-is-readonly','stream-preview-does-not-change-live-or-saved-recipe','stream-success-persists-text-and-key-together','stream-failure-restores-text-and-key','stream-cancel-restores-text-and-key','mismatched-request-project-module-progress-ignored','late-progress-after-cancel-ignored','old-stream-does-not-overwrite-new-request','project-switch-cancels-and-drops-late-stream','progress-subscriptions-clean-up-repeatedly','manual-edit-does-not-invalidate','repeat-generation-reuses','generation-model-switch-does-not-invalidate','output-count-does-not-invalidate','native-and-numbered-generation-exclude-text-reference','upstream-change-invalidates','failed-inference-preserves-text-and-key','explicit-retry','reference-mode-change-invalidates','cancel-restores-controls','switch-off-cancels-and-allows-generation','project-reopen-retains-reusable-result','explicit-reinfer-from-ready','pending-upstream-edit-preserves-new-result','focused-title-does-not-block-generated-body','copy-disables-auto','single-automatic-target','unknown-module-view-remains-editable','controls-fit-two-viewports','prompt-role-editor-only','role-draft-cancel-preserves-project','manual-inference-uses-unsaved-role','manual-inference-retains-suggestion-flow','role-switch-clears-obsolete-suggestion','role-adopt-and-save','automatic-inference-uses-saved-role','role-change-invalidates-automatic-result','manual-edit-preserves-role-result','role-instructions-excluded-from-generation','copy-preserves-role','default-role-disk-and-restart','default-role-preserves-existing-modules','new-prompt-uses-default-role','editor-and-settings-roles-fit-two-viewports','no-network']};
  report.checks.push('single-chunk-response-reveals-across-frames','successful-response-keeps-bounded-display-tail','saved-tail-shows-complete-instead-of-cancel','show-complete-does-not-repeat-or-cancel-request','cancelled-reveal-timer-never-revives-preview','suspended-display-frames-do-not-block-recipe-save');
  report.checks.push('first-empty-automatic-draft-can-generate','automatic-reinference-excludes-old-target-text','composition-and-style-extra-reach-inference-in-both-reference-modes','text-only-composition-and-style-extra-excluded-from-generation','image-and-text-composition-and-style-extra-excluded-from-generation','subject-extra-reaches-inference-only','image-reference-cores-remain','reviewed-final-text-replaces-subject-extra-in-native-and-numbered-inputs','switching-off-restores-direct-extra-requirements','upstream-change-suggests-without-blocking','changed-reference-and-reviewed-prompt-generate-together','missing-inference-model-does-not-block-generation','split-actions-expand-over-multiple-frames','split-actions-use-one-to-two-widths-in-two-viewports','collapsed-inference-action-is-not-interactive','reduced-motion-disables-split-transition');
  const filename=path.join(base,'report.json');await writeFile(filename,JSON.stringify(report,null,2));
  await controller.shutdown();controller=undefined;win.destroy();console.log(JSON.stringify({...report,report:filename}));app.exit(0);
}).catch(async error=>{
  console.error(error);
  if(base){
    await writeFile(path.join(base,'failure.json'),JSON.stringify({stage:lastStage,error:error.stack??String(error),providerCalls,inferenceCalls:inferences.length,generationCalls:generations.length,typewriterChecks,actionChecks},null,2)).catch(()=>{});
    if(win&&!win.isDestroyed()){
      await writeFile(path.join(base,'failure.html'),await win.webContents.executeJavaScript('document.documentElement.outerHTML')).catch(()=>{});
      if(lastFrame)await writeFile(path.join(base,'failure.png'),lastFrame.png).catch(()=>{});
    }
    console.error('Failure stage: '+lastStage+'; artifacts: '+base);
  }
  if(controller)try{await controller.shutdown();}catch{}
  app.exit(1);
});
