import {useEffect,useRef,useState} from 'react';
import type {MaskEdit,MaskStroke} from '../core/mask.js';
import type {Command} from '../shared/api.js';

export function useCompositeMask(projectId:string,taskId:string|undefined,edit:MaskEdit|undefined,dispatch:(command:Command)=>Promise<boolean>,initialStrokes?:MaskStroke[]){
  const initial=()=>({taskId,strokes:structuredClone(initialStrokes??edit?.composite_strokes??edit?.draft.strokes??[]),undo:[] as MaskStroke[][],redo:[] as MaskStroke[][],dirty:false,status:''});
  const [stored,setStored]=useState(initial);
  const value=stored.taskId===taskId?stored:initial();
  const current=useRef(value);current.current=value;
  useEffect(()=>{if(stored.taskId!==taskId)setStored(initial());},[taskId]);
  const change=(strokes:MaskStroke[])=>setStored(v=>({...v,strokes,undo:[...v.undo,v.strokes],redo:[],dirty:true,status:'合成蒙版未保存'}));
  const undo=()=>setStored(v=>v.undo.length?{...v,strokes:v.undo.at(-1)!,undo:v.undo.slice(0,-1),redo:[...v.redo,v.strokes],dirty:true,status:'合成蒙版未保存'}:v);
  const redo=()=>setStored(v=>v.redo.length?{...v,strokes:v.redo.at(-1)!,redo:v.redo.slice(0,-1),undo:[...v.undo,v.strokes],dirty:true,status:'合成蒙版未保存'}:v);
  const flush=async()=>{
    const snapshot=current.current;if(!snapshot.dirty||!snapshot.taskId)return true;
    const ok=await dispatch({type:'mask:save-composite',project_id:projectId,task_id:snapshot.taskId,strokes:snapshot.strokes});
    if(current.current===snapshot)setStored(v=>({...v,dirty:!ok,status:ok?'合成蒙版已同步，工程自动保存':'合成蒙版保存失败，请重试'}));
    return ok;
  };
  useEffect(()=>{if(!value.dirty)return;const timer=setTimeout(()=>void flush(),450);return()=>clearTimeout(timer);},[value.strokes,value.taskId]);
  return {strokes:value.strokes,change,undo,redo,canUndo:!!value.undo.length,canRedo:!!value.redo.length,flush,status:value.status};
}
