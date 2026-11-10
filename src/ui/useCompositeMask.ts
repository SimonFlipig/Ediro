import {useEffect,useState} from 'react';
import type {MaskEdit,MaskStroke} from '../core/mask.js';
import {sameMaskStrokes} from '../core/mask.js';

export function useCompositeMask(taskId:string|undefined,edit:MaskEdit|undefined,initialStrokes?:MaskStroke[]){
  const initial=()=>({taskId,strokes:structuredClone(initialStrokes??edit?.composite_strokes??edit?.draft.strokes??[]),undo:[] as MaskStroke[][],redo:[] as MaskStroke[][],status:''});
  const [stored,setStored]=useState(initial);
  const value=stored.taskId===taskId?stored:initial();
  useEffect(()=>{if(stored.taskId!==taskId)setStored(initial());},[taskId]);
  const change=(strokes:MaskStroke[])=>setStored(v=>sameMaskStrokes(v.strokes,strokes)?v:{...v,strokes,undo:[...v.undo,v.strokes],redo:[],status:'临时预览 · 确认版本后保存'});
  const undo=()=>setStored(v=>v.undo.length?{...v,strokes:v.undo.at(-1)!,undo:v.undo.slice(0,-1),redo:[...v.redo,v.strokes],status:'临时预览 · 确认版本后保存'}:v);
  const redo=()=>setStored(v=>v.redo.length?{...v,strokes:v.redo.at(-1)!,redo:v.redo.slice(0,-1),undo:[...v.undo,v.strokes],status:'临时预览 · 确认版本后保存'}:v);
  const markSaved=(strokes:MaskStroke[])=>setStored(v=>v.taskId===taskId&&sameMaskStrokes(v.strokes,strokes)?{...v,status:'此版本蒙版已保存'}:v);
  return {strokes:value.strokes,change,undo,redo,canUndo:!!value.undo.length,canRedo:!!value.redo.length,markSaved,status:value.status};
}
