import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, WorkspaceView } from '../shared/api.js';

const api: DesktopApi = {
  updates: {
    command: action => ipcRenderer.invoke('ediro:update', action),
    subscribe: listener => {const callback = (_event: unknown, state: import('../shared/updates.js').UpdateState) => listener(state);ipcRenderer.on('ediro:update-state', callback);return () => ipcRenderer.removeListener('ediro:update-state', callback);},
  },
  onDialog:listener=>{const callback=(_event:unknown,request:import('../shared/api.js').DialogRequest)=>listener(request);ipcRenderer.on('ediro:dialog',callback);ipcRenderer.send('ediro:dialog-ready');return()=>ipcRenderer.removeListener('ediro:dialog',callback);},
  respondDialog:(id,response)=>ipcRenderer.send('ediro:dialog-response',id,response),
  windowControlsOverlay: process.platform==='win32',
  getFilePaths: files => files.map(file => webUtils.getPathForFile(file)).filter(Boolean),
  beforeClose:listener=>{
    const callback=()=>{void listener().then(ok=>ipcRenderer.send('ediro:close-ready',ok),()=>ipcRenderer.send('ediro:close-ready',false));};
    ipcRenderer.on('ediro:before-close',callback);ipcRenderer.send('ediro:close-listener-ready');return()=>ipcRenderer.removeListener('ediro:before-close',callback);
  },
  execute: command => ipcRenderer.invoke('ediro:command', command),
  subscribe: listener => {
    const callback = (_event: unknown, state: WorkspaceView) => listener(state);
    ipcRenderer.on('ediro:state', callback);
    return () => ipcRenderer.removeListener('ediro:state', callback);
  },
};
contextBridge.exposeInMainWorld('ediro', api);

// Keep native controls aligned after page zoom, resize, or moving between displays.
if(process.platform==='win32')window.addEventListener('DOMContentLoaded',()=>{
  let bar:HTMLElement|null=null,frame=0;
  const report=()=>{
    cancelAnimationFrame(frame);
    frame=requestAnimationFrame(()=>{if(bar?.isConnected)ipcRenderer.send('ediro:titlebar-size',bar.getBoundingClientRect().height);});
  };
  const resize=new ResizeObserver(report);
  const findBar=()=>{
    const next=document.querySelector<HTMLElement>('.desktop-shell>.topbar');
    if(next===bar)return;
    resize.disconnect();bar=next;
    if(bar){resize.observe(bar);report();}
  };
  const mutations=new MutationObserver(findBar);
  mutations.observe(document.documentElement,{childList:true,subtree:true});findBar();
  window.addEventListener('resize',report);
  window.addEventListener('beforeunload',()=>{mutations.disconnect();resize.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',report);},{once:true});
});
