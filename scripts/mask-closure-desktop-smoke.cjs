// Run with Electron after npm run build. Isolated runtime, real pointer input,
// deterministic mock only: no installed profile, user document or model network.
const {app,BrowserWindow,ipcMain,protocol,net,dialog,shell}=require('electron');
const {mkdir,mkdtemp,readFile,writeFile}=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const root=path.resolve(__dirname,'..'),artifacts=path.join(root,'.local');
const reportFile=path.join(artifacts,'mask-closure-desktop-report.json');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const width=640,height=480,sourceRgb=[40,80,120],modelRgb=[220,90,40];
const checks=[],screenshots=[],previews=[],submitted=[];
let testRoot,win,controller,previewInFlight=0,mockCalls=0,networkAttempts=0;
shell.showItemInFolder=()=>{};
dialog.showMessageBox=async(_window,options)=>({response:options.cancelId??0});
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.on('window-all-closed',()=>{});
app.commandLine.appendSwitch('disable-background-networking');
const forbidNetwork=()=>{networkAttempts++;throw Error('The mask closure smoke forbids network requests.');};
global.fetch=forbidNetwork;
for(const module of ['node:http','node:https']){const transport=require(module);transport.request=forbidNetwork;transport.get=forbidNetwork;}

app.whenReady().then(async()=>{
  await mkdir(artifacts,{recursive:true});testRoot=await mkdtemp(path.join(artifacts,'mask-closure-desktop-'));
  app.setPath('userData',path.join(testRoot,'electron'));
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  win=new BrowserWindow({width:1540,height:1040,show:false,webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{networkAttempts++;callback({cancel:true});});
  controller=await DesktopController.create(path.join(testRoot,'runtime'),()=>win);
  const execute=controller.execute.bind(controller);
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  ipcMain.handle('ediro:command',async(_event,command)=>{
    if(command.type==='mask:start')submitted.push(structuredClone(command.draft));
    if(command.type!=='mask:preview')return execute(command);
    previewInFlight++;
    try{const result=await execute(command);previews.push({strokes:structuredClone(command.composite_strokes??[]),ok:result.ok,error:result.error,image:result.mask_preview});return result;}
    finally{previewInFlight--;}
  });
  protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller.assetPath(request.url)).href);}catch{return new Response('missing',{status:404});}});
  controller.executors.execute=async context=>{
    assert.equal(context.model.kind,'mock');assert.ok(context.job.mask_edit);mockCalls++;
    const input=await context.readImage(context.job.mask_edit.request_source_id??context.job.mask_edit.source_snapshot_id);
    const meta=await sharp(input).metadata();
    const bytes=await sharp({create:{width:meta.width,height:meta.height,channels:3,background:{r:modelRgb[0],g:modelRgb[1],b:modelRgb[2]}}}).png().toBuffer();
    return {images:[{bytes,format:'png',width:meta.width,height:meta.height}]};
  };
  const sourceFile=path.join(testRoot,'source.png');
  await writeFile(sourceFile,await sharp({create:{width,height,channels:3,background:{r:sourceRgb[0],g:sourceRgb[1],b:sourceRgb[2]}}}).png().toBuffer());
  const imported=await execute({type:'assets:drop',paths:[sourceFile],module_id:controller.workspace.project.recipe.modules[0].module_id});assert.ok(imported.ok,imported.error);
  const js=script=>win.webContents.executeJavaScript(script);
  const until=async(predicate,description,timeout=30000)=>{const started=Date.now();while(Date.now()-started<timeout){if(await predicate())return;await wait(40);}throw Error(`Timed out: ${description}`);};
  const click=async(text,selector='.mask-tool-row button')=>{
    await js(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!button||button.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});button.click();})()`);await wait(70);
  };
  const checkbox=()=>js(`(()=>{const label=[...document.querySelectorAll('.mask-editor label')].find(el=>el.textContent.trim()==='闭合自动填充');const input=label?.querySelector('input[type="checkbox"]');if(!input)throw Error('闭合自动填充 checkbox missing');return {checked:input.checked,disabled:input.disabled};})()`);
  const toggleClosure=async checked=>{
    if((await checkbox()).checked!==checked)await js(`(()=>{const label=[...document.querySelectorAll('.mask-editor label')].find(el=>el.textContent.trim()==='闭合自动填充');label.querySelector('input').click();})()`);
    await wait(60);assert.equal((await checkbox()).checked,checked);
  };
  const field=async(selector,value,tag='input')=>{
    await js(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field)throw Error('Field missing');Object.getOwnPropertyDescriptor(${tag==='textarea'?'HTMLTextAreaElement':'HTMLInputElement'}.prototype,'value').set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(60);
  };
  const selection=()=>js(`(()=>{const image=document.querySelector('.mask-overlay mask image');if(!image)throw Error('Selection overlay missing');const href=image.getAttribute('href');return decodeURIComponent(href.slice(href.indexOf(',')+1));})()`);
  const pixel=async(bytes,x,y)=>{const {data,info}=await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});const offset=(Math.floor(y*info.height)*info.width+Math.floor(x*info.width))*info.channels;return [...data.subarray(offset,offset+3)];};
  const selected=async(x,y,expected,label)=>{let rgb;for(let attempt=0;attempt<30;attempt++){rgb=await pixel(Buffer.from(await selection()),x,y);if(expected?rgb.every(v=>v>250):rgb.every(v=>v<5))return;await wait(50);}assert.ok(false,`${label}: ${JSON.stringify(rgb)}`);};
  const ellipse=(rx,ry,steps=64,end=2*Math.PI)=>Array.from({length:steps+1},(_,i)=>[.5+Math.cos(i/steps*end)*rx,.5+Math.sin(i/steps*end)*ry]);
  const surface=()=>js(`(()=>{const b=document.querySelector('.mask-surface').getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};})()`);
  const pointer=async(points,{up=points.at(-1),finish='up'}={})=>{
    const box=await surface(),at=([x,y])=>({x:Math.round(box.x+box.width*x),y:Math.round(box.y+box.height*y)});
    await js(`document.querySelector('.mask-surface').addEventListener('pointerdown',event=>{window.__closurePointerId=event.pointerId;},{once:true})`);
    win.webContents.sendInputEvent({type:'mouseMove',...at(points[0])});
    win.webContents.sendInputEvent({type:'mouseDown',...at(points[0]),button:'left',clickCount:1});
    for(const p of points.slice(1)){win.webContents.sendInputEvent({type:'mouseMove',...at(p),modifiers:['leftButtonDown']});await wait(5);}
    if(finish==='cancel'){
      // sendInputEvent has no pointercancel. Preserve the real gesture and its
      // pointer id; synthesize only this otherwise inaccessible cancellation.
      await js(`document.querySelector('.mask-surface').dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.__closurePointerId,pointerType:'mouse',bubbles:true}))`);
    }else if(finish==='outside'){
      win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(box.x-8),y:Math.round(box.y+box.height*.5),modifiers:['leftButtonDown']});await wait(30);
    }
    win.webContents.sendInputEvent({type:'mouseUp',...at(up),button:'left',clickCount:1});await wait(100);
  };
  const capture=async name=>{const file=path.join(testRoot,name);await writeFile(file,(await win.webContents.capturePage()).toPNG());screenshots.push(file);};
  const previewReady=async()=>{
    await until(async()=>previewInFlight===0&&await js(`!!document.querySelector('.mask-generate')&&!document.querySelector('.mask-generate').disabled`),'composite preview');await wait(100);
    assert.ok(previews.at(-1)?.ok,previews.at(-1)?.error);return previews.at(-1);
  };
  const previewPixel=async(x,y,expected,label)=>{const preview=await previewReady(),bytes=Buffer.from(preview.image.slice(preview.image.indexOf(',')+1),'base64');assert.deepEqual(await pixel(bytes,x,y),expected,label);return preview;};

  await win.loadFile(path.join(root,'dist/index.html'));
  await until(()=>js(`!!document.querySelector('.asset-tile')`),'imported asset');
  await js(`document.querySelector('.asset-tile').click()`);await wait(80);
  await js(`document.querySelector('.mask-edit-entry').click()`);
  await until(()=>js(`document.querySelector('.mask-surface')?.getBoundingClientRect().width>200`),'mask surface');await wait(150);
  assert.deepEqual(await checkbox(),{checked:true,disabled:false});await field('[aria-label="蒙版画笔大小"]',8);
  checks.push('default-enabled-checkbox-in-real-renderer');
  const repository=controller.workspace.repository,beforeDrawing=await readFile(repository.filename);
  await pointer(ellipse(.30,.32));await selected(.5,.5,true,'closed paint fills center');await selected(.1,.1,false,'outside remains unselected');
  await click('减选');await pointer(ellipse(.10,.12));
  await selected(.5,.5,false,'closed erase clears center');await selected(.7,.5,true,'erase preserves outer ring');
  await click('撤销');await selected(.5,.5,true,'undo removes entire filled erase stroke');
  await click('重做');await selected(.5,.5,false,'redo restores entire filled erase stroke');
  await capture('generation-filled-ring.png');
  checks.push('native-closed-paint-fills','native-closed-erase-hollows','generation-undo-redo-whole-stroke');

  await click('清空');await click('画笔');await toggleClosure(false);await pointer(ellipse(.30,.32));
  await selected(.5,.5,false,'disabled closure retains ordinary brush outline');await selected(.8,.5,true,'disabled closure still paints the outline');
  await toggleClosure(true);await selected(.5,.5,false,'enabling does not retroactively fill existing strokes');
  await click('清空');await pointer(ellipse(.30,.32));await toggleClosure(false);await click('减选');await pointer(ellipse(.10,.12));
  await selected(.5,.5,true,'disabled closure erase preserves circle interior');await selected(.6,.5,false,'disabled closure erase still removes outline');
  await toggleClosure(true);await selected(.5,.5,true,'enabling does not retroactively erase interior');await click('画笔');
  checks.push('toggle-off-paint-and-erase-preserve-outline-semantics','toggle-does-not-reinterpret-existing-strokes');

  await click('清空');await pointer(ellipse(.30,.32,48,Math.PI*1.5));
  await selected(.5,.5,false,'open arc remains unfilled');await selected(.8,.5,true,'open arc keeps brush marks');
  checks.push('open-gesture-remains-ordinary-brush');
  await click('清空');await pointer(ellipse(.30,.32),{finish:'cancel'});
  await selected(.5,.5,false,'pointercancel must not auto-fill an otherwise closed gesture');await selected(.8,.5,true,'pointercancel preserves ordinary brush marks');
  await click('清空');await pointer(ellipse(.30,.32),{finish:'outside'});
  await selected(.5,.5,false,'leaving image must not auto-fill an otherwise closed gesture');
  checks.push('pointercancel-does-not-fill','leaving-image-does-not-fill');

  // Only the mouseup returns to the start; the last mousemove is 45 degrees away.
  await click('清空');const outer=ellipse(.30,.32,56,Math.PI*1.75);
  await pointer(outer,{up:outer[0]});await selected(.5,.5,true,'pointerup endpoint closes gesture');
  await click('减选');await pointer(ellipse(.10,.12));
  assert.deepEqual(await readFile(repository.filename),beforeDrawing,'Trial drawing never writes the project.');
  assert.equal(controller.workspace.project.mask_drafts,undefined);
  await field('#mask-instruction','本地闭合蒙版模拟验证','textarea');
  await until(()=>js(`!document.querySelector('.mask-generate').disabled`),'mock generation enabled');
  await js(`document.querySelector('.mask-generate').click()`);
  await until(()=>Promise.resolve(controller.workspace.project.jobs.at(-1)?.status==='succeeded'),'mock mask generation');
  await controller.workspace.serial(async()=>{});
  const project=controller.workspace.project,job=project.jobs.at(-1),draft=job.mask_edit.draft;
  assert.equal(mockCalls,1);assert.equal(submitted.length,1);assert.equal(draft.strokes.length,2);
  assert.ok(draft.strokes.every(stroke=>stroke.closed===true));assert.deepEqual(draft,submitted[0]);
  const finalPoint=draft.strokes[0].points.at(-1);
  assert.ok(Math.hypot(finalPoint[0]-outer[0][0],finalPoint[1]-outer[0][1])<.006,'pointerup endpoint is stored');
  assert.deepEqual((await repository.load()).jobs.at(-1).mask_edit.draft,draft,'Saved generation draft retains closed semantics.');
  checks.push('pointerup-final-position-committed','trial-drawing-does-not-save','mock-generation-saves-closed-draft');

  await until(()=>js(`document.querySelector('.mask-view-tabs .selected')?.textContent==='修改结果'`),'result editing');
  await previewPixel(.7,.5,modelRgb,'filled outer region adopts model pixels');
  await previewPixel(.5,.5,sourceRgb,'erased hole preserves source pixels');await previewPixel(.1,.1,sourceRgb,'outside region preserves source pixels');
  assert.ok(previews.at(-1).strokes.every(stroke=>stroke.closed===true));
  const beforeComposite=await readFile(repository.filename);
  await click('画笔');await pointer(ellipse(.065,.08));await previewPixel(.5,.5,modelRgb,'closed composite paint fills hole');
  assert.equal(previews.at(-1).strokes.at(-1).closed,true);
  await click('撤销');await previewPixel(.5,.5,sourceRgb,'composite undo restores hole');
  await click('重做');await previewPixel(.5,.5,modelRgb,'composite redo restores filled stroke');
  await click('减选');await pointer(ellipse(.035,.04));await previewPixel(.5,.5,sourceRgb,'closed composite erase creates inner hole');
  await previewPixel(.55,.5,modelRgb,'closed composite erase preserves surrounding fill');
  assert.equal(previews.at(-1).strokes.length,4);assert.ok(previews.at(-1).strokes.every(stroke=>stroke.closed===true));
  assert.deepEqual(await readFile(repository.filename),beforeComposite,'Composite trial edits never write the project.');
  await capture('composite-filled-rings.png');
  checks.push('saved-closed-draft-preview-pixels','composite-closed-paint-and-erase','composite-undo-redo-whole-stroke','composite-trial-does-not-save');

  const expectedStrokes=structuredClone(previews.at(-1).strokes),variantCount=job.mask_edit.variants.length;
  await js(`document.querySelector('.mask-generate').click()`);
  await until(()=>Promise.resolve(job.mask_edit.variants.length===variantCount+1),'confirmed composite variant');await controller.workspace.serial(async()=>{});
  const variant=job.mask_edit.variants.at(-1),output=project.assets.find(asset=>asset.asset_id===variant.asset_id);
  assert.deepEqual(variant.composite_strokes,expectedStrokes);
  assert.deepEqual((await repository.load()).jobs.at(-1).mask_edit.variants.at(-1).composite_strokes,expectedStrokes);
  const outputBytes=await repository.readAsset(output);
  assert.deepEqual(await pixel(outputBytes,.7,.5),modelRgb);assert.deepEqual(await pixel(outputBytes,.55,.5),modelRgb);
  assert.deepEqual(await pixel(outputBytes,.5,.5),sourceRgb);assert.deepEqual(await pixel(outputBytes,.1,.1),sourceRgb);
  assert.equal(mockCalls,1);assert.equal(networkAttempts,0);checks.push('confirmed-composite-retains-closed-flags-and-pixels','one-local-mock-no-network');
  await controller.shutdown();win.destroy();
  const report={passed:true,testRoot,screenshots,node:process.versions.node,electron:process.versions.electron,mockCalls,networkAttempts,checks,previewRequests:previews.length,fixture:{width,height,sourceRgb,modelRgb,hidden:true,offscreen:true},savedStrokes:expectedStrokes.map(({points,...stroke})=>({...stroke,pointCount:points.length}))};
  await writeFile(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));app.exit(0);
}).catch(async error=>{
  if(win&&!win.isDestroyed()&&testRoot){try{await writeFile(path.join(testRoot,'failure.png'),(await win.webContents.capturePage()).toPNG());await writeFile(path.join(testRoot,'failure.html'),await win.webContents.executeJavaScript('document.documentElement.outerHTML'));}catch{}}
  const report={passed:false,testRoot,error:error.stack,checks,screenshots,mockCalls,networkAttempts,submitted,previews:previews.map(({image,...preview})=>preview)};
  await writeFile(reportFile,JSON.stringify(report,null,2)).catch(()=>{});console.error(error);app.exit(1);
});


