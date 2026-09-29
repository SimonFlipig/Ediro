import {useEffect,useRef,useState} from 'react';
import type {DesktopApi,ViewAsset} from '../shared/api.js';
import type {MaskMode,MaskStroke} from '../core/mask.js';

// Preview and output share a compositor. Sample the latest brush state with only
// one request in flight, rather than queueing every pointer move.
export function useMaskPreview(api:DesktopApi,projectId:string,taskId:string|undefined,raw:ViewAsset|undefined,mode:MaskMode,feather:number,saved:ViewAsset|undefined,enabled:boolean,strokes:MaskStroke[],fullSize?:{width:number;height:number}){
  const direct=mode==='natural'&&!fullSize;
  const context=JSON.stringify([projectId,taskId,raw?.asset_id,mode]);
  const key=JSON.stringify([context,mode==='strict'?feather:0,mode==='strict'?strokes:[]]);
  const [preview,setPreview]=useState<{context:string;key:string;url?:string;error?:string}|null>(null);
  const lastImage=useRef<{context:string;asset:ViewAsset}|null>(null);
  const [,wake]=useState(0);
  const running=useRef(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null),mounted=useRef(true);
  const latest=useRef({api,projectId,taskId,raw,mode,feather,saved,enabled,strokes,context,key,preview,direct});
  latest.current={api,projectId,taskId,raw,mode,feather,saved,enabled,strokes,context,key,preview,direct};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;if(timer.current){clearTimeout(timer.current);timer.current=null;}};},[]);
  useEffect(()=>{
    if(!enabled||!taskId||!raw||saved||direct||preview?.key===key||running.current||timer.current)return;
    timer.current=setTimeout(()=>{timer.current=null;void(async()=>{
      const request=latest.current;
      if(!request.enabled||!request.taskId||!request.raw||request.saved||request.direct||request.preview?.key===request.key)return;
      running.current=true;
      const publish=(value:{url?:string;error?:string})=>{if(mounted.current&&latest.current.context===request.context)setPreview({context:request.context,key:request.key,...value});};
      try{
        const response=await request.api.execute({type:'mask:preview',project_id:request.projectId,task_id:request.taskId,mode:request.mode,feather:request.feather,composite_strokes:request.strokes});
        publish(response.ok&&response.mask_preview?{url:response.mask_preview}:{error:response.error??'预览失败，请重新调整处理方式。'});
      }catch(error){publish({error:error instanceof Error?error.message:'预览失败'});}
      finally{running.current=false;if(mounted.current)wake(n=>n+1);}
    })();},80);
  });
  const error=!saved&&preview?.key===key?preview.error:undefined;
  const candidate=saved??(direct?raw:preview?.context===context&&preview.url&&raw?{...raw,...fullSize,name:'局部修改预览',original_url:preview.url,preview_url:preview.url}:undefined);
  if(candidate)lastImage.current={context,asset:candidate};
  const asset=candidate??(lastImage.current?.context===context?lastImage.current.asset:undefined);
  return {asset,error,pending:!!raw&&!saved&&!direct&&preview?.key!==key};
}
