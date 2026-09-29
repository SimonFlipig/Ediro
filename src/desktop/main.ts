import { app, BrowserWindow, ipcMain, protocol, net, dialog } from 'electron';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DesktopController } from './controller.js';
import { registerWindowChrome } from './window-chrome.js';
import { AppDialogs } from './app-dialogs.js';
import { storagePaths } from './storage-paths.js';
import { registerUpdates } from './updates.js';
import { UpdateRestart } from './update-restart.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'ediro-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const root = app.getAppPath();
app.setName('Ediro');
const storage = storagePaths({packaged:app.isPackaged,appDirectory:root,executable:app.getPath('exe'),userData:path.join(app.getPath('appData'),'Ediro'),documents:app.getPath('documents'),portable:existsSync(path.join(path.dirname(app.getPath('exe')),'ediro-portable.json'))});
const runtimeDirectory = storage.runtimeDirectory;
try {
  await mkdir(path.join(runtimeDirectory, 'electron'), { recursive: true });
  await mkdir(path.join(runtimeDirectory, 'crash-dumps'), { recursive: true });
  await mkdir(storage.projectRoot, { recursive: true });
} catch (error) {
  dialog.showErrorBox('Ediro 无法创建数据目录', `请确认数据目录可写。便携版请先完整解压到可写文件夹。\n${runtimeDirectory}\n${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
}
app.setPath('userData', path.join(runtimeDirectory, 'electron'));
app.setPath('crashDumps', path.join(runtimeDirectory, 'crash-dumps'));

let window: BrowserWindow | null = null;
let controller: DesktopController | undefined;
let closing = false;
let closeReady=false,closeRequested=false,rendererReady=false;
const devUrl = app.isPackaged ? undefined : process.env.EDIRO_DEV_URL;
if (devUrl && devUrl !== 'http://127.0.0.1:5190') throw new Error('不允许加载任意远端界面。');

// Ask the renderer to submit focused text and paint drafts before flushing disk.
app.on('before-quit', event => {
  if (closing) return;
  if(window&&!window.isDestroyed()){event.preventDefault();window.close();}
});
app.on('window-all-closed', () => app.quit());

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
  void app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1540, height: 1040, minWidth: 1120, minHeight: 800, backgroundColor: '#f6f5f1', title: 'Ediro · 视觉工作台',
    ...(process.platform==='win32'?{titleBarStyle:'hidden' as const,titleBarOverlay:{color:'#fffefb',symbolColor:'#465a4c',height:55}}:{}),
    webPreferences: { preload: path.join(root, 'dist-host', 'desktop', 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.setMenuBarVisibility(false);
  registerWindowChrome(ipcMain,()=>window);
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Ediro</title><style>body{margin:0;background:#f6f5f1;color:#465a4c;font:15px system-ui;display:grid;place-items:center;height:100vh}main{text-align:center}p{font-size:12px;color:#899780;margin-top:16px}</style><main>正在打开工作台…<p>正在读取工程与本地设置。</p></main></html>'));
  let startupShown=false;
  const dialogs=new AppDialogs(ipcMain,window,()=>{if(startupShown)return;startupShown=true;void controller!.workspace.serial(()=>controller!.showStartupNotices()).catch(error=>dialogs.show({message:'工程恢复未完成',detail:error instanceof Error?error.message:'请重试打开工程。'}));});
  controller = await DesktopController.create(runtimeDirectory, () => window!,{showMessage:dialogs.show,deferStartup:true,projectRoot:storage.projectRoot});
  let activeCommands=0;
  const updateRestart=new UpdateRestart(
    ()=>{if(activeCommands>0)throw new Error('请等待当前操作完成后再重启升级。');controller!.assertReadyForUpdate();},
    ()=>{if(closeRequested||!rendererReady)throw new Error('工作台尚未就绪，请稍后重试。');window!.close();},
    ()=>controller!.workspace.serial(()=>controller!.workspace.flush()),
    ()=>{closeRequested=false;updates.service.installNow();},
  );
  const updates=registerUpdates(window,storage.mode,()=>updateRestart.request(),()=>{updateRestart.cancel();closeRequested=false;});
  const finishClose=async()=>{
    try{
      if(await updateRestart.afterEditorsSaved())return;
      await controller!.shutdown();closeReady=true;closing=true;window!.close();app.quit();
    }
    catch(error){
      if(updates.service.snapshot().status==='installing'){updateRestart.cancel();updates.service.cancelInstall();}
      closeRequested=false;
      const message={type:'error' as const,message:'工程未能保存，已取消关闭。',detail:(error instanceof Error?error.message:'请重试保存或另存为。')+'\n请保留当前窗口，重试保存或另存为新的工程文件。'};
      if(rendererReady)await dialogs.show(message);else await dialog.showMessageBox(window!,message);
    }
  };
  ipcMain.on('ediro:close-listener-ready',event=>{if(event.sender===window?.webContents&&event.senderFrame===window.webContents.mainFrame)rendererReady=true;});
  window.webContents.on('render-process-gone',()=>{rendererReady=false;});
  window.on('close',event=>{
    if(closeReady)return;
    event.preventDefault();
    if(closeRequested)return;closeRequested=true;
    if(rendererReady&&!updateRestart.launched)window!.webContents.send('ediro:before-close');else void finishClose();
  });
  ipcMain.on('ediro:close-ready',(event,ok:unknown)=>{
    if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame||!closeRequested)return;
    if(ok!==true){closeRequested=false;if(updateRestart.requested){updateRestart.cancel();updates.service.cancelInstall();}return;}
    void finishClose();
  });
  window.on('focus',()=>{void controller?.refreshState().catch(()=>{ /* Window may close while refreshing. */ });});
  // Optional user-supplied project file for desktop launch / integration tests.
  const projectArgument = process.argv.find(argument => argument.startsWith('--project='));
  if (projectArgument) {
    const projectFile = path.resolve(projectArgument.slice('--project='.length));
    await controller.openProjectFile(projectFile);
  }
  protocol.handle('ediro-asset', async request => {
    try { return await net.fetch(pathToFileURL(await controller!.assetPath(request.url)).toString()); }
    catch { return new Response('Asset unavailable', { status: 404 }); }
  });
  ipcMain.handle('ediro:command', async (event, command: unknown) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: '调用来源未授权。' };
    if(updateRestart.launched)return {ok:false,error:'正在重启升级，请稍候。'};
    if(updateRestart.requested&&['job:start','job:retry','mask:start','module:infer','model:test'].includes((command as {type?:string}|null)?.type??''))return {ok:false,error:'正在准备升级，暂时不能启动新任务。'};
    activeCommands++;
    try{return await controller!.execute(command);}finally{activeCommands--;}
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (devUrl) await window.loadURL(devUrl); else await window.loadFile(path.join(root, 'dist', 'index.html'));
  updates.start();
  }).catch(error => {
    dialog.showErrorBox('Ediro 启动失败', error instanceof Error ? error.message : '无法启动工作台。');
    closeReady=true;closing=true;
    app.quit();
  });
}
