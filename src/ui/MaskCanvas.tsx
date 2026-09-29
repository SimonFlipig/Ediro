import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {MaskCrop,MaskDraft,MaskStroke} from '../core/mask.js';
import {maskSelectionSvg} from '../core/mask.js';
import type {ViewAsset} from '../shared/api.js';
import {fittedImageSize,fittedViewport,wheelZoom,zoomViewport} from './image-viewport.js';

export function MaskCanvas({asset,draft,tool,size,visible,disabled,onStroke,onLiveStroke,resultMode=false,crop,onCrop}:{asset:ViewAsset;draft:MaskDraft;tool:'paint'|'erase'|'pan'|'crop';size:number;visible:boolean;disabled:boolean;onStroke:(s:MaskStroke)=>void;onLiveStroke?:(s:MaskStroke|null)=>void;resultMode?:boolean;crop?:MaskCrop;onCrop?:(crop:MaskCrop)=>void}){
  const host=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null);
  const [bounds,setBounds]=useState({width:0,height:0}),[view,setView]=useState(fittedViewport),[space,setSpace]=useState(false),[live,setLive]=useState<MaskStroke|null>(null);
  const [cursor,setCursor]=useState<{x:number;y:number}|null>(null);
  const gesture=useRef<{id:number;x:number;y:number;stroke?:MaskStroke;cropStart?:[number,number];cropEnd?:[number,number]}|null>(null);
  const [liveCrop,setLiveCrop]=useState<MaskCrop|null>(null);
  const fitted=fittedImageSize(draft.width,draft.height,bounds.width,bounds.height),scale=fitted.width/draft.width*view.zoom/100;
  useLayoutEffect(()=>{const el=host.current!,observer=new ResizeObserver(()=>setBounds({width:el.clientWidth,height:el.clientHeight}));observer.observe(el);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{if((e.target as HTMLElement).closest('input,textarea,select,button'))return;if(e.code==='Space'){e.preventDefault();setSpace(true);}};
    const up=(e:KeyboardEvent)=>{if(e.code==='Space')setSpace(false);};const blur=()=>{setSpace(false);};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);};
  },[]);
  useEffect(()=>{const el=host.current!;const wheel=(e:WheelEvent)=>{if(gesture.current)return;e.preventDefault();const b=el.getBoundingClientRect();setView(v=>zoomViewport(v,wheelZoom(v.zoom,e.deltaY,e.deltaMode,el.clientHeight),{x:e.clientX-b.left-el.clientWidth/2,y:e.clientY-b.top-el.clientHeight/2}));};el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[]);
  const point=(x:number,y:number):[number,number]=>{const b=surface.current!.getBoundingClientRect();return [Math.max(0,Math.min(1,(x-b.left)/b.width)),Math.max(0,Math.min(1,(y-b.top)/b.height))];};
  const rect=(start:[number,number],end:[number,number]):MaskCrop=>{
    const x=Math.floor(Math.min(start[0],end[0])*draft.width),y=Math.floor(Math.min(start[1],end[1])*draft.height);
    return {x,y,width:Math.max(1,Math.ceil(Math.max(start[0],end[0])*draft.width)-x),height:Math.max(1,Math.ceil(Math.max(start[1],end[1])*draft.height)-y)};
  };
  const finish=()=>{const g=gesture.current;gesture.current=null;if(g?.stroke)onStroke(g.stroke);if(g?.cropStart&&g.cropEnd)onCrop?.(rect(g.cropStart,g.cropEnd));setLive(null);setLiveCrop(null);onLiveStroke?.(null);};
  const shownCrop=liveCrop??crop;
  const selection='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(maskSelectionSvg(draft.width,draft.height,[...draft.strokes,...(live?[live]:[])]));
  return <div className={`mask-viewport ${space||tool==='pan'?'mask-pan':''}`} ref={host} tabIndex={-1}>
    <div className="mask-canvas-controls"><span>{Math.round(view.zoom)}%</span><button onClick={()=>setView(fittedViewport())}>适应画布</button><span>滚轮缩放 · 空格拖动</span></div>
    <div ref={surface} className="mask-surface" style={{width:fitted.width,height:fitted.height,transform:`translate(-50%,-50%) translate(${view.x}px,${view.y}px) scale(${view.zoom/100})`,cursor:space||tool==='pan'?'grab':disabled?'default':tool==='crop'?'crosshair':'none'}}
      onPointerDown={e=>{
        if(gesture.current||![0,1].includes(e.button))return;
        if(disabled&&!(space||tool==='pan'||e.button===1))return;
        e.preventDefault();host.current?.focus({preventScroll:true});e.currentTarget.setPointerCapture(e.pointerId);
        const pan=space||tool==='pan'||e.button===1;
        const start=point(e.clientX,e.clientY);
        if(!pan&&resultMode&&crop&&(start[0]*draft.width<crop.x||start[0]*draft.width>crop.x+crop.width||start[1]*draft.height<crop.y||start[1]*draft.height>crop.y+crop.height))return;
        const drawingCrop=!pan&&tool==='crop';
        const stroke:MaskStroke|undefined=pan||drawingCrop?undefined:{tool:tool as 'paint'|'erase',size,points:[start]};
        gesture.current={id:e.pointerId,x:e.clientX,y:e.clientY,stroke,...(drawingCrop?{cropStart:start}:{})};setLive(stroke??null);onLiveStroke?.(stroke??null);
      }}
      onPointerMove={e=>{
        const b=host.current!.getBoundingClientRect();setCursor({x:e.clientX-b.left,y:e.clientY-b.top});
        const g=gesture.current;if(!g||g.id!==e.pointerId)return;
        if(!e.buttons){finish();return;}
        if(g.cropStart){g.cropEnd=point(e.clientX,e.clientY);setLiveCrop(rect(g.cropStart,g.cropEnd));}
        else if(g.stroke){const bounds=surface.current!.getBoundingClientRect();if(e.clientX<bounds.left||e.clientX>bounds.right||e.clientY<bounds.top||e.clientY>bounds.bottom){finish();return;}const p=point(e.clientX,e.clientY),last=g.stroke.points.at(-1)!;if(Math.hypot((p[0]-last[0])*draft.width,(p[1]-last[1])*draft.height)>=Math.max(.5,size/12)&&g.stroke.points.length<10000){g.stroke={...g.stroke,points:[...g.stroke.points,p]};setLive(g.stroke);onLiveStroke?.(g.stroke);}}
        else {const dx=e.clientX-g.x,dy=e.clientY-g.y;setView(v=>({...v,x:v.x+dx,y:v.y+dy}));}
        g.x=e.clientX;g.y=e.clientY;
      }}
      onPointerUp={e=>{if(gesture.current?.id!==e.pointerId)return;finish();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
      onLostPointerCapture={finish} onPointerCancel={finish} onPointerLeave={()=>setCursor(null)}>
      <img src={asset.original_url} alt={resultMode?'可补画的合成结果':'局部编辑底图'} draggable={false}/>
      {visible&&<svg className="mask-overlay" width="100%" height="100%" viewBox={`0 0 ${draft.width} ${draft.height}`}><defs><mask id="edit-selection" maskUnits="userSpaceOnUse" x="0" y="0" width={draft.width} height={draft.height}><image href={selection} width={draft.width} height={draft.height}/></mask><clipPath id="result-crop"><rect x={crop?.x??0} y={crop?.y??0} width={crop?.width??draft.width} height={crop?.height??draft.height}/></clipPath></defs><rect width={draft.width} height={draft.height} fill="#e97554" opacity="0.52" mask="url(#edit-selection)" clipPath={resultMode?'url(#result-crop)':undefined}/></svg>}
      {shownCrop&&<svg aria-label={resultMode?'本次模型返回范围':'送入模型的范围'} className="mask-overlay mask-crop-frame" width="100%" height="100%" viewBox={`0 0 ${draft.width} ${draft.height}`}><rect x={shownCrop.x} y={shownCrop.y} width={shownCrop.width} height={shownCrop.height} fill="none" stroke="#477c98" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeDasharray="7 4"/></svg>}
    </div>
    {cursor&&!disabled&&!space&&tool!=='pan'&&tool!=='crop'&&<div className={`mask-brush-cursor ${tool}`} style={{left:cursor.x,top:cursor.y,width:Math.max(3,size*scale),height:Math.max(3,size*scale)}}/>}
    {!draft.strokes.length&&!live&&<div className="mask-canvas-hint">{resultMode?'画笔涂出要采用的模型内容':'涂出需要修改的区域'}</div>}
  </div>;
}
