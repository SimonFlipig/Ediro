import { app, BrowserWindow, ipcMain, protocol, net, safeStorage } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { DesktopController } from './controller.js';
import { releasePromptConfig } from '../core/release-prompt-config.js';
import { loadPromptConfig } from '../adapters/prompt-config-repository.js';
import type { Command } from '../shared/api.js';
import { registerUpdates } from './updates.js';

export async function runReleaseSmoke(outputRoot: string) {
  await mkdir(path.resolve(outputRoot), { recursive: true });
  const directory=await mkdtemp(path.join(path.resolve(outputRoot),'smoke-'));
  app.setPath('userData',path.join(directory,'electron'));
  protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
  app.on('window-all-closed',()=>{});
  const timeout=setTimeout(()=>{void writeFile(path.join(directory,'error.txt'),'Release smoke timed out').finally(()=>app.exit(1));},90000);
  let controller:DesktopController|undefined,window:BrowserWindow|undefined;
  // Finish the ESM entry's pre-ready setup before awaiting Electron readiness.
  void (async()=>{
  try {
    await app.whenReady();
    const root=app.getAppPath(),runtime=path.join(directory,'settings','runtime'),projectRoot=path.join(directory,'文档 空格','Ediro');
    const jsErrors:string[]=[];
    window=new BrowserWindow({width:1400,height:920,show:false,webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    window.webContents.on('preload-error',(_e,_file,error)=>jsErrors.push(error.message));
    // Any accidental provider call fails this local smoke test before sending.
    globalThis.fetch=async()=>{throw new Error('Network calls are forbidden in release smoke checks.');};
    controller=await DesktopController.create(runtime,()=>window!,{projectRoot,deferStartup:true,showMessage:async()=>({response:0})});
    // Exercise the real update bridge with networking disabled in this self-check.
    registerUpdates(window,'development',()=>{throw new Error('Self-check must not install updates.');},()=>{});
    ipcMain.handle('ediro:command',(_e,command)=>controller!.execute(command));
    protocol.handle('ediro-asset',async request=>{try{return net.fetch(pathToFileURL(await controller!.assetPath(request.url)).href);}catch{return new Response('Missing',{status:404});}});
    const execute=async(command:Command)=>{const response=await controller!.execute(command);assert.ok(response.ok,response.error);return response;};
    const initial=await controller.view();assert.equal(initial.project_format,'draft');assert.equal(initial.recent_workspaces?.length,0);
    assert.deepEqual(await loadPromptConfig(runtime),releasePromptConfig);
    const source=path.join(directory,'测试商品.png');
    await writeFile(source,await sharp({create:{width:96,height:96,channels:3,background:'#91ad83'}}).png().toBuffer());
    assert.ok(initial.project);
    await execute({type:'assets:drop',paths:[source],module_id:initial.project.recipe.modules[0].module_id});
    const before=await controller.view();assert.equal(before.project_format,'ediro');
    const filename=before.project_location!;
    assert.equal(path.dirname(filename),path.join(projectRoot,'Project'));
    await execute({type:'recipe:select-model',model_config_id:'model_mock_native'});
    const recipe=structuredClone(controller.workspace.project!.recipe);
    recipe.modules.find(module=>module.reference_type==='prompt')!.user_instruction='Create a simple product test image.';
    await execute({type:'recipe:save',recipe});
    await execute({type:'job:start',allow_degradation:true});
    for(let i=0;i<400&&controller.workspace.project!.jobs.some(job=>!['succeeded','failed','cancelled'].includes(job.status));i++)await new Promise(resolve=>setTimeout(resolve,50));
    const job=controller.workspace.project!.jobs[0];assert.equal(job.status,'succeeded');
    assert.ok((await execute({type:'job:model-input',task_id:job.task_id})).model_input);
    await window.loadFile(path.join(root,'dist/index.html'));
    for(let i=0;i<100;i++){
      if(await window.webContents.executeJavaScript("Boolean(document.querySelector('.desktop-shell'))"))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(await window.webContents.executeJavaScript("Boolean(document.querySelector('.desktop-shell'))"));
    assert.ok(await window.webContents.executeJavaScript("Boolean(window.ediro)"));
    const imagesReady="(()=>{const images=[...document.querySelectorAll('img')];return images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0);})()";
    for(let i=0;i<100;i++){
      if(await window.webContents.executeJavaScript(imagesReady))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(await window.webContents.executeJavaScript(imagesReady),'Asset images must load through the packaged protocol.');
    assert.deepEqual(jsErrors,[]);
    await writeFile(path.join(directory,'workspace.png'),(await window.webContents.capturePage()).toPNG());
    await controller.shutdown();
    const saved=await readFile(filename);assert.equal(saved.subarray(0,15).toString(),'SQLite format 3');
    controller=await DesktopController.create(runtime,()=>window!,{projectRoot,deferStartup:true,showMessage:async()=>({response:0})});
    await controller.openProjectFile(filename);
    const reopened=await controller.view();assert.ok(reopened.project);assert.equal(reopened.project.jobs[0].status,'succeeded');assert.ok(reopened.project.assets.length>=2);
    assert.deepEqual(await loadPromptConfig(runtime),releasePromptConfig);
    let credentialRoundTrip=false;
    if(safeStorage.isEncryptionAvailable())credentialRoundTrip=safeStorage.decryptString(safeStorage.encryptString('release-smoke-dummy'))==='release-smoke-dummy';
    await controller.shutdown();controller=undefined;window.destroy();window=undefined;
    await writeFile(path.join(directory,'report.json'),JSON.stringify({ok:true,packaged:app.isPackaged,version:app.getVersion(),node:process.versions.node,electron:process.versions.electron,appRoot:root,projectFile:filename,sharp:sharp.versions.vips,promptDefaults:true,sqliteReopen:true,preload:true,rendered:true,mockGeneration:true,credentialRoundTrip},null,2));
    clearTimeout(timeout);app.exit(0);
  } catch(error) {
    await writeFile(path.join(directory,'error.txt'),error instanceof Error?error.stack??error.message:String(error));
    clearTimeout(timeout);app.exit(1);
  }
  })();
}
