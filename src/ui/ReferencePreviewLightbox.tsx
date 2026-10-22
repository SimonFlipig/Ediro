import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ImagePreview} from './ImagePreview.js';
import {fittedViewport,zoomViewport} from './image-viewport.js';

export function ReferencePreviewLightbox({url,onClose}:{url:string;onClose:()=>void}){
  const [view,setView]=useState(fittedViewport);
  const panel=useRef<HTMLElement>(null),closeButton=useRef<HTMLButtonElement>(null),closing=useRef(onClose);closing.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const editor=previous?.closest<HTMLElement>('.module-editor')??document.querySelector<HTMLElement>('.module-editor'),wasInert=editor?.inert??false;
    if(editor)editor.inert=true;
    closeButton.current?.focus();
    const keyboard=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closing.current();}
      if(event.key==='Tab'){
        event.preventDefault();event.stopImmediatePropagation();
        const buttons=[...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();
      }
    };
    document.addEventListener('keydown',keyboard,true);
    return()=>{document.removeEventListener('keydown',keyboard,true);if(editor)editor.inert=wasInert;if(previous?.isConnected)previous.focus();};
  },[]);
  return createPortal(<div className="reference-preview-lightbox-backdrop"><section ref={panel} className="reference-preview-lightbox" role="dialog" aria-modal="true" aria-label="生图参考大图">
    <div className="reference-preview-lightbox-toolbar"><div><b>生图参考大图</b><small>滚轮缩放 · 按住图片拖动</small></div><div className="reference-preview-lightbox-actions"><button aria-label="缩小参考大图" disabled={view.zoom<=25} onClick={()=>setView(value=>zoomViewport(value,value.zoom-25))}>−</button><span>{Math.round(view.zoom)}%</span><button aria-label="放大参考大图" disabled={view.zoom>=300} onClick={()=>setView(value=>zoomViewport(value,value.zoom+25))}>＋</button><button onClick={()=>setView(fittedViewport())}>适应</button><button ref={closeButton} aria-label="关闭参考大图" onClick={onClose}>关闭</button></div></div>
    <div className="reference-preview-lightbox-stage"><ImagePreview asset={{name:'处理后的生图参考图',original_url:url,width:1,height:1}} view={view} onChange={setView}/></div>
  </section></div>,document.body);
}
