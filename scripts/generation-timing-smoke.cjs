// Real hidden Electron renderer + DesktopController with a local, controlled
// cloud-kind fixture. No credentials or user runtime are read; network is denied.
// Run with Electron after npm run build.
const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');
const {mkdir,mkdtemp,writeFile,readFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),sharp=require('sharp');
const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let base,controller,win,frame,paintSequence=0,stage='startup',providerCalls=0;
globalThis.fetch=async()=>{providerCalls++;throw Error('Network is forbidden in generation-timing smoke.');};
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});

app.whenReady().then(async()=>{
  await mkdir(path.join(root,'.local'),{recursive:true});
  base=await mkdtemp(path.join(root,'.local','generation-timing-ui-'));
  app.setPath('userData',path.join(base,'electron'));
  const runtime=path.join(base,'runtime'),timingFile=path.join(runtime,'generation-timings.v1.json');
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {registerWindowChrome}=await import('../dist-host/desktop/window-chrome.js');
  const {modelForEnrollment}=await import('../dist-host/protocols/model-catalog.js');
  win=new BrowserWindow({width:1775,height:1050,show:false,backgroundColor:'#f6f5f1',
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,offscreen:true}});
  win.setMenuBarVisibility(false);registerWindowChrome(ipcMain,()=>win);
  win.webContents.on('paint',(_event,_dirty,image)=>{if(!image.isEmpty()){frame=image.toPNG();paintSequence++;}});
  win.webContents.setFrameRate(30);
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{providerCalls++;callback({cancel:true});});
  const controls=new Map(),executions=[],commands=[],screenshots=[];
  const output=await sharp({create:{width:512,height:512,channels:3,background:'#c4d0ba'}}).png().toBuffer();
  const connectionId='connection_timing_smoke',modelId='model_timing_smoke';
  const createController=async()=>{
    const next=await DesktopController.create(runtime,()=>win,{deferStartup:true,projectRoot:base,showMessage:async()=>{throw Error('Unexpected native dialog in generation-timing smoke.');}});
    // Keep the normal cloud model/platform/family resolution. Only this isolated
    // test adapter's credential gate and execution are replaced; no API runs.
    next.workspace.models.adapters.find(adapter=>adapter.adapter_id==='gemini-generate-content').requires_credential=false;
    if(!next.workspace.models.snapshot().connections.some(connection=>connection.connection_id===connectionId)){
      await next.workspace.models.saveConnection({connection_id:connectionId,title:'耗时验证平台（本地受控）',endpoint:'https://timing-smoke.invalid',enabled:true,adapter_id:'gemini-generate-content'});
      await next.workspace.models.saveModel({...modelForEnrollment('nano','gemini-generate-content',modelId,connectionId,'timing-smoke-image'),title:'Nano 耗时验证（禁止网络）'});
      await next.workspace.models.assign('generation',modelId);
    }
    next.executors.probe=async()=>{providerCalls++;throw Error('Provider discovery is forbidden.');};
    next.executors.execute=async(context,signal,progress)=>{
      assert.equal(context.model.kind,'cloud');assert.equal(context.model.model_config_id,modelId);
      assert.equal(context.model.endpoint,'https://timing-smoke.invalid');
      executions.push(context.job.task_id);await progress('等待本地受控结果',30);
      await new Promise((resolve,reject)=>{
        const abort=()=>{controls.delete(context.job.task_id);reject(Error('受控任务已取消。'));};
        signal.addEventListener('abort',abort,{once:true});
        controls.set(context.job.task_id,{
          succeed:()=>{signal.removeEventListener('abort',abort);controls.delete(context.job.task_id);resolve();},
          fail:()=>{signal.removeEventListener('abort',abort);controls.delete(context.job.task_id);reject(Error('受控生成失败'));},
        });
        if(signal.aborted)abort();
      });
      return {images:[{bytes:output,format:'png',width:512,height:512}]};
    };
    return next;
  };
  controller=await createController();
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  const allowed=new Set(['state','recipe:save','project:save','job:start','job:cancel','reference:preview','reference:cancel-preview']);
  ipcMain.handle('ediro:command',async(_event,command)=>{commands.push(command.type);assert.ok(allowed.has(command.type),'Unexpected renderer command '+command.type);return controller.execute(command);});
  const execute=async command=>{const response=await controller.execute(command);assert.equal(response.ok,true,response.error);return response;};
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async(check,label)=>{for(let i=0;i<300;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const click=async selector=>js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||el.closest('[inert]'))throw Error('Unavailable control '+${JSON.stringify(selector)});el.click();})()`);
  const job=id=>controller.workspace.project.jobs.find(item=>item.task_id===id);
  const timing=id=>controller.workspace.generationTimingByTask.get(id);
  const progress=()=>js(`(()=>{const el=document.querySelector('.task-progress'),bar=el?.querySelector('progress');return el&&bar?{taskId:el.dataset.taskId,value:bar.hasAttribute('value')?bar.value:null,percentage:el.querySelector('.generation-percentage')?.textContent,position:bar.position,text:el.textContent,animations:el.getAnimations({subtree:true}).filter(a=>a instanceof CSSAnimation&&a.playState==='running'&&a.effect.getTiming().iterations===Infinity).map(a=>({name:a.animationName,time:Number(a.currentTime)}))}:null;})()`);
  const assertPercentage=state=>assert.equal(state.percentage,state.value===null?'—%':`${Math.floor(state.value)}%`,'visible percentage matches the current progress bar');
  const assertCompactTiming=async()=>{
    const layout=await js(`(()=>{const row=document.querySelector('.generation-timing-row'),text=row.querySelector('.generation-timing'),cancel=row.querySelector('button'),r=row.getBoundingClientRect(),t=text.getBoundingClientRect(),c=cancel?.getBoundingClientRect();return {height:r.height,textHeight:t.height,lineHeight:parseFloat(getComputedStyle(text).lineHeight),textRight:t.right,rowRight:r.right,cancelLeft:c?.left,cancelRight:c?.right};})()`);
    assert.ok(layout.textHeight<=layout.lineHeight+1&&layout.height<=20,'percentage and times remain one compact row');
    assert.ok(layout.textRight<=(layout.cancelLeft??layout.rowRight)-1,'timing text does not overlap the cancel button');
    assert.ok(layout.cancelRight===undefined||layout.cancelRight<=layout.rowRight+1,'cancel button stays within the row');
  };
  const samples=async()=>{try{return JSON.parse(await readFile(timingFile,'utf8')).samples;}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const startJob=async()=>{
    const count=controller.workspace.project.jobs.length;await click('.generate-button');
    await until(()=>Promise.resolve(controller.workspace.project.jobs.length===count+1),'job enqueued');
    // Publishing a new draft reloads its persisted jobs, so callers must retain
    // only identity here and inspect the current workspace object thereafter.
    return {task_id:controller.workspace.project.jobs.at(-1).task_id};
  };
  const running=async id=>{await until(()=>Promise.resolve(controls.has(id)),'controlled execution');await until(async()=>(await progress())?.taskId===id,'running task displayed');assert.ok(timing(id),'executing task has application-local timing');assert.equal('timing' in job(id),false,'transient timing is not attached to project jobs');};
  const settle=async(id,status)=>{await until(()=>Promise.resolve(job(id)?.status===status),status+' status');await controller.refreshState();};
  const assertDocumentHasNoTiming=async()=>{
    await execute({type:'project:save'});
    const repo=controller.workspace.repository;
    assert.ok(repo.filename?.endsWith('.ediro'));
    const forbidden=/"(?:timing|generation_timings|estimated_duration_ms|sample_count|duration_ms|platform_id)"/;
    assert.doesNotMatch(JSON.stringify(controller.workspace.project),forbidden);
    assert.doesNotMatch(JSON.stringify(await repo.load()),forbidden);
    // Inspect the actual SQLite document bytes, not just the parsed cache: a
    // parser stripping fields must not disguise unwanted persistent metadata.
    const db=new DatabaseSync(repo.filename,{readOnly:true});
    try{
      const version=db.prepare('PRAGMA user_version').get().user_version;
      const bytes=version===1?Buffer.from(db.prepare("SELECT bytes FROM entries WHERE name='ediro.project.json'").get().bytes):Buffer.concat(db.prepare("SELECT b.bytes,p.encoding FROM parts p JOIN blobs b ON b.hash=p.blob_hash WHERE p.entry_name='ediro.project.json' ORDER BY p.ordinal").all().map(part=>part.encoding==='base64'?Buffer.from(Buffer.from(part.bytes).toString('base64')):Buffer.from(part.bytes)));
      assert.ok(bytes.length>0,'document has an actual stored project manifest');
      assert.doesNotMatch(bytes.toString('utf8'),forbidden);
    }finally{db.close();}
  };
  const prepareRecipe=async()=>{
    await execute({type:'recipe:select-model',model_config_id:modelId});
    const recipe=structuredClone(controller.workspace.project.recipe);
    for(const module of recipe.modules){module.asset_ids=[];if(module.reference_type==='prompt'){module.auto_prompt=false;module.user_instruction='本地验证预计进度，绿色背景上的简单方块。';}}
    await execute({type:'recipe:save',recipe});await win.loadFile(path.join(root,'dist','index.html'));
    await until(()=>js(`document.querySelector('.generate-button')?.disabled===false`),'renderer ready');
  };
  const screenshot=async name=>{
    const before=paintSequence;win.webContents.startPainting();win.webContents.invalidate();
    await until(()=>Promise.resolve(paintSequence>before&&frame),'fresh frame');await wait(120);
    const filename=path.join(base,name+'.png');await writeFile(filename,frame);screenshots.push(filename);
  };

  stage='cold-start-indeterminate';await prepareRecipe();
  assert.equal((await samples()).length,0);
  const first=await startJob();await running(first.task_id);
  assert.equal(timing(first.task_id).sample_count,0);assert.equal(timing(first.task_id).estimated_duration_ms,undefined);
  const coldBefore=await progress();assert.equal(coldBefore.value,null);assert.equal(coldBefore.position,-1);
  assertPercentage(coldBefore);
  assert.match(coldBefore.text,/预计.*已用/);assert.doesNotMatch(coldBefore.text,/积累|已超过|等待本地|预计进度/);assert.ok(coldBefore.animations.length>0,'cold start has a continuous waiting animation');
  const initialView=await controller.view();assert.ok(initialView.generation_timings[first.task_id]);assert.equal('timing' in initialView.project.jobs[0],false,'view timing travels outside the project payload');
  await wait(1150);const coldAfter=await progress();
  assert.notEqual(coldAfter.text,coldBefore.text,'elapsed time keeps updating without samples');
  assert.ok(coldAfter.animations.some((animation,index)=>animation.time>coldBefore.animations[index]?.time),'indeterminate animation advances');
  await screenshot('cold-start-1775x1050');
  controls.get(first.task_id).succeed();await settle(first.task_id,'succeeded');
  await until(async()=>(await progress())?.value===100,'actual success reaches 100');
  assertPercentage(await progress());
  await until(async()=>(await samples()).length===1,'first successful duration persisted');
  const firstSamples=await samples();
  assert.equal(firstSamples[0].task_id,first.task_id);assert.equal(firstSamples[0].platform_id,connectionId);assert.equal(firstSamples[0].family,'nano');
  assert.ok(firstSamples[0].duration_ms>=1150,'recorded duration includes actual wait');
  await assertDocumentHasNoTiming();

  stage='learned-progress-and-queue';
  const second=await startJob();await running(second.task_id);
  assert.equal(timing(second.task_id).sample_count,1);assert.equal(timing(second.task_id).estimated_duration_ms,firstSamples[0].duration_ms);
  const learnedBefore=await progress();assert.ok(learnedBefore.value>=0&&learnedBefore.value<100);assert.match(learnedBefore.text,/预计/);
  await wait(600);const learnedAfter=await progress();assert.ok(learnedAfter.value>learnedBefore.value,'estimated progress advances while model waits');assert.ok(learnedAfter.value<100);
  assertPercentage(learnedBefore);assertPercentage(learnedAfter);
  const queued=await startJob();await until(()=>Promise.resolve(job(queued.task_id)?.status==='queued'),'third task queued');
  assert.equal((await progress()).taskId,second.task_id,'queued task does not obscure currently executing task');
  assert.equal(timing(queued.task_id)?.started_at,undefined,'queue time is not execution time');
  await execute({type:'job:cancel',task_id:queued.task_id});await settle(queued.task_id,'cancelled');
  assert.equal((await progress()).taskId,second.task_id);
  await until(async()=>(await progress())?.value>90,'elapsed estimate continues beyond the historical mean');
  assert.doesNotMatch((await progress()).text,/积累|已超过|等待本地|预计进度/,'no extra sidebar explanation when estimate is exceeded');
  assert.ok((await progress()).value<100,'estimate never completes a still-running request');
  for(const [width,height] of [[1775,1050],[1120,800]]){
    win.setSize(width,height);await wait(150);
    const layout=await js(`(()=>{const el=document.querySelector('.task-progress'),r=el.getBoundingClientRect(),panel=el.closest('.parameter-section').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,panelBottom:panel.bottom,viewport:[innerWidth,innerHeight]};})()`);
    assert.ok(layout.width>0&&layout.height>0&&layout.left>=0&&layout.top>=0&&layout.right<=layout.viewport[0]+1&&layout.bottom<=layout.viewport[1]+1,'progress fits viewport '+width);
    assert.ok(layout.bottom<=layout.panelBottom+1,'elapsed time and cancel button are not clipped by parameter panel '+width);
    assert.equal(await js(`document.querySelectorAll('.task-progress .generation-timing').length`),1,'one compact timing line');
    assertPercentage(await progress());await assertCompactTiming();
    await screenshot(`estimated-wait-${width}x${height}`);
  }
  controls.get(second.task_id).succeed();await settle(second.task_id,'succeeded');
  await until(async()=>(await samples()).length===2,'second success sampled and queued cancellation excluded');

  stage='failed-and-cancelled-stop-without-samples';
  const failed=await startJob();await running(failed.task_id);await wait(300);controls.get(failed.task_id).fail();await settle(failed.task_id,'failed');
  await until(()=>js(`!!document.querySelector('.app-dialog')`),'failure dialog');
  await js(`(()=>{const button=[...document.querySelectorAll('.app-dialog button')].find(el=>el.textContent.trim()==='知道了');if(!button)throw Error('Missing failure dismiss');button.click();})()`);
  await until(()=>js(`!document.querySelector('.app-dialog')`),'failure dismissed');
  const frozenFailure=await progress();await wait(500);assert.deepEqual(await progress(),frozenFailure,'failed task progress and elapsed time stay frozen');
  assert.equal(frozenFailure.animations.length,0);assert.equal((await samples()).length,2);
  const cancelled=await startJob();await running(cancelled.task_id);await wait(300);await execute({type:'job:cancel',task_id:cancelled.task_id});await settle(cancelled.task_id,'cancelled');
  const frozenCancelled=await progress();await wait(500);assert.deepEqual(await progress(),frozenCancelled,'cancelled progress and elapsed time stay frozen');
  assert.equal(frozenCancelled.animations.length,0);assert.equal((await samples()).length,2);

  stage='restart-new-project-uses-shared-samples';
  const previousProjectId=controller.workspace.project.project_id,persisted=await samples();
  await assertDocumentHasNoTiming();
  await controller.shutdown();controller=await createController();await prepareRecipe();
  assert.notEqual(controller.workspace.project.project_id,previousProjectId,'restart begins a different project');
  assert.equal(controller.workspace.generationTimingByTask.size,0,'per-task clocks are transient across restart');
  const restarted=await startJob();await running(restarted.task_id);
  assert.equal(timing(restarted.task_id).sample_count,2,'new project reuses global history');
  const average=persisted.reduce((sum,sample)=>sum+sample.duration_ms,0)/persisted.length;
  assert.ok(Math.abs(timing(restarted.task_id).estimated_duration_ms-average)<=1,'estimate is the mean of successful group samples');
  assert.notEqual((await progress()).value,null);controls.get(restarted.task_id).succeed();await settle(restarted.task_id,'succeeded');
  await until(async()=>(await progress())?.value===100,'restarted actual success reaches 100');
  await until(async()=>(await samples()).length===3,'new project adds one global sample');
  await assertDocumentHasNoTiming();
  assert.equal(providerCalls,0);assert.equal(win.isVisible(),false);
  const report={passed:true,base,runtime,providerCalls,generationCalls:executions.length,samples:await samples(),screenshots,
    checks:['cold-start-animated-indeterminate','elapsed-clock-updates','success-records-timing','mean-based-progress-advances','visible-percentage-matches-bar','queued-task-does-not-hide-running','queue-not-timed','overdue-under-100-without-extra-copy','compact-single-timing-line','two-viewports','failure-stops-without-sample','cancel-stops-without-sample','restart-and-cross-project-history','timing-outside-project-payload','raw-sqlite-document-without-timing','actual-success-only-100','zero-network']};
  await writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2));
  await controller.shutdown();controller=undefined;win.destroy();console.log(JSON.stringify(report));app.exit(0);
}).catch(async error=>{
  console.error('Stage: '+stage,error);
  if(base){await writeFile(path.join(base,'failure.json'),JSON.stringify({stage,error:error.stack??String(error),providerCalls},null,2)).catch(()=>{});if(frame)await writeFile(path.join(base,'failure.png'),frame).catch(()=>{});}
  if(controller)await controller.shutdown().catch(()=>{});
  app.exit(1);
});
