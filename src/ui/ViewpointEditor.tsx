import { useEffect, useRef, useState } from 'react';
import { describeViewpoint } from './viewpoint-labels.js';
export type ViewAngles = import('../shared/viewpoint.js').ViewpointState;
const clamp = (value: number, max: number) => Math.max(-max,Math.min(max,Number.isFinite(value)?value:0));

// Deterministic code-native reference image, not AI-generated imagery.
// Tool state + rendered PNG are saved together on explicit user confirmation.
export function ViewpointEditor({initial,onSnapshot}: {initial:ViewAngles;onSnapshot:(png:string,state:ViewAngles)=>void}) {
  const [angles,setAngles]=useState<ViewAngles>({yaw:clamp(initial.yaw,180),pitch:clamp(initial.pitch,90),roll:clamp(initial.roll,180),projection:initial.projection==='perspective'?'perspective':'orthographic'});
  const canvas=useRef<HTMLCanvasElement>(null), drag=useRef<{x:number;y:number;angles:ViewAngles}|null>(null);
  const callback=useRef(onSnapshot);callback.current=onSnapshot;
  useEffect(()=>{
    const target=canvas.current!,ctx=target.getContext('2d')!;
    ctx.fillStyle='#f6f5ef';ctx.fillRect(0,0,600,600);
    const {yaw,pitch,roll}=angles,ry=yaw*Math.PI/180,rx=pitch*Math.PI/180,rz=roll*Math.PI/180;
    const rotate=(p:number[])=>{
      let [x,y,z]=p;[x,z]=[x*Math.cos(ry)+z*Math.sin(ry),-x*Math.sin(ry)+z*Math.cos(ry)];
      [y,z]=[y*Math.cos(rx)-z*Math.sin(rx),y*Math.sin(rx)+z*Math.cos(rx)];
      return [x*Math.cos(rz)-y*Math.sin(rz),x*Math.sin(rz)+y*Math.cos(rz),z];
    };
    // Camera looks toward -Z. A fixed distance gives gentle perspective and
    // keeps the finite ground plane safely in front of the near plane.
    const distance=8;
    const project=(p:number[]):[number,number]=>{
      const scale=angles.projection==='perspective'?distance/(distance-p[2]):1;
      return [300+p[0]*105*scale,290+p[1]*105*scale];
    };
    ctx.save();ctx.beginPath();ctx.rect(20,82,560,450);ctx.clip();
    // Ground touches the cube at Y=1 (canvas Y points down). Segment alpha
    // fades in world space, so the grid follows yaw, pitch and roll together.
    ctx.lineWidth=1.25;
    for(let i=-4;i<=4;i++)for(let step=-16;step<16;step++){
      const a=step/4,b=(step+1)/4;
      const alpha=.68*Math.pow(Math.max(0,1-Math.hypot(i,(a+b)/2)/5),1.1);
      ctx.strokeStyle=`rgba(113,137,102,${alpha})`;
      for(const endpoints of [[[i,1,a],[i,1,b]],[[a,1,i],[b,1,i]]]){
        const start=project(rotate(endpoints[0])),end=project(rotate(endpoints[1]));
        ctx.beginPath();ctx.moveTo(...start);ctx.lineTo(...end);ctx.stroke();
      }
    }
    const vertices=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(rotate);
    const faces=[{ids:[0,1,2,3],color:'#cbd6c2',label:'背面'},{ids:[4,7,6,5],color:'#8aa581',label:'正面'}, {ids:[0,4,5,1],color:'#e3e9dc',label:'顶部'}, {ids:[3,2,6,7],color:'#bbcbb0',label:'底部'}, {ids:[1,5,6,2],color:'#a8be9e',label:'右侧'}, {ids:[0,3,7,4],color:'#b4c6aa',label:'左侧'}];
    faces.sort((a,b)=>a.ids.reduce((s,i)=>s+vertices[i][2],0)-b.ids.reduce((s,i)=>s+vertices[i][2],0));
    for(const face of faces){
      const normal=face.ids.reduce((sum,i)=>sum.map((v,k)=>v+vertices[i][k]/4),[0,0,0]);
      const facing=angles.projection==='perspective'?normal[2]*distance-normal.reduce((sum,v)=>sum+v*v,0):normal[2];
      if(facing<=1e-6)continue;
      const points=face.ids.map(i=>project(vertices[i]));ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);points.slice(1).forEach(p=>ctx.lineTo(p[0],p[1]));ctx.closePath();ctx.fillStyle=face.color;ctx.fill();ctx.strokeStyle='#63805c';ctx.lineWidth=2;ctx.stroke();
      // Avoid labels overlapping when a face becomes a thin sliver.
      const area=Math.abs(points.reduce((sum,p,i)=>{const next=points[(i+1)%4];return sum+p[0]*next[1]-next[0]*p[1];},0))/2;
      if(area>2800){const center=project(normal);ctx.font='18px Microsoft YaHei, sans-serif';ctx.textAlign='center';ctx.fillStyle='#3d5838';ctx.fillText(face.label,...center);}
    }
    ctx.restore();
    const view=describeViewpoint(angles);
    ctx.fillStyle='#536e49';ctx.font='20px Microsoft YaHei, sans-serif';ctx.textAlign='left';ctx.fillText(view.direction,32,40,536);
    ctx.font='17px Microsoft YaHei, sans-serif';ctx.fillText([view.elevation,view.tilt].filter(Boolean).join(' · '),32,66,536);
    ctx.fillStyle='#647b59';ctx.font='18px Microsoft YaHei, sans-serif';ctx.fillText(view.projection,32,566,536);
    callback.current(target.toDataURL('image/png').split(',')[1],angles);
  },[angles]);
  return <div className="viewpoint-tool"><div className="viewpoint-projection" role="group" aria-label="投影方式">{(['orthographic','perspective'] as const).map(mode=><button key={mode} aria-pressed={angles.projection===mode} onClick={()=>setAngles({...angles,projection:mode})}>{mode==='orthographic'?'正交':'透视'}</button>)}</div><canvas ref={canvas} width={600} height={600} aria-label="视角参考立方体" tabIndex={0}
    onPointerDown={event=>{drag.current={x:event.clientX,y:event.clientY,angles};event.currentTarget.setPointerCapture(event.pointerId);}}
    onPointerMove={event=>{const start=drag.current;if(start)setAngles({...angles,yaw:clamp(start.angles.yaw+(event.clientX-start.x)*.6,180),pitch:clamp(start.angles.pitch-(event.clientY-start.y)*.6,90)});}}
    onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}/>
    <small>拖动立方体转动；保存时将当前角度渲染为参考图。</small>
    <small className="viewpoint-description" aria-live="polite">{describeViewpoint(angles).summaryZh}</small>
    {(['yaw','pitch','roll'] as const).map((key,index)=><label key={key}>{['水平','俯仰','倾斜'][index]} <span>{angles[key].toFixed(0)}°</span><input type="range" aria-label={`视角${['水平','俯仰','倾斜'][index]}`} min={key==='pitch'?-90:-180} max={key==='pitch'?90:180} value={angles[key]} onChange={event=>setAngles({...angles,[key]:Number(event.target.value)})}/></label>)}
    <button onClick={()=>setAngles({...angles,yaw:0,pitch:0,roll:0})}>正面视角</button>
  </div>;
}
