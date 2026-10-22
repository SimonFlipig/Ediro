// Real renderer + DesktopController, with controllable local generation only.
// Run after npm run build. The window stays hidden and all network is forbidden.
const {app,BrowserWindow,ipcMain,protocol,net,dialog}=require('electron');
const {mkdtemp,mkdir,writeFile,readFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const sharp=require('sharp');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let base,controller,win,frame,paintSequence=0,stage='startup',providerCalls=0;
globalThis.fetch=async()=>{providerCalls++;throw Error('Network is forbidden in generation-feedback smoke');};
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});
  base=await mkdtemp(path.join(root,'.local','generation-feedback-ui-'));
  app.setPath('userData',path.join(base,'electron'));
  const runtime=path.join(base,'runtime');
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {registerWindowChrome}=await import('../dist-host/desktop/window-chrome.js');
  win=new BrowserWindow({width:1775,height:1050,show:false,backgroundColor:'#f6f5f1',
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,offscreen:true}});
  win.setMenuBarVisibility(false);registerWindowChrome(ipcMain,()=>win);
  win.webContents.on('paint',(_event,_dirty,image)=>{if(!image.isEmpty()){frame=image.toPNG();paintSequence++;}});
  win.webContents.setFrameRate(30);
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,callback)=>{providerCalls++;callback({cancel:true});});
  const controls=new Map(),executions=[],commands=[],responses=[],confirmations=[];
  let exportTarget;
  dialog.showSaveDialog=async(_window,options)=>{
    assert.equal(options.title,'导出图片');assert.ok(exportTarget,'Only the explicit export check may open a save dialog');
    const filePath=exportTarget;exportTarget=undefined;return {canceled:false,filePath};
  };
  const createController=async()=>{
    const next=await DesktopController.create(runtime,()=>win,{deferStartup:true,projectRoot:base,showMessage:async options=>{
      assert.equal(options.message,'从结果列表移除此版本？','Only result removal may ask for confirmation in this fixture');
      assert.ok(confirmations.length,'Unexpected removal confirmation');return {response:confirmations.shift(),checkboxChecked:false};
    }});
    const executeModel=next.executors.execute.bind(next.executors);
    next.executors.execute=async(context,signal,progress)=>{
      assert.equal(context.model.kind,'mock');executions.push(context.job.task_id);
      await progress('等待受控模拟结果',45);
      await new Promise((resolve,reject)=>{
        const abort=()=>{controls.delete(context.job.task_id);reject(Error('任务已取消。'));};
        signal.addEventListener('abort',abort,{once:true});
        controls.set(context.job.task_id,{
          succeed:()=>{signal.removeEventListener('abort',abort);controls.delete(context.job.task_id);resolve();},
          fail:()=>{signal.removeEventListener('abort',abort);controls.delete(context.job.task_id);reject(Error('受控模拟生成失败'));},
        });
        if(signal.aborted)abort();
      });
      return executeModel(context,signal,progress);
    };
    next.executors.probe=async()=>{throw Error('Unexpected provider probe');};
    return next;
  };
  controller=await createController();
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  const allowed=new Set(['state','recipe:save','reference:preview','reference:cancel-preview','project:save','job:start','job:cancel','job:restore-recipe','result:restore','job:hide-result','result:trash','asset:export']);
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  ipcMain.handle('ediro:command',async(_event,command)=>{
    commands.push(structuredClone(command));assert.ok(allowed.has(command.type),'Unexpected renderer command '+command.type);
    const response=await controller.execute(command);responses.push({type:command.type,ok:response.ok,cancelled:response.cancelled,error:response.error});return response;
  });
  const execute=async command=>{const response=await controller.execute(command);assert.ok(response.ok,response.error);return response;};
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async(check,label)=>{for(let i=0;i<250;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const visible=selector=>js(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const click=async selector=>js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Unavailable control '+${JSON.stringify(selector)});el.click();})()`);
  const clickText=async(scope,label)=>js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(el=>el.textContent.trim()===${JSON.stringify(label)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Unavailable button '+${JSON.stringify(label)});el.click();})()`);
  const taskTile=id=>`.result-task-thumb[data-task-id="${id}"]`;
  const stateJob=id=>controller.workspace.project.jobs.find(job=>job.task_id===id);
  const jobCount=()=>controller.workspace.project.jobs.length;
  const setPrompt=async text=>{
    await js(`(()=>{const el=document.querySelector('.module-card.type-prompt textarea');el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));el.blur();})()`);
    await until(()=>Promise.resolve(controller.workspace.project.recipe.modules.find(m=>m.reference_type==='prompt').user_instruction===text),'prompt saved');
  };
  const startJob=async()=>{
    const before=jobCount();await click('.generate-button');
    await until(()=>Promise.resolve(jobCount()===before+1),'job enqueued');
    const job=controller.workspace.project.jobs.at(-1);await until(()=>visible(taskTile(job.task_id)),'task thumbnail');return job;
  };
  // Ignore short hover/selection CSSTransitions; only the continuous waiting
  // CSSAnimations must stop when a task settles or reduced motion is enabled.
  const activeAnimations=selector=>js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return el?[...el.getAnimations({subtree:true})].filter(a=>a instanceof CSSAnimation&&a.playState==='running'&&a.effect.getTiming().iterations===Infinity).map(a=>({time:Number(a.currentTime),name:a.animationName})):[];})()`);
  const screenshots=[];
  const screenshot=async name=>{const before=paintSequence;win.webContents.startPainting();win.webContents.invalidate();await until(()=>Promise.resolve(paintSequence>before&&frame),'fresh frame');await wait(150);const file=path.join(base,name+'.png');await writeFile(file,frame);screenshots.push(file);};
  const waitStatus=async(id,status)=>{await until(()=>Promise.resolve(stateJob(id)?.status===status),status+' job');await until(()=>js(`document.querySelector(${JSON.stringify(taskTile(id))})?.dataset.status===${JSON.stringify(status)}`),status+' thumbnail');};

  stage='prepare-fixture';
  const fixture=path.join(base,'当前任务参考图.jpg');
  await writeFile(fixture,await sharp(Buffer.from('<svg width="900" height="600"><rect width="900" height="600" fill="#efe9d7"/><rect x="60" y="100" width="280" height="430" fill="#47674c"/><circle cx="670" cy="200" r="110" fill="#b46d49"/><path d="M0 540H900" stroke="#9d987f" stroke-width="50"/></svg>')).jpeg().toBuffer());
  const subject=controller.workspace.project.recipe.modules.find(m=>m.reference_type==='subject').module_id;
  await execute({type:'assets:drop',paths:[fixture],module_id:subject});
  const recipe=structuredClone(controller.workspace.project.recipe);
  const prompt=recipe.modules.find(m=>m.reference_type==='prompt');prompt.user_instruction='任务一：保留商品，米色背景';prompt.auto_prompt=false;
  for(const module of recipe.modules)if(module.reference_type==='composition'||module.reference_type==='style')module.asset_ids=[];
  await execute({type:'recipe:save',recipe});assert.equal(controller.workspace.models.resolve(recipe.model_config_id).kind,'mock');
  await win.loadFile(path.join(root,'dist','index.html'));
  await until(()=>js(`document.querySelector('.generate-button')?.disabled===false`),'renderer ready');

  stage='running-feedback-and-frozen-snapshot';
  const first=await startJob();await until(()=>Promise.resolve(controls.has(first.task_id)),'first generation running');
  await until(()=>js(`document.querySelector('.generate-button')?.getAttribute('aria-busy')==='true'`),'busy button');
  assert.equal(await js(`document.querySelectorAll(${JSON.stringify(taskTile(first.task_id)+' .generation-mosaic-cell')}).length`),36);
  assert.equal(await js(`document.querySelector('.generate-button').disabled`),false,'busy state retains explicit enqueue capability');
  const frozen=structuredClone(first.recipe_snapshot),frozenChain=structuredClone(first.chain_snapshot);
  const beforeAnimations=await activeAnimations(taskTile(first.task_id));assert.equal(beforeAnimations.filter(a=>a.name==='generation-tile-pulse').length,36,'all 36 mosaic cells have continuous waiting animation');
  assert.ok((await activeAnimations('.generate-button')).some(a=>a.name==='generation-spin'),'generate button spinner continuously animates');
  await wait(220);
  const afterAnimations=await activeAnimations(taskTile(first.task_id));assert.ok(afterAnimations.some((a,index)=>a.time>beforeAnimations[index]?.time),'mosaic animation advances while request waits');
  await setPrompt('当前编辑：新提示词不能改掉任务一');
  assert.deepEqual(first.recipe_snapshot,frozen);assert.deepEqual(first.chain_snapshot,frozenChain);

  stage='failed-task-survives-dismiss-and-restores-without-generation';
  controls.get(first.task_id).fail();await waitStatus(first.task_id,'failed');
  await until(()=>visible('.app-dialog'),'failure dialog');await clickText('.app-dialog','知道了');await until(async()=>!await visible('.app-dialog'),'failure dismissed');
  assert.equal((await activeAnimations(taskTile(first.task_id))).length,0,'failed thumbnail no longer animates');
  const callsBeforeRestore=executions.length,countBeforeRestore=jobCount();
  await click(taskTile(first.task_id));
  await until(()=>js(`document.querySelector(${JSON.stringify(taskTile(first.task_id))})?.classList.contains('selected')`),'failed task selected');
  assert.equal(controller.workspace.project.recipe.modules.find(m=>m.reference_type==='prompt').user_instruction,prompt.user_instruction);
  assert.deepEqual(controller.workspace.project.recipe.core_parameters,frozen.core_parameters);
  assert.deepEqual(stateJob(first.task_id).recipe_snapshot,frozen);
  assert.equal(executions.length,callsBeforeRestore);assert.equal(jobCount(),countBeforeRestore,'restore is not retry');
  assert.equal(commands.filter(command=>command.type==='job:restore-recipe'&&command.task_id===first.task_id).length,1);
  assert.equal(await visible('.mask-editor'),false,'task selection never opens local edit');

  stage='multiple-tasks-success-replaces-placeholder-cancel-persists';
  await setPrompt('任务二：成功后替换占位');const second=await startJob();await until(()=>Promise.resolve(controls.has(second.task_id)),'second running');
  await setPrompt('任务三：取消后也可以恢复');const third=await startJob();
  await waitStatus(third.task_id,'queued');
  assert.equal(await js(`document.querySelectorAll('.result-task-thumb').length`),3);
  const order=await js(`Array.from(document.querySelectorAll('.result-task-thumb')).map(el=>el.dataset.taskId)`);
  assert.deepEqual(order,[first.task_id,second.task_id,third.task_id]);
  await execute({type:'job:cancel',task_id:third.task_id});await controller.refreshState();await waitStatus(third.task_id,'cancelled');
  controls.get(second.task_id).succeed();
  await until(()=>Promise.resolve(stateJob(second.task_id).status==='succeeded'),'second succeeded');
  const resultId=stateJob(second.task_id).output_asset_ids[0];
  await until(()=>visible(`.result-thumb[data-asset-id="${resultId}"]`),'success result thumbnail');
  assert.equal(await visible(taskTile(second.task_id)),false,'completed task placeholder replaced');
  assert.equal(await visible(taskTile(first.task_id)),true);assert.equal(await visible(taskTile(third.task_id)),true);
  await until(()=>js(`document.querySelector('.generate-button')?.getAttribute('aria-busy')!=='true'`),'button returns to idle');
  assert.equal((await activeAnimations('.generate-button')).length,0);
  const countAfterSuccess=executions.length;
  await click(taskTile(third.task_id));
  await until(()=>Promise.resolve(controller.workspace.project.recipe.modules.find(m=>m.reference_type==='prompt').user_instruction==='任务三：取消后也可以恢复'),'cancelled task restores');
  assert.equal(executions.length,countAfterSuccess);

  stage='reopen-retains-failed-and-cancelled-entries';
  await execute({type:'project:save'});
  const projectId=controller.workspace.project.project_id,filename=controller.workspace.repository.filename;
  assert.ok(filename?.endsWith('.ediro'),'fixture persisted as a real document');
  await controller.shutdown();controller=await createController();
  await controller.openProjectFile(filename);await win.loadFile(path.join(root,'dist','index.html'));
  await until(()=>visible(taskTile(first.task_id)),'failed task after reopen');
  assert.equal(controller.workspace.project.project_id,projectId);assert.equal(await visible(taskTile(third.task_id)),true);assert.equal(await visible(`.result-thumb[data-asset-id="${resultId}"]`),true);
  await setPrompt('重开后随便编辑，不改变历史');
  const countBeforeReopenedRestore=executions.length;await click(taskTile(first.task_id));
  await until(()=>Promise.resolve(controller.workspace.project.recipe.modules.find(m=>m.reference_type==='prompt').user_instruction===prompt.user_instruction),'reopened failed task restores');
  assert.equal(executions.length,countBeforeReopenedRestore);

  stage='layouts-and-reduced-motion';
  await setPrompt('任务四：观察等待动画');const fourth=await startJob();await until(()=>Promise.resolve(controls.has(fourth.task_id)),'fourth running');
  for(const [width,height] of [[1775,1050],[1120,800]]){
    win.setSize(width,height);await wait(150);await click(taskTile(fourth.task_id));
    await until(()=>js(`document.querySelector(${JSON.stringify(taskTile(fourth.task_id))})?.classList.contains('selected')`),'running task selected');
    assert.equal(await visible('.preview-remove'),false,'running task cannot be removed');
    assert.equal(await visible('.preview-export'),false,'running task has no image to export');
    const layout=await js(`(()=>{const selectors=['.generate-button',${JSON.stringify(taskTile(fourth.task_id))},'.result-strip'];return selectors.map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();return {selector,width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,viewport:[innerWidth,innerHeight]};});})()`);
    assert.ok(layout.every(r=>r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=r.viewport[0]+1&&r.bottom<=r.viewport[1]+1),'feedback controls remain visible at '+width);
    await screenshot(`waiting-${width}x${height}`);
  }
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await until(()=>js(`matchMedia('(prefers-reduced-motion: reduce)').matches`),'reduced-motion active');
  await wait(100);
  assert.equal((await activeAnimations(taskTile(fourth.task_id))).length,0,'reduced motion stops task mosaic animation');
  assert.equal((await activeAnimations('.generate-button')).length,0,'reduced motion stops button animation');
  assert.equal(await js(`document.querySelectorAll(${JSON.stringify(taskTile(fourth.task_id)+' .generation-mosaic-cell')}).length`),36);
  assert.equal(await js(`document.querySelector('.generate-button').getAttribute('aria-busy')`),'true','reduced-motion keeps accessible busy status');
  await screenshot('waiting-reduced-motion');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});win.webContents.debugger.detach();
  await execute({type:'job:cancel',task_id:fourth.task_id});await controller.refreshState();await waitStatus(fourth.task_id,'cancelled');

  stage='floating-result-actions-layout';
  const resultTile=`.result-thumb[data-asset-id="${resultId}"]`;
  await click(resultTile);await until(()=>js(`document.querySelector(${JSON.stringify(resultTile)})?.classList.contains('selected')`),'result selected for floating actions');
  const actionBounds=()=>js(`(()=>{const rect=selector=>{const el=document.querySelector(selector);if(!el)throw Error('Missing '+selector);const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};return {stage:rect('.canvas-stage'),image:rect('.main-image'),actions:rect('.preview-actions'),remove:rect('.preview-remove'),export:rect('.preview-export')};})()`);
  const assertActionsInside=layout=>{
    for(const key of ['remove','export']){const r=layout[key];assert.ok(r.width>=28&&r.height>=28,'action remains a usable fixed size');assert.ok(r.left>=layout.stage.left&&r.right<=layout.stage.right&&r.top>=layout.stage.top&&r.bottom<=layout.stage.bottom,'floating action stays inside the preview');}
  };
  for(const [width,height] of [[1775,1050],[1120,800]]){
    win.setSize(width,height);await clickText('.canvas-actions','适应');await wait(180);
    const fitted=await actionBounds();assertActionsInside(fitted);
    assert.ok(Math.abs(fitted.actions.right-fitted.image.right)<=10,'actions align with the image right edge at '+width);
    assert.ok(fitted.actions.bottom<=fitted.image.top+20,'actions sit at the image upper edge at '+width);
    await js(`document.querySelector('.preview-remove').focus()`);
    assert.equal(await js(`document.activeElement===document.querySelector('.preview-remove')`),true,'remove action is keyboard focusable');
    assert.equal(await js(`!!document.querySelector('.preview-remove').getAttribute('aria-label')&&!!document.querySelector('.preview-export').getAttribute('aria-label')`),true);
    await screenshot(`preview-actions-${width}x${height}`);
    await click('[aria-label="放大"]');await click('[aria-label="放大"]');await wait(100);
    const zoomed=await actionBounds();assertActionsInside(zoomed);
    assert.ok(Math.abs(zoomed.remove.width-fitted.remove.width)<1,'zoom does not enlarge the buttons');
    assert.ok(Math.abs(zoomed.actions.right-fitted.actions.right)>3,'actions track the zoomed image edge');
    const start={x:Math.round((zoomed.stage.left+zoomed.stage.right)/2),y:Math.round((zoomed.stage.top+zoomed.stage.bottom)/2)};
    await js(`(()=>{window.__smokePointerEvents=[];if(!window.__smokePointerListener){window.__smokePointerListener=event=>window.__smokePointerEvents.push({type:event.type,buttons:event.buttons,button:event.button,x:event.clientX,y:event.clientY,target:event.target.className,trusted:event.isTrusted});for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'])document.addEventListener(type,window.__smokePointerListener,true);}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...start});await wait(40);
    win.webContents.sendInputEvent({type:'mouseDown',...start,button:'left',clickCount:1,modifiers:['leftbuttondown']});await wait(40);
    // Electron does not infer a held button from mouseMove.button. Preserve the
    // actual DOM buttons bitfield explicitly, as a native drag would do.
    win.webContents.sendInputEvent({type:'mouseMove',x:start.x+60,y:start.y+20,button:'left',modifiers:['leftbuttondown']});await wait(40);
    win.webContents.sendInputEvent({type:'mouseMove',x:start.x+120,y:start.y+45,button:'left',modifiers:['leftbuttondown']});await wait(60);
    win.webContents.sendInputEvent({type:'mouseUp',x:start.x+120,y:start.y+45,button:'left',clickCount:1});
    await wait(100);const panned=await actionBounds();assertActionsInside(panned);
    const pointerEvents=await js('window.__smokePointerEvents');
    await writeFile(path.join(base,`preview-pointer-input-${width}x${height}.json`),JSON.stringify({start,zoomed,panned,pointerEvents},null,2));
    assert.ok(pointerEvents.some(event=>event.type==='pointerdown'&&event.trusted&&event.target==='main-image'&&event.buttons===1),'native drag starts on the image with the left button held');
    assert.ok(pointerEvents.some(event=>event.type==='pointermove'&&event.trusted&&event.buttons===1),'native drag move retains the left-button bitfield');
    assert.ok(Math.abs(panned.image.left-zoomed.image.left)>10,'real pointer drag pans the image');
    await screenshot(`preview-actions-zoomed-${width}x${height}`);
  }
  await clickText('.canvas-actions','适应');

  stage='floating-export-executes-host';
  const outputAsset=controller.workspace.project.assets.find(asset=>asset.asset_id===resultId),outputBytes=await controller.workspace.repository.readAsset(outputAsset);
  const exportedFile=path.join(base,'floating-action-export.png');exportTarget=exportedFile;
  const exportResponses=responses.filter(response=>response.type==='asset:export').length;
  await click('.preview-export');await until(()=>Promise.resolve(responses.filter(response=>response.type==='asset:export').length===exportResponses+1),'host export completed');
  assert.equal(responses.filter(response=>response.type==='asset:export').at(-1).ok,true);
  assert.deepEqual(await readFile(exportedFile),outputBytes,'floating export writes the selected original pixels');

  stage='failed-task-removal-selects-neighbor';
  const jobsBeforeRemoval=structuredClone(controller.workspace.project.jobs),callsBeforeRemoval=executions.length;
  await click(taskTile(first.task_id));await until(()=>js(`document.querySelector(${JSON.stringify(taskTile(first.task_id))})?.classList.contains('selected')`),'failed task selected for removal');
  assert.equal(await visible('.preview-remove'),true);assert.equal(await visible('.preview-export'),false,'failed task has no export button');
  await screenshot('failed-task-actions');await click('.preview-remove');
  await until(async()=>!await visible(taskTile(first.task_id)),'failed thumbnail removed');
  await until(()=>js(`document.querySelector(${JSON.stringify(resultTile)})?.classList.contains('selected')`),'neighbor result selected after failure removal');
  assert.equal(stateJob(first.task_id).hidden_from_results,true);assert.deepEqual(stateJob(first.task_id).recipe_snapshot,frozen);

  stage='result-removal-cancel-and-confirm';
  const trashResponses=responses.filter(response=>response.type==='result:trash').length;
  confirmations.push(0);await click('.preview-remove');
  await until(()=>Promise.resolve(responses.filter(response=>response.type==='result:trash').length===trashResponses+1),'cancelled removal completed');
  assert.equal(responses.filter(response=>response.type==='result:trash').at(-1).cancelled,true);
  assert.equal(await visible(resultTile),true);assert.equal(outputAsset.removed_result,undefined,'cancel keeps the result');
  await until(()=>js(`document.querySelector('.preview-remove')?.disabled===false`),'remove action re-enabled');
  confirmations.push(1);await click('.preview-remove');
  await until(async()=>!await visible(resultTile),'confirmed result removed');
  await until(()=>js(`document.querySelector(${JSON.stringify(taskTile(third.task_id))})?.classList.contains('selected')`),'next cancelled task selected');
  assert.deepEqual(await controller.workspace.repository.readAsset(outputAsset),outputBytes,'removal preserves historical reference pixels');
  assert.deepEqual(await readFile(exportedFile),outputBytes,'removal leaves the exported image intact');

  stage='cancelled-task-removal-and-empty-strip';
  for(const task of [third,fourth]){
    await until(()=>js(`document.querySelector(${JSON.stringify(taskTile(task.task_id))})?.classList.contains('selected')`),'cancelled task selected');
    await until(()=>js(`document.querySelector('.preview-remove')?.disabled===false`),'cancelled task removable');
    assert.equal(await visible('.preview-export'),false);await click('.preview-remove');
    await until(async()=>!await visible(taskTile(task.task_id)),'cancelled thumbnail removed');
    assert.equal(stateJob(task.task_id).hidden_from_results,true);
  }
  await until(()=>js(`document.querySelectorAll('.result-strip .result-thumb').length===0&&!document.querySelector('.generation-task-preview')`),'last removal exits task preview');
  assert.equal(await visible('.preview-remove'),false,'import fallback cannot be deleted as a generated result');
  assert.equal(executions.length,callsBeforeRemoval,'cleaning the strip never generates or retries');

  stage='reopen-keeps-removals-and-history';
  await execute({type:'project:save'});await controller.shutdown();controller=await createController();
  await controller.openProjectFile(filename);await win.loadFile(path.join(root,'dist','index.html'));
  await until(()=>visible('.generate-button'),'renderer reopened after cleanup');
  await until(()=>visible('.asset-tile'),'reopened document loaded');
  assert.equal(await js(`document.querySelectorAll('.result-strip .result-thumb').length`),0,'removed thumbnails do not return after reopen');
  assert.equal(controller.workspace.project.jobs.length,jobsBeforeRemoval.length,'history is retained for recovery');
  for(const job of jobsBeforeRemoval){const saved=stateJob(job.task_id);assert.deepEqual(saved.recipe_snapshot,job.recipe_snapshot);assert.deepEqual(saved.chain_snapshot,job.chain_snapshot);assert.deepEqual(saved.output_asset_ids,job.output_asset_ids);}
  assert.deepEqual(await controller.workspace.repository.readAsset(controller.workspace.project.assets.find(asset=>asset.asset_id===resultId)),outputBytes);
  await execute({type:'job:restore-recipe',project_id:projectId,task_id:first.task_id});await controller.refreshState();
  assert.deepEqual(controller.workspace.project.recipe.core_parameters,frozen.core_parameters);
  assert.equal(controller.workspace.project.recipe.modules.find(module=>module.reference_type==='prompt').user_instruction,prompt.user_instruction,'removed task parameters remain recoverable from history');
  assert.equal(await visible(taskTile(first.task_id)),false,'restoring parameters does not undo intentional thumbnail removal');
  assert.equal(executions.length,callsBeforeRemoval);assert.equal(confirmations.length,0);assert.equal(exportTarget,undefined);
  assert.equal(providerCalls,0);assert.equal(win.isVisible(),false);
  const report={passed:true,base,providerCalls,generationCalls:executions.length,taskIds:{failed:first.task_id,succeeded:second.task_id,cancelled:third.task_id,runningThenCancelled:fourth.task_id},screenshots,
    checks:['busy-button-animation','36-cell-mosaic-animation-advances','queued-task-placeholder','editing-preserves-task-snapshot','failed-placeholder-survives-dismiss','failed-click-restores-without-retry','cancelled-click-restores','multiple-tasks-ordered','success-replaces-placeholder','idle-animation-stops','document-reopen-retains-tasks','reopened-failure-restores','running-task-click-restores','two-viewports','prefers-reduced-motion','running-task-has-no-removal-or-export','floating-actions-track-image-and-stay-visible','fixed-size-actions-after-zoom-and-pan','keyboard-focusable-actions','floating-export-writes-original-pixels','failed-removal-selects-neighbor','result-removal-can-be-cancelled','confirmed-result-removal-preserves-pixels-and-export','cancelled-removal-and-empty-strip','reopen-retains-removals-and-history','removed-task-parameters-remain-recoverable','zero-network']};
  await writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));
  await controller.shutdown();controller=undefined;win.destroy();console.log(JSON.stringify(report));app.exit(0);
}).catch(async error=>{
  console.error('Stage: '+stage,error);
  if(base){await writeFile(path.join(base,'failure.json'),JSON.stringify({stage,error:error.stack??String(error),providerCalls},null,2)).catch(()=>{});if(frame)await writeFile(path.join(base,'failure.png'),frame).catch(()=>{});}
  if(controller)await controller.shutdown().catch(()=>{});
  app.exit(1);
});
