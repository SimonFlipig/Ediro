import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, MessageBoxOptions } from 'electron';
import type { DialogRequest } from '../shared/api.js';

// Replies bypass the command queue: a command may be waiting for this choice.
export class AppDialogs {
  private ready=false;
  private pending=new Map<string,{request:DialogRequest;resolve:(value:{response:number})=>void}>();
  constructor(ipc:IpcMain,private window:BrowserWindow,onReady:()=>void){
    const trusted=(event:Electron.IpcMainEvent)=>!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame;
    ipc.on('ediro:dialog-ready',event=>{if(!trusted(event))return;const first=!this.ready;this.ready=true;for(const item of this.pending.values())window.webContents.send('ediro:dialog',item.request);if(first)onReady();});
    ipc.on('ediro:dialog-response',(event,id:unknown,response:unknown)=>{
      if(!trusted(event)||typeof id!=='string'||typeof response!=='number'||!Number.isInteger(response))return;
      const item=this.pending.get(id);if(!item||response<0||response>=item.request.buttons.length)return;
      this.pending.delete(id);item.resolve({response});
    });
    const cancel=()=>{this.ready=false;for(const item of this.pending.values())item.resolve({response:item.request.cancelId});this.pending.clear();};
    window.webContents.on('render-process-gone',cancel);window.on('closed',cancel);
  }
  show=async(options:MessageBoxOptions):Promise<{response:number}>=>{
    const request:DialogRequest={id:randomUUID(),message:options.message,detail:options.detail,buttons:options.buttons??['知道了'],cancelId:options.cancelId??0,defaultId:options.defaultId??0};
    if(this.window.isDestroyed())return {response:request.cancelId};
    return new Promise(resolve=>{this.pending.set(request.id,{request,resolve});if(this.ready)this.window.webContents.send('ediro:dialog',request);});
  };
}
