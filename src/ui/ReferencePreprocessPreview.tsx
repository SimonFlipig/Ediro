import {useEffect,useState} from 'react';
import type {ModuleSettings,ReferenceSettings} from '../core/module-settings.js';
import type {DesktopApi} from '../shared/api.js';
import {ReferencePreviewLightbox} from './ReferencePreviewLightbox.js';

export interface ReferencePreviewOptions {api:DesktopApi;project_id:string;settings:ModuleSettings}
const processLabels={none:'仅缩图',blur:'模糊',depth:'深度',segment:'区域分割'};
const strengthLabels={weak:'弱',medium:'中',strong:'强'};

export function ReferencePreprocessPreview({options,referenceType,moduleId,assetIds,settings,onChange,disabled=false}:{options:ReferencePreviewOptions;referenceType:'composition'|'style';moduleId:string;assetIds:string[];settings:ReferenceSettings;onChange:(settings:ReferenceSettings)=>void;disabled?:boolean}){
  const [index,setIndex]=useState(0),[retry,setRetry]=useState(0);
  const [result,setResult]=useState<{key:string;url?:string;error?:string}|null>(null);
  const [enlarged,setEnlarged]=useState<string|null>(null);
  const selectedIndex=Math.min(index,Math.max(0,assetIds.length-1)),assetId=assetIds[selectedIndex];
  const key=JSON.stringify([options.project_id,moduleId,referenceType,assetId,settings.max_edge,settings.preprocess,settings.blur_strength,retry]);
  useEffect(()=>{
    if(!assetId||settings.preprocess==='none')return;
    let active=true;
    const request_id=`preview_${crypto.randomUUID()}`;
    void options.api.execute({type:'reference:preview',request_id,project_id:options.project_id,module_id:moduleId,asset_id:assetId,reference_type:referenceType,settings}).then(response=>{
      if(!active)return;
      if(!response.ok||!response.reference_preview)throw new Error(response.error??'暂时无法预览，请重试。');
      setResult({key,url:response.reference_preview});
    }).catch(error=>{if(active)setResult({key,error:error instanceof Error?error.message:'暂时无法预览，请重试。'});});
    return()=>{active=false;void options.api.execute({type:'reference:cancel-preview',request_id}).catch(()=>{});};
  },[key,options.api]);
  const current=result?.key===key?result:null;
  return <><section className="reference-preprocess-preview" aria-label="生图参考预览">
    <div className="reference-preprocess-result">
      <button className="reference-preprocess-image" aria-label="放大生图参考预览" title="点击查看大图" disabled={!current?.url} onClick={()=>current?.url&&setEnlarged(current.url)}>{current?.url?<img src={current.url} alt="生图使用的处理后参考图"/>:<span>{settings.preprocess==='none'?'仅缩图，无预处理预览':!assetId?'添加参考图后可预览':current?.error?'预览未完成':'正在处理…'}</span>}</button>
      <div className="reference-preprocess-copy"><b>生图参考预览</b><span>{processLabels[settings.preprocess]}{settings.preprocess==='blur'?` · ${strengthLabels[settings.blur_strength]}`:''} · 最长边 {settings.max_edge===1024?'1K':'512'}</span>
        {current?.error?<div className="reference-preprocess-error"><p role="alert">{current.error}</p><button onClick={()=>setRetry(value=>value+1)}>重试预览</button></div>:<small>{current?.url?'点击图片查看大图':'参数可在右侧调整'}</small>}
        {assetIds.length>1&&settings.preprocess!=='none'&&<div className="reference-preprocess-pages"><button aria-label="上一张参考预览" disabled={selectedIndex===0} onClick={()=>setIndex(selectedIndex-1)}>‹</button><span>{selectedIndex+1} / {assetIds.length}</span><button aria-label="下一张参考预览" disabled={selectedIndex===assetIds.length-1} onClick={()=>setIndex(selectedIndex+1)}>›</button></div>}
      </div>
    </div>
    <div className="reference-preprocess-settings">
      <label><span>处理方式</span><select aria-label="当前参考图处理方式" value={settings.preprocess} disabled={disabled} onChange={event=>onChange({...settings,preprocess:event.target.value as ReferenceSettings['preprocess']})}><option value="none">仅缩图</option><option value="blur">模糊</option><option value="depth">深度</option><option value="segment">区域分割</option></select></label>
      <label><span>最长边</span><select aria-label="当前参考图最长边" value={settings.max_edge} disabled={disabled} onChange={event=>onChange({...settings,max_edge:Number(event.target.value) as 512|1024})}><option value={1024}>1K</option><option value={512}>512</option></select></label>
      {settings.preprocess==='blur'&&<label><span>模糊强度</span><select aria-label="当前参考图模糊强度" value={settings.blur_strength} disabled={disabled} onChange={event=>onChange({...settings,blur_strength:event.target.value as ReferenceSettings['blur_strength']})}><option value="weak">弱</option><option value="medium">中</option><option value="strong">强</option></select></label>}
      <small>按当前参数预览，保存后用于生图。</small>
    </div>
  </section>{enlarged&&<ReferencePreviewLightbox url={enlarged} onClose={()=>setEnlarged(null)}/>}</>;
}
