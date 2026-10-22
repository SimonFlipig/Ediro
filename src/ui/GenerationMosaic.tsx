import {useEffect,useRef} from 'react';

// A tiny canvas provides exactly 6 x 6 source pixels. The grid above it animates
// each tile without reading image pixels back across the asset protocol boundary.
export function GenerationMosaic({sourceUrl,seed,active}:{sourceUrl?:string;seed:string;active:boolean}){
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const context=canvas.current?.getContext('2d');if(!context)return;
    let value=Array.from(seed).reduce((hash,char)=>(Math.imul(hash,31)+char.charCodeAt(0))>>>0,0),current=true;
    for(let y=0;y<6;y++)for(let x=0;x<6;x++){
      value=(Math.imul(value,1664525)+1013904223)>>>0;
      context.fillStyle=`hsl(${85+value%35} 16% ${42+(value>>>8)%37}%)`;context.fillRect(x,y,1,1);
    }
    if(!sourceUrl)return;
    const image=new Image();
    image.onload=()=>{
      if(!current)return;
      context.fillStyle='#edeedf';context.fillRect(0,0,6,6);
      const scale=Math.min(6/image.naturalWidth,6/image.naturalHeight),width=image.naturalWidth*scale,height=image.naturalHeight*scale;
      context.drawImage(image,(6-width)/2,(6-height)/2,width,height);
    };
    image.src=sourceUrl;
    return()=>{current=false;image.onload=null;image.src='';};
  },[sourceUrl,seed]);
  return <div className={`generation-mosaic ${active?'is-animating':''}`} aria-hidden="true">
    <canvas ref={canvas} className="generation-mosaic-source" width={6} height={6}/>
    <div className="generation-mosaic-grid">{Array.from({length:36},(_,index)=><i className="generation-mosaic-cell" key={index} style={{animationDelay:`-${((index%6)*0.13+Math.floor(index/6)*0.19).toFixed(2)}s`}}/>)}</div>
  </div>;
}
