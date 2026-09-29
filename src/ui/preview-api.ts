import type { ApiResponse, DesktopApi } from '../shared/api.js';

// Explicit development-only browser bridge to the fixed, mock-only test host.
// It cannot select arbitrary files, access saved credentials or call live models.
export function createPreviewApi(): DesktopApi {
  let token: Promise<string> | undefined;
  const getToken = () => token ??= fetch('/preview-session').then(r=>r.json()).then(r=>r.token as string);
  const execute: DesktopApi['execute'] = async command => {
    try {
      const response = await fetch('/preview-command', { method:'POST', headers:{'Content-Type':'application/json','X-Ediro-Preview':await getToken()}, body:JSON.stringify(command) });
      return await response.json() as ApiResponse;
    } catch { return {ok:false,error:'浏览器验证服务不可用，请从桌面启动 Ediro。'}; }
  };
  return { execute, getFilePaths:()=>[], subscribe:listener=>{
    let closed=false, lifecycle:EventSource|undefined;
    void getToken().then(value=>{if(!closed)lifecycle=new EventSource(`/preview-lifecycle?token=${encodeURIComponent(value)}`);});
    const release=()=>{closed=true;lifecycle?.close();};
    window.addEventListener('pagehide',release);
    const timer=setInterval(()=>void execute({type:'state'}).then(r=>{if(r.state)listener(r.state);}),600);
    return()=>{clearInterval(timer);window.removeEventListener('pagehide',release);release();};
  } };
}
