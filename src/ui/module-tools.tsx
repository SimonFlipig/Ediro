import type { ComponentType } from 'react';
import { ViewpointEditor } from './ViewpointEditor.js';

export interface ReferenceToolProps {state:Record<string,unknown>;onSnapshot:(png:string,state:Record<string,unknown>)=>void}
// UI-only registration: tools produce an image and their own state. Neither the
// compiler nor a model adapter needs to know how a reference was made.
export class ReferenceToolRegistry {
  private tools=new Map<string,ComponentType<ReferenceToolProps>>();
  register(type:string,component:ComponentType<ReferenceToolProps>){if(this.tools.has(type))throw new Error('参考工具重复注册。');this.tools.set(type,component);return this;}
  get(type:string){return this.tools.get(type);}
}
export const referenceTools=new ReferenceToolRegistry().register('viewpoint',({state,onSnapshot})=><ViewpointEditor initial={{yaw:Number(state.yaw??30),pitch:Number(state.pitch??-20),roll:Number(state.roll??0),projection:state.projection==='perspective'?'perspective':'orthographic'}} onSnapshot={(png,angles)=>onSnapshot(png,{...angles})}/>);
