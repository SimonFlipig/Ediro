import { maskEditMethod } from '../core/mask-request.js';
import { forwardRef,useImperativeHandle,useRef,useState } from 'react';
import { defaultImagesCompatibility,type ModelConfig,type Parameters,type PublicModel } from '../core/domain.js';
import type { ModelEntry } from '../core/model-library.js';
import type { Command,WorkspaceView } from '../shared/api.js';
import { familyForModel,findPreset,modelFamilies,modelForEnrollment } from '../protocols/model-catalog.js';
import { contractFor,effectiveCapabilitiesFor,fieldError,normalizeParameters,parameterFields,validateGenerationParameters } from '../core/generation-parameters.js';
import { validSize } from '../core/generation-contract.js';
import { ModelParametersForm } from './ModelParametersForm.js';
import { modelVariantInfo,modelVariantOptions } from '../protocols/model-variants.js';
import {imagesUploadLimits,MAX_IMAGES_FILE_MB,MAX_IMAGES_REQUEST_MB,geminiUploadLimits,MAX_GEMINI_REQUEST_MB} from '../core/image-limits.js';

export interface DraftHandle {dirty:boolean;save:()=>Promise<boolean>}
type ModelIdentity=Pick<ModelConfig,'model'|'model_variant_override'|'nano_model_override'>;
const identityKey=(model:ModelIdentity)=>JSON.stringify([model.model,model.model_variant_override??null,model.nano_model_override??null]);

// Only invoked after the user confirms a different identity. Merely opening an
// existing entry must not migrate or repair its stored independent defaults.
function defaultsForChangedIdentity(model:ModelConfig):{defaults?:Parameters;titles:string[]} {
  const next=normalizeParameters(model.defaults,model),capabilities=effectiveCapabilitiesFor(model),contract=contractFor(model),fields=parameterFields(model),titles:string[]=[];
  if(model.purpose!=='understanding'){
    if(next.aspect_ratio!=='auto'&&!capabilities.aspect_ratios.includes(next.aspect_ratio)){next.aspect_ratio='auto';titles.push('画面比例');}
    if(contract.quality_control&&!capabilities.qualities.includes(next.quality)&&capabilities.qualities.length){next.quality=capabilities.qualities.includes('auto')?'auto':capabilities.qualities[0];titles.push('质量');}
    if(contract.output_format_control&&!capabilities.formats.includes(next.output_format)&&capabilities.formats.length){next.output_format=capabilities.formats[0] as Parameters['output_format'];titles.push('输出格式');}
    if(next.count>capabilities.max_count){next.count=Math.max(1,Math.floor(capabilities.max_count));titles.push('输出数量');}
    const r=next.resolution??{mode:'default'};
    const valid=contract.resolution_modes.includes(r.mode)&&(r.mode!=='tier'||contract.tiers.includes(r.value))&&(r.mode!=='pixel_budget'||contract.pixel_budgets.includes(r.pixels))&&(r.mode!=='exact'||!contract.size_limits||validSize(r.width,r.height,contract.size_limits));
    if(!valid){
      const resolution:Parameters['resolution']=contract.resolution_modes.includes('default')?{mode:'default'}:contract.resolution_modes.includes('tier')&&contract.tiers.length?{mode:'tier',value:contract.tiers[0]}:contract.resolution_modes.includes('pixel_budget')&&contract.pixel_budgets.length?{mode:'pixel_budget',pixels:contract.pixel_budgets[0]}:undefined;
      if(resolution){next.resolution=resolution;titles.push('输出分辨率');}
    }
  }
  const own=next.extensions?.[model.adapter_id];
  if(own)for(const [key,value] of Object.entries(own)){
    const field=fields.find(f=>f.key===key);
    if(!field||fieldError(field,value,next.output_format)){
      delete own[key];
      titles.push(field?.title??model.generation_contract?.fields.find(f=>f.key===key)?.title??key);
    }
  }
  return {defaults:titles.length?next:undefined,titles};
}

export const ModelSettingsEditor=forwardRef<DraftHandle,{model:PublicModel;view:WorkspaceView;save:(c:Command)=>Promise<boolean>;busy:boolean;onRemove:()=>void}>(function ModelSettingsEditor({model,view,save,busy,onRemove},ref){
  const initial=():Omit<ModelEntry,'revision'>=>({model_config_id:model.model_config_id,title:model.title,kind:model.kind,provider:model.provider,model:model.model,adapter_id:model.adapter_id,connection_id:model.connection_id,purpose:model.purpose??'generation',family:model.family,model_variant_override:model.model_variant_override,nano_model_override:model.nano_model_override,independent_defaults:model.independent_defaults,capability_source:model.capability_source==='tested'?'user':model.capability_source??'documented',enabled:model.enabled,capabilities:structuredClone(model.declared_capabilities??model.capabilities),generation_contract:model.generation_contract,defaults:structuredClone(model.defaults),preset_id:model.preset_id,legacy_defaults_pending:model.legacy_defaults_pending,images_compatibility:model.images_compatibility,gemini_compatibility:model.gemini_compatibility});
  const [draft,setDraft]=useState(initial),[baseline,setBaseline]=useState(()=>JSON.stringify(initial())),[tab,setTab]=useState<'parameters'|'connection'>('parameters'),[identityNotice,setIdentityNotice]=useState('');
  const dirty=JSON.stringify(draft)!==baseline;
  const preset=findPreset(draft.preset_id),family=familyForModel(draft),resolved={...model,...draft,endpoint:model.endpoint,executable:model.executable} as ModelConfig;
  const familyTitle=modelFamilies.find(f=>f.id===family)?.title??'自定义模型';
  const variantInfo=modelVariantInfo(resolved),variantOptions=modelVariantOptions(resolved),capabilities=effectiveCapabilitiesFor(resolved);
  const checkedIdentity=useRef(identityKey(initial()));
  const previousVisionLimit=useRef(model.capabilities.max_images||8);
  const patch=(v:Partial<typeof draft>)=>setDraft(m=>({...m,...v,...(v.defaults?{independent_defaults:true,legacy_defaults_pending:false}:{})}));
  const checkIdentity=(next:typeof draft)=>{
    if(identityKey(next)===checkedIdentity.current)return next;
    const {defaults,titles}=defaultsForChangedIdentity({...resolved,...next});
    checkedIdentity.current=identityKey(next);
    setIdentityNotice(defaults?`型号已变化，已恢复不适用的默认参数：${titles.join('、')}。其他默认参数保持不变。`:'');
    return defaults?{...next,defaults,independent_defaults:true,legacy_defaults_pending:false}:next;
  };
  const changeModelIdentity=(change:Partial<ModelIdentity>)=>setDraft(checkIdentity({...draft,...change}));
  const setVision=(enabled:boolean)=>{if(!enabled&&draft.capabilities.max_images>0)previousVisionLimit.current=draft.capabilities.max_images;patch({capability_source:'user',capabilities:{...draft.capabilities,max_images:enabled?previousVisionLimit.current:0}});};
  const operationEnabled=(operation:string)=>!draft.capabilities.disabled_operations?.includes(operation)&&(draft.capabilities.operations.includes(operation)||!!preset?.config.capabilities.operations.includes(operation));
  const setOperation=(operation:string,enabled:boolean)=>patch({capability_source:'user',capabilities:{...draft.capabilities,operations:[...draft.capabilities.operations.filter(op=>op!==operation),...(enabled?[operation]:[])],disabled_operations:[...(draft.capabilities.disabled_operations??[]).filter(op=>op!==operation),...(!enabled?[operation]:[])]}});
  const persist=async()=>{const next={...checkIdentity(draft),independent_defaults:true,legacy_defaults_pending:false};setDraft(next);const ok=await save({type:'model:save',model:next});if(ok){setDraft(next);setBaseline(JSON.stringify(next));}return ok;};
  useImperativeHandle(ref,()=>({dirty,save:persist}));
  const restoreDefaults=()=>{const defaults=preset?.config.defaults??(family&&draft.kind==='cloud'?modelForEnrollment(family,draft.adapter_id,draft.model_config_id,draft.connection_id??'',draft.model).defaults:undefined);if(defaults){const restored=structuredClone(defaults);patch({defaults:defaultsForChangedIdentity({...resolved,defaults:restored}).defaults??restored});setIdentityNotice('');}};
  const isDefault=view.assignments?.[`${draft.purpose}_default`]===draft.model_config_id;
  const isEditingDefault=view.assignments?.editing_default===draft.model_config_id;
  // Assignment acts on the saved model; use its effective preset/adapter
  // capabilities, not the editable legacy declarations. Dirty drafts cannot assign.
  const canBeEditingDefault=!!maskEditMethod(model);
  const parameters=normalizeParameters(draft.defaults,resolved);
  let parameterError:string|undefined;try{validateGenerationParameters(parameters,resolved);}catch(error){parameterError=error instanceof Error?error.message:'当前默认参数不适用于此型号，请调整后保存。';}
  return <div className="settings-editor">
    <header className="settings-detail-heading"><div><span className="settings-eyebrow">模型设置</span><h2>{draft.title}</h2><p>{view.connections?.find(c=>c.connection_id===draft.connection_id)?.title??(draft.kind==='mock'?'内置模拟':'本地模型')} · {draft.purpose==='understanding'?'推理':'生图与编辑'}</p></div><span className="settings-status" role="status">{dirty?'未保存':model.executable?'已配置':'待配置'}</span></header>
    <div className="settings-tabs" aria-label="模型设置分类"><button aria-pressed={tab==='parameters'} onClick={()=>setTab('parameters')}>默认参数</button><button aria-pressed={tab==='connection'} onClick={()=>setTab('connection')}>接入设置</button></div>
    <div className="settings-preset-summary"><small>模型家族</small><b>{familyTitle}</b><p>{tab==='parameters'?'默认参数单独保存在当前模型中，用于新工作流程。':preset?'已识别型号参数，模型 ID 用于平台调用。':family?'使用家族默认配置，能力可按平台说明调整。':'保留当前模型的参数与能力。'}</p></div>
    <section className="settings-model-identity" aria-label="模型身份">
      <label>模型显示名称<input aria-label="模型显示名称" value={draft.title} maxLength={100} onChange={e=>patch({title:e.target.value})}/></label>
      <label>渠道模型 ID<input aria-label="渠道模型 ID" value={draft.model} onChange={e=>patch({model:e.target.value})} onBlur={e=>changeModelIdentity({model:e.target.value})}/></label>
      {variantOptions.length>0&&<label className="settings-family-variant">家族型号<select aria-label="家族型号" title={variantInfo.variant?.title??'未识别型号'} value={variantInfo.variant?.id??''} onChange={e=>changeModelIdentity({model_variant_override:e.target.value==='auto'||!e.target.value?undefined:e.target.value,nano_model_override:undefined})}>
        {!variantInfo.variant&&<option value="">未识别（模型默认）</option>}
        {variantOptions.map(variant=><option key={variant.id} value={variant.id}>{variant.title} · {variant.model_id}</option>)}
        <option value="auto">按渠道 ID 自动识别</option>
      </select>{!variantInfo.variant&&<small>{variantInfo.invalidOverride??'未识别型号，使用当前通用参数。'}</small>}</label>}
    </section>
    {draft.legacy_defaults_pending&&<p className="settings-hint">已保留此模型的旧默认值；保存后，后续参数调整仅影响当前模型。</p>}
    {identityNotice&&<p className="settings-notice" role="status">{identityNotice}</p>}
    <section className="settings-model-parameters" hidden={tab!=='parameters'}><h3>{draft.purpose==='understanding'?'默认推理参数':'新配方的起始参数'}</h3>{parameterError&&<p className="settings-notice" role="alert">{parameterError}</p>}<ModelParametersForm model={resolved} value={parameters} onChange={defaults=>{patch({defaults});setIdentityNotice('');}}/><p className="settings-hint">已有工程和历史结果的参数保持不变。</p>
    </section>
    <section hidden={tab!=='connection'}>
    <details><summary>模型信息与能力</summary><p className="settings-hint">{draft.purpose==='generation'?`比例：${capabilities.aspect_ratios.join('、')}。`:capabilities.max_images>0?'支持图片与文字推理。':'仅文字推理。'} {capabilities.max_images>0&&`参考图上限：${capabilities.max_images} 张（当前接入范围）。`}</p>{preset&&<a href={preset.source} target="_blank" rel="noreferrer">查看官方说明</a>}<label className="settings-check"><input type="checkbox" checked={draft.enabled} onChange={e=>patch({enabled:e.target.checked})}/>启用此接口的模型</label></details>
    <p className="settings-hint">接口协议：{view.adapters?.find(a=>a.adapter_id===draft.adapter_id)?.title??draft.adapter_id}</p>
    <details><summary>当前接口兼容设置</summary><p className="settings-hint">仅影响此渠道接入，不修改其他渠道。</p>
      {draft.adapter_id==='openai-images'&&<><label>输出格式字段<select value={(draft.images_compatibility??defaultImagesCompatibility).format_field} onChange={e=>patch({images_compatibility:{...(draft.images_compatibility??defaultImagesCompatibility),format_field:e.target.value as 'format'|'output_format'}})}><option value="output_format">output_format（官方）</option><option value="format">format（兼容）</option></select></label><label>参考图字段<select value={(draft.images_compatibility??defaultImagesCompatibility).image_field} onChange={e=>patch({images_compatibility:{...(draft.images_compatibility??defaultImagesCompatibility),image_field:e.target.value as 'image'|'image[]'}})}><option value="image[]">image[]（官方）</option><option value="image">image（兼容）</option></select></label><label className="settings-check"><input type="checkbox" checked={(draft.images_compatibility??defaultImagesCompatibility).send_response_format} onChange={e=>patch({images_compatibility:{...(draft.images_compatibility??defaultImagesCompatibility),send_response_format:e.target.checked}})}/>发送 response_format=b64_json</label><label>提示词字符上限<input type="number" min={1} max={32000} value={(draft.images_compatibility??defaultImagesCompatibility).max_prompt_chars} onChange={e=>patch({images_compatibility:{...(draft.images_compatibility??defaultImagesCompatibility),max_prompt_chars:Number(e.target.value)}})}/></label></>}
      {view.adapters?.find(a=>a.adapter_id===draft.adapter_id)?.operations.includes('nativeMaskEdit')&&<label className="settings-check"><input type="checkbox" checked={operationEnabled('nativeMaskEdit')} onChange={e=>setOperation('nativeMaskEdit',e.target.checked)}/>此渠道支持原生蒙版编辑</label>}
      {draft.adapter_id==='openai-images'&&<><label>单文件上限（MB）<input aria-label="单文件上限（MB）" type="number" min={1} max={MAX_IMAGES_FILE_MB} value={imagesUploadLimits(draft.images_compatibility).fileMB} onChange={e=>patch({images_compatibility:{...(draft.images_compatibility??defaultImagesCompatibility),max_image_mb:Number(e.target.value)}})}/></label><label>请求合计预算（MB）<input aria-label="请求合计预算（MB）" type="number" min={1} max={MAX_IMAGES_REQUEST_MB} value={imagesUploadLimits(draft.images_compatibility).requestMB} onChange={e=>patch({images_compatibility:{...(draft.images_compatibility??defaultImagesCompatibility),max_request_mb:Number(e.target.value)}})}/></label><p className="settings-hint">图片、蒙版与文字的本地发送预算，默认 50 MB。请按渠道实际限制调整；调大预算不代表上游支持。</p></>}
      {draft.adapter_id==='gemini-generate-content'&&<><label>内联请求预算（MB）<input aria-label="内联请求预算（MB）" type="number" min={1} max={MAX_GEMINI_REQUEST_MB} value={geminiUploadLimits(draft.gemini_compatibility).requestMB} onChange={e=>patch({gemini_compatibility:{...draft.gemini_compatibility,max_request_mb:Number(e.target.value)}})}/></label><p className="settings-hint">按编码后的完整请求计算，默认 100 MB；可按渠道限制调低。</p></>}
      {view.adapters?.find(a=>a.adapter_id===draft.adapter_id)?.operations.includes('guidedMaskEdit')&&draft.purpose==='generation'&&<label className="settings-check"><input type="checkbox" checked={operationEnabled('guidedMaskEdit')} onChange={e=>setOperation('guidedMaskEdit',e.target.checked)}/>启用黑白区域图引导编辑</label>}
      {draft.purpose==='understanding'&&<label className="settings-check"><input type="checkbox" checked={draft.capabilities.max_images>0} onChange={e=>setVision(e.target.checked)}/>此模型支持图片理解</label>}
      <label>渠道参考图上限<input type="number" min={0} max={preset?.config.capabilities.max_images??100} value={draft.capabilities.max_images} onChange={e=>patch({capability_source:'user',capabilities:{...draft.capabilities,max_images:Number(e.target.value)}})}/></label>
    </details>
    </section>
    {model.readiness_error&&<p className="settings-notice">{model.readiness_error}</p>}
    <div className="settings-savebar"><button className="primary" disabled={busy||!draft.title.trim()||!draft.model.trim()} onClick={()=>void persist()}>保存设置</button><button disabled={busy||!dirty} onClick={()=>{const restored=JSON.parse(baseline) as typeof draft;setDraft(restored);checkedIdentity.current=identityKey(restored);setIdentityNotice('');}}>还原修改</button>{tab==='parameters'&&<button disabled={busy||!preset&&!(family&&draft.kind==='cloud')} onClick={restoreDefaults}>恢复起始参数</button>}</div>
    <div className="settings-actions">{canBeEditingDefault&&<button disabled={busy||dirty||!draft.enabled||isEditingDefault} onClick={()=>void save({type:'model:assign',purpose:'editing',model_config_id:draft.model_config_id})}>{isEditingDefault?'已设为默认编辑模型':'设为默认编辑模型'}</button>}<button disabled={busy||dirty||isDefault||!draft.enabled} onClick={()=>void save({type:'model:assign',purpose:draft.purpose,model_config_id:draft.model_config_id})}>{isDefault?'当前默认模型':draft.purpose==='understanding'?'设为默认推理模型':'设为默认生图模型'}</button><button disabled={busy||draft.kind==='mock'} title={draft.kind==='mock'?'内置模拟引擎不可移除，会随模型库自动隐藏或恢复。':undefined} onClick={onRemove}>移除接入</button></div>
    {draft.purpose==='understanding'&&<details><summary>推理链路测试</summary><p className="settings-hint">发送固定算术问题，可能计费。只验证文本推理，不代表图片理解已验证。</p><button disabled={busy||dirty||!model.executable} onClick={()=>void save({type:'model:test',model_config_id:model.model_config_id})}>测试推理链路（可能计费）</button>{view.model_tests?.filter(t=>t.model_config_id===model.model_config_id).slice(-3).reverse().map(t=><article key={t.test_id}><p>{t.status==='succeeded'?'测试成功':t.status==='running'?'测试中':'测试失败'} {t.error}</p>{t.status==='succeeded'&&<button disabled={busy} onClick={()=>void save({type:'model:accept-test',test_id:t.test_id})}>采用测试结果</button>}</article>)}</details>}
  </div>;
});
