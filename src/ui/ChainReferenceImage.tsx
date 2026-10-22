import {useEffect,useState} from 'react';
import type {SemanticModule} from '../core/domain.js';
import {isReferenceModuleType,resolveReferenceSettings,type ModuleSettings} from '../core/module-settings.js';
import type {DesktopApi,ViewAsset} from '../shared/api.js';
import {usableThumbnail} from './asset-display.js';
import {ReferencePreviewLightbox} from './ReferencePreviewLightbox.js';

const processLabels={none:'仅缩图',blur:'模糊',depth:'深度',segment:'区域分割'};
const strengthLabels={weak:'弱',medium:'中',strong:'强'};

export function ChainReferenceImage({api,projectId,module,asset,assetId,moduleId,referenceType,defaults}:{
  api?:DesktopApi;projectId?:string;module?:SemanticModule;asset?:ViewAsset;assetId:string;moduleId:string;referenceType:string;defaults:ModuleSettings;
}){
  const [retry,setRetry]=useState(0);
  const [result,setResult]=useState<{key:string;url?:string;error?:string}|null>(null);
  const [enlarged,setEnlarged]=useState<{key:string;url:string}|null>(null);
  const reference=isReferenceModuleType(referenceType);
  const settings=reference?resolveReferenceSettings({reference_type:referenceType,reference_settings:module?.reference_settings},defaults):undefined;
  const available=usableThumbnail(asset);
  const key=JSON.stringify([projectId,moduleId,assetId,referenceType,asset?.location,asset?.source_status,settings,retry]);
  useEffect(()=>{
    if(!reference||!settings||!available)return;
    if(!api||!projectId||!module||module.reference_type!==referenceType){setResult({key,error:'参考图所属模块不可用。'});return;}
    let active=true;
    const request_id=`chain_preview_${crypto.randomUUID()}`;
    void api.execute({type:'reference:preview',request_id,project_id:projectId,module_id:moduleId,asset_id:assetId,reference_type:referenceType,settings}).then(response=>{
      if(!active)return;
      if(!response.ok||!response.reference_preview)throw new Error(response.error??'暂时无法预览，请重试。');
      setResult({key,url:response.reference_preview});
    }).catch(error=>{if(active)setResult({key,error:error instanceof Error?error.message:'暂时无法预览，请重试。'});});
    return()=>{active=false;void api.execute({type:'reference:cancel-preview',request_id}).catch(()=>{});};
  },[key,api,available]);
  const current=result?.key===key?result:null;
  const name=asset?.name??assetId;
  if(!reference||!settings)return <div className="image-block-content" data-module-id={moduleId} data-asset-id={assetId}>{available?<img src={asset!.preview_url} alt="输入参考"/>:<span className="missing-image-label">图片缺失</span>}<span title={name}>{name}</span></div>;
  return <>
    <div className="image-block-content" data-module-id={moduleId} data-asset-id={assetId}>
      <button className="chain-reference-preview" type="button" aria-label="放大生图参考图" title="查看当前生图参考" disabled={!available||!current?.url} onClick={()=>current?.url&&setEnlarged({key,url:current.url})}>
        {available&&current?.url?<img src={current.url} alt="生图参考" onError={()=>setResult({key,error:'参考图无法显示，请重试。'})}/>:<span aria-label={!available?'图片缺失':current?.error?'预览失败':'正在处理'}>{!available||current?.error?'!':'…'}</span>}
      </button>
      <div className="chain-reference-copy"><span title={name}>{name}</span><span className="chain-reference-label">{processLabels[settings.preprocess]}{settings.preprocess==='blur'?` · ${strengthLabels[settings.blur_strength]}`:''} · 最长边 {settings.max_edge===1024?'1K':'512'}</span>{!available?<span>图片缺失</span>:!current&&<span role="status">正在处理…</span>}</div>
    </div>
    {available&&current?.error&&<div className="chain-reference-error"><p role="alert">{current.error}</p><button type="button" onClick={()=>setRetry(value=>value+1)}>重试预览</button></div>}
    {available&&enlarged?.key===key&&<ReferencePreviewLightbox url={enlarged.url} onClose={()=>setEnlarged(null)}/>}
  </>;
}
