import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './app-dialog.css';

export interface DialogAction { label:string; primary?:boolean; run:()=>void|Promise<unknown> }
export function AppDialog({title,children,actions,onDismiss}:{title:string;children:ReactNode;actions:DialogAction[];onDismiss:()=>void}) {
  const titleId=useId(),bodyId=useId(),panel=useRef<HTMLElement>(null),running=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const dismiss=useRef(onDismiss);dismiss.current=onDismiss;
  useEffect(()=>{
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const buttons=[...panel.current!.querySelectorAll<HTMLButtonElement>('button')];
    (buttons.find(button=>button.textContent==='知道了')??buttons[0])?.focus();
    const key=(event:KeyboardEvent)=>{
      const dialogs=document.querySelectorAll('.app-dialog');if(dialogs[dialogs.length-1]!==panel.current)return;
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(!running.current)dismiss.current();}
      if(event.key==='Tab'){
        const buttons=[...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();
      }
    };
    document.addEventListener('keydown',key,true);
    return ()=>{document.removeEventListener('keydown',key,true);if(previous?.isConnected)previous.focus();};
  },[]);
  const act=async(action:DialogAction)=>{if(running.current)return;running.current=true;setBusy(true);setError('');try{await action.run();}catch(e){setError(e instanceof Error?e.message:'操作未完成，请重试。');}finally{running.current=false;setBusy(false);}};
  return createPortal(<div className="app-dialog-backdrop"><section className="app-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} aria-busy={busy}>
    <span className="eyebrow">EDIRO</span><h2 id={titleId}>{title}</h2><div id={bodyId} className="app-dialog-body">{children}</div>
    {error&&<p className="app-dialog-error" role="alert">{error}</p>}
    <div className="app-dialog-actions">{actions.map((action,index)=><button key={index} className={action.primary?'primary':''} disabled={busy} onClick={()=>void act(action)}>{action.label}</button>)}</div>
  </section></div>,document.body);
}
