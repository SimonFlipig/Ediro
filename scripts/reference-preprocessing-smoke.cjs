// Real ONNX workers under Electron, with an isolated project and simulated
// generation only. Usage: electron scripts/reference-preprocessing-smoke.cjs <image>
const {app}=require('electron');
const {mkdir,mkdtemp,cp,writeFile,readdir}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const sharp=require('sharp');
const root=path.resolve(__dirname,'..');
const source=process.argv[2];
let controller,base,providerCalls=0;
globalThis.fetch=async()=>{providerCalls++;throw Error('Network forbidden in preprocessing smoke');};
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  if(!source)throw Error('Provide a local product/reference image path.');
  await mkdir(path.join(root,'.local'),{recursive:true});
  base=await mkdtemp(path.join(root,'.local','reference-preprocessing-smoke-'));
  app.setPath('userData',path.join(base,'electron'));
  const runtime=path.join(base,'.local','runtime');
  const {localImageModelStatus,resolveLocalImageModel,modelDirectory}=await import('../dist-host/adapters/local-image-models.js');
  for(const kind of ['depth','segment'])await resolveLocalImageModel(path.join(root,'.local','runtime'),kind);
  await cp(modelDirectory(path.join(root,'.local','runtime')),modelDirectory(runtime),{recursive:true,errorOnExist:true,force:false});
  assert.deepEqual(await localImageModelStatus(runtime),{depth:'ready',segment:'ready'});
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  // No visible window or dialogs are needed; all commands use the real host.
  const window={isDestroyed:()=>false,webContents:{send:()=>{}}};
  controller=await DesktopController.create(runtime,()=>window,{deferStartup:true,projectRoot:base,showMessage:async()=>{throw Error('Unexpected dialog');}});
  const execute=async command=>{const result=await controller.execute(command);assert.equal(result.ok,true,result.error);return result;};
  let project=controller.workspace.project;
  const composition=project.recipe.modules.find(module=>module.reference_type==='composition');
  await execute({type:'assets:drop',paths:[path.resolve(source)],module_id:composition.module_id});
  project=controller.workspace.project;
  const recipe=structuredClone(project.recipe),assetId=recipe.modules.find(module=>module.reference_type==='composition').asset_ids[0];
  for(const module of recipe.modules){module.asset_ids=module.reference_type==='subject'||module.reference_type==='composition'?[assetId]:[];if(module.reference_type==='prompt')module.user_instruction='保持主体产品，参考构图';}
  await execute({type:'recipe:save',recipe});
  const original=await controller.workspace.repository.readAsset(project.assets.find(asset=>asset.asset_id===assetId));
  const {resizeReferenceImage,readReferenceImage}=await import('../dist-host/adapters/reference-image.js');
  const {defaultModuleSettings}=await import('../dist-host/core/module-settings.js');
  const reports=[];
  const beforePreview=structuredClone(project.recipe);
  const draftSettings={max_edge:512,preprocess:'blur',blur_strength:'weak'};
  const draftPreview=await execute({type:'reference:preview',request_id:'preview_unsaved',project_id:project.project_id,asset_id:assetId,reference_type:'composition',module_id:composition.module_id,settings:draftSettings});
  assert.ok(draftPreview.reference_preview);
  assert.deepEqual(project.recipe,beforePreview,'previewing draft settings must not save them');
  const wrongModule=await controller.execute({type:'reference:preview',request_id:'preview_wrong_module',project_id:project.project_id,asset_id:assetId,reference_type:'composition',module_id:recipe.modules.find(module=>module.reference_type==='subject').module_id,settings:draftSettings});
  assert.equal(wrongModule.ok,false,'preview must validate the specific module owning the reference');
  const previewCommand=(request_id,settings=draftSettings)=>({type:'reference:preview',request_id,project_id:project.project_id,asset_id:assetId,reference_type:'composition',module_id:composition.module_id,settings});
  const clearSettings={...draftSettings,preprocess:'none'};
  const parallel=await Promise.all([execute(previewCommand('preview_parallel_clear',clearSettings)),execute(previewCommand('preview_parallel_blur'))]);
  assert.deepEqual(Buffer.from(parallel[0].reference_preview.split(',')[1],'base64'),await resizeReferenceImage(original,512));
  assert.equal(parallel[1].reference_preview,draftPreview.reference_preview,'independent previews must both complete without cancelling one another');
  // Hold snapshot reads so cancellation and duplicate-id behavior are deterministic.
  let releaseReads;
  const readGate=controller.workspace.serial(()=>new Promise(resolve=>{releaseReads=resolve;}));
  while(!releaseReads)await new Promise(resolve=>setTimeout(resolve,0));
  const cancelledPreview=controller.execute(previewCommand('preview_cancel_one'));
  const retainedPreview=controller.execute(previewCommand('preview_keep_other',clearSettings));
  const duplicate=await controller.execute(previewCommand('preview_keep_other'));
  assert.equal(duplicate.ok,false);assert.match(duplicate.error,/编号重复/);
  await execute({type:'reference:cancel-preview',request_id:'preview_cancel_one'});
  releaseReads();await readGate;
  assert.equal((await cancelledPreview).ok,false);
  const retained=await retainedPreview;assert.equal(retained.ok,true,retained.error);
  assert.equal(retained.reference_preview,parallel[0].reference_preview,'cancelling one request and rejecting a duplicate must preserve other previews');
  const updateComposition=async settings=>{
    const recipe=structuredClone(controller.workspace.project.recipe);
    recipe.modules.find(module=>module.module_id===composition.module_id).reference_settings=settings;
    await execute({type:'recipe:save',recipe});
  };
  for(const method of ['none','blur','depth','segment']){
    await updateComposition({max_edge:512,preprocess:method,blur_strength:'medium'});
    const start=performance.now();
    const preview=await execute({type:'reference:preview',request_id:`preview_${method}`,project_id:project.project_id,asset_id:assetId,reference_type:'composition',module_id:composition.module_id});
    const bytes=Buffer.from(preview.reference_preview.split(',')[1],'base64');
    const info=await sharp(bytes).metadata(),originalInfo=await sharp(original).metadata();assert.equal(Math.max(info.width,info.height),Math.min(512,Math.max(originalInfo.width,originalInfo.height)));
    assert.ok(preview.reference_preview.startsWith(`data:image/${info.format};base64,`));
    await writeFile(path.join(base,`${method}.${info.format}`),bytes);
    const elapsed=performance.now()-start;
    await execute({type:'job:start',allow_degradation:false});
    const task=controller.workspace.project.jobs.at(-1),deadline=Date.now()+30_000;
    while(!['succeeded','failed','cancelled'].includes(task.status)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(task.status,'succeeded',task.error);
    const captured=await controller.workspace.repository.loadModelInput(task.task_id);
    assert.equal(captured.body.encoding,'simulation');
    const sent=captured.body.blocks.filter(block=>block.inlineData).map(block=>Buffer.from(block.inlineData.data,'base64'));
    assert.equal(sent.length,2);assert.deepEqual(sent[0],original);assert.deepEqual(sent[1],bytes);
    const model={...controller.workspace.models.resolve(recipe.model_config_id),purpose:'understanding'};
    const clear=await readReferenceImage({job:task,model,readImage:async()=>original,resolveCredential:async()=>'',preprocessReferenceImage:async()=>{throw Error('Understanding must not preprocess');}},assetId,1);
    assert.deepEqual(clear,await resizeReferenceImage(original,512));
    reports.push({method,ms:Math.round(elapsed),width:info.width,height:info.height,previewEqualsSent:true,understandingClear:true,subjectUnchanged:true});
  }
  // An uncached ONNX request is cancellable, and the next request still works.
  assert.deepEqual(controller.workspace.moduleSettings,defaultModuleSettings,'module overrides must not change defaults');
  await updateComposition({max_edge:1024,preprocess:'segment',blur_strength:'medium'});
  const pending=controller.execute({type:'reference:preview',request_id:'preview_cancel',project_id:project.project_id,asset_id:assetId,reference_type:'composition'});
  await new Promise(resolve=>setTimeout(resolve,750));
  await execute({type:'reference:cancel-preview',request_id:'preview_cancel'});
  assert.equal((await pending).ok,false);
  const retry=await execute({type:'reference:preview',request_id:'preview_retry',project_id:project.project_id,asset_id:assetId,reference_type:'composition'});
  assert.ok(retry.reference_preview);
  for(const format of ['jpeg','webp']){
    const small=await sharp({create:{width:31,height:19,channels:3,background:'#718a66'}}).toFormat(format).toBuffer();
    const fixture=path.join(base,`small-reference.${format}`);await writeFile(fixture,small);
    await execute({type:'assets:drop',paths:[fixture],module_id:composition.module_id});
    const smallId=controller.workspace.project.recipe.modules.find(module=>module.module_id===composition.module_id).asset_ids.at(-1);
    const response=await execute({...previewCommand('preview_small_'+format,clearSettings),asset_id:smallId});
    assert.ok(response.reference_preview.startsWith(`data:image/${format};base64,`),'unchanged small references retain their real MIME type');
    assert.deepEqual(Buffer.from(response.reference_preview.split(',')[1],'base64'),small);
  }
  let releaseSwitchReads;
  const switchGate=controller.workspace.serial(()=>new Promise(resolve=>{releaseSwitchReads=resolve;}));
  while(!releaseSwitchReads)await new Promise(resolve=>setTimeout(resolve,0));
  const switchingPreviews=[controller.execute(previewCommand('preview_switch_a')),controller.execute(previewCommand('preview_switch_b',clearSettings))];
  const switched=execute({type:'project:create',name:'预览取消验证'});
  releaseSwitchReads();await switchGate;
  assert.ok((await Promise.all(switchingPreviews)).every(response=>!response.ok),'switching workspaces cancels all outstanding previews');
  await switched;
  await controller.shutdown();controller=undefined;
  // Simulate a slow resource stream without network. Normal app shutdown must
  // await aborted download cleanup instead of leaving a large random .tmp.
  let streaming=false;
  globalThis.fetch=async(_url,{signal})=>new Response(new ReadableStream({start(stream){
    signal.addEventListener('abort',()=>setTimeout(()=>stream.error(Error('aborted test stream')),40),{once:true});
    stream.enqueue(new Uint8Array(32));streaming=true;
  }}));
  const downloadRuntime=path.join(base,'download-runtime');
  controller=await DesktopController.create(downloadRuntime,()=>window,{deferStartup:true,projectRoot:path.join(base,'download-project'),showMessage:async()=>{throw Error('Unexpected dialog');}});
  const pendingDownload=controller.execute({type:'reference-model:prepare',kind:'depth'});
  const streamDeadline=Date.now()+5000;
  while(!streaming&&Date.now()<streamDeadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(streaming,true);await new Promise(resolve=>setTimeout(resolve,30));
  await controller.shutdown();controller=undefined;
  assert.equal((await pendingDownload).ok,false);
  assert.equal((await readdir(path.join(modelDirectory(downloadRuntime),'depth'))).filter(name=>name.endsWith('.tmp')).length,0);
  assert.equal(providerCalls,0);
  await writeFile(path.join(base,'report.json'),JSON.stringify({source:path.resolve(source),runtime:'Electron / ONNX Runtime CPU',providerCalls,checks:reports,draftPreviewIsReadOnly:true,moduleBindingValidated:true,defaultsUnchanged:true,parallelPreviews:true,independentCancellation:true,duplicateIdPreservesOriginal:true,smallReferenceMime:true,workspaceSwitchCancelsAll:true,cancelAndRetry:true,shutdownCleansDownload:true},null,2));
  console.log(JSON.stringify({directory:base,reports,providerCalls,parallelPreviews:true,independentCancellation:true,duplicateIdPreservesOriginal:true,smallReferenceMime:true,workspaceSwitchCancelsAll:true,cancelAndRetry:true,shutdownCleansDownload:true}));
  app.exit(0);
}).catch(async error=>{
  console.error(error);
  if(base)await writeFile(path.join(base,'failure.txt'),error.stack??String(error));
  if(controller)await controller.shutdown().catch(()=>{});
  app.exit(1);
});
