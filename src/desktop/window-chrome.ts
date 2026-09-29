import type { BrowserWindow,IpcMain } from 'electron';

/** Renderer height is in CSS pixels; native overlay height is in window DIPs. */
export function registerWindowChrome(ipc:IpcMain,getWindow:()=>BrowserWindow|null) {
  let lastHeight:number|undefined;
  ipc.on('ediro:titlebar-size',(event,cssHeight:unknown)=>{
    const window=getWindow();
    if(process.platform!=='win32'||!window||window.isDestroyed()||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)return;
    if(typeof cssHeight!=='number'||!Number.isFinite(cssHeight)||cssHeight<32||cssHeight>100)return;
    const height=Math.max(1,Math.round((cssHeight-1)*window.webContents.getZoomFactor()));
    if(height===lastHeight)return;
    window.setTitleBarOverlay({height});lastHeight=height;
  });
}
