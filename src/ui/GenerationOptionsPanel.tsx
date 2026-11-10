import type { ModelConfig,Parameters } from '../core/domain.js';
import { contractFor,normalizeParameters,parameterFields,fieldError } from '../core/generation-parameters.js';
import { validSize,type ParameterField } from '../core/generation-contract.js';
import {referencePrecisionOptions,type ReferencePrecision} from '../core/module-settings.js';

export function GenerationOptionsPanel({model,parameters,references,referenceDefaults,onChange,scope='workflow'}:{model:ModelConfig;parameters:Parameters;references:{asset_id:string;name:string}[];referenceDefaults?:Record<string,ReferencePrecision[]>;onChange:(patch:Partial<Parameters>|((current:Parameters)=>Partial<Parameters>))=>void;scope?:'workflow'|'model-defaults'}){
  let p:Parameters;try{p=normalizeParameters(parameters,model);}catch{return <p className="notice warning">当前参数需要重新选择模型或恢复默认值。</p>;}
  const contract=contractFor(model),r=p.resolution??{mode:'default'},values=p.extensions?.[model.adapter_id]??{};
  const fields=parameterFields(model);
  const visibleFields=fields.filter(f=>(!f.display_scopes||f.display_scopes.includes(scope))&&(f.kind!=='references'||references.length>0));
  const primaryFields=scope==='model-defaults'?visibleFields.filter(f=>f.default_placement==='primary'):[];
  const advancedFields=visibleFields.filter(f=>!primaryFields.includes(f));
  const unsupportedFields=scope==='model-defaults'?Object.keys(values).filter(key=>!fields.some(f=>f.key===key)):[];
  const update=(key:string,value:typeof values[string]|undefined)=>onChange(current=>{
    const next=normalizeParameters(current,model),extensions=structuredClone(next.extensions??{}),own=extensions[model.adapter_id]??{};
    if(JSON.stringify(own[key])===JSON.stringify(value))return current;
    if(value===undefined)delete own[key];else own[key]=value;
    extensions[model.adapter_id]=own;return {...next,extensions};
  });
  const resolutionValue=r.mode==='tier'?'tier:'+r.value:r.mode==='pixel_budget'?'pixels:'+r.pixels:r.mode;
  const resolutionAvailable=contract.resolution_modes.includes(r.mode)&&(r.mode!=='tier'||contract.tiers.includes(r.value))&&(r.mode!=='pixel_budget'||contract.pixel_budgets.includes(r.pixels))&&(r.mode!=='exact'||!contract.size_limits||validSize(r.width,r.height,contract.size_limits));
  const field=(f:ParameterField)=>{
    const explicit=values[f.key],error=fieldError(f,explicit,p.output_format);
    if(f.formats&&!f.formats.includes(p.output_format)&&explicit===undefined)return null;
    const defaultValue=f.kind==='select'&&f.default!==undefined&&!f.values?.includes(String(f.default))?undefined:f.default;
    const value=explicit??defaultValue;
    if(f.fixed||f.kind==='select'&&!f.values?.length){
      const fixed=f.values?.length===1?`固定${f.value_labels?.[f.values[0]]??f.values[0]}`:undefined;
      return <div key={f.key} className="settings-primary-parameter"><label>{f.title}：<span className="settings-static-value">{fixed?`${fixed}${explicit===undefined?' · 使用模型默认':''}`:'模型默认'}</span></label>{(explicit!==undefined||error)&&<div className="settings-parameter-reset">{error&&<small role="alert">{error}</small>}{explicit!==undefined&&<button type="button" aria-label={`恢复${f.title}为模型默认`} onClick={()=>update(f.key,undefined)}>恢复模型默认</button>}</div>}</div>;
    }
    if(f.kind==='references')return <div key={f.key}><small>{f.title}</small>{references.map(ref=>{
      const hasModuleDefault=f.key==='reference_overrides'&&referenceDefaults!==undefined;
      const defaults=referenceDefaults?.[ref.asset_id]??['inherit'];
      const defaultLabel=defaults.length>1?'按模块':referencePrecisionOptions.find(option=>option.value===defaults[0])?.title??'跟随全局精度';
      const selected=(value as Record<string,string>|undefined)?.[ref.asset_id]??(hasModuleDefault?'module_default':'inherit');
      return <label key={ref.asset_id}>{ref.name}<select aria-label={ref.name+'识别精度'} value={selected} onChange={e=>{
        const overrides={...(value as Record<string,string>|undefined)};
        if(e.target.value==='module_default'||e.target.value==='inherit'&&!hasModuleDefault)delete overrides[ref.asset_id];
        else overrides[ref.asset_id]=e.target.value;
        update(f.key,overrides);
      }}>{hasModuleDefault&&<option value="module_default">模块默认（{defaultLabel}）</option>}<option value="inherit">跟随全局精度</option>{selected!=='inherit'&&selected!=='module_default'&&!f.values?.includes(selected)&&<option value={selected} disabled>{f.value_labels?.[selected]??selected}（当前不可用）</option>}{f.values?.filter(v=>v!=='inherit').map(v=><option key={v} value={v}>{f.value_labels?.[v]??v}</option>)}</select></label>;
    })}</div>;
    const control=<label className={scope==='model-defaults'&&f.kind==='boolean'?'settings-parameter-check':undefined}>{f.kind==='boolean'?<><input type="checkbox" checked={value===true} aria-invalid={!!error} onChange={e=>update(f.key,e.target.checked)}/>{f.title}</>:<>{f.title}{f.kind==='number'?<input aria-label={f.title} aria-invalid={!!error} type="number" step={f.integer?1:"any"} min={f.minimum} max={f.maximum} key={String(value)} defaultValue={value===undefined?'':Number(value)} placeholder={f.default===undefined?'模型默认':undefined} onBlur={e=>{const next=e.target.value===''?f.default:Number(e.target.value);if(next!==value)update(f.key,next);}}/>:<select aria-label={f.title} aria-invalid={!!error} value={String(value??'')} onChange={e=>update(f.key,e.target.value||undefined)}><option value="">模型默认</option>{value!==undefined&&!f.values?.includes(String(value))&&<option value={String(value)} disabled>{String(value)}（当前不可用）</option>}{f.values?.map(v=><option key={v} value={v} disabled={!!fieldError(f,v,p.output_format)}>{f.value_labels?.[v]??v}</option>)}</select>}</>}{f.help&&<small>{f.help}</small>}</label>;
    return <div key={f.key} className="generation-option-field">{control}{error&&<div className="settings-parameter-reset"><small role="alert">{error}</small>{explicit!==undefined&&!f.required&&<button type="button" aria-label={`清除不适用的${f.title}`} onClick={()=>update(f.key,undefined)}>恢复模型默认</button>}</div>}</div>;
  };
  return <div className={'generation-options'+(scope==='model-defaults'?' generation-options-model-defaults':'')}>
    {model.purpose!=='understanding'&&(contract.resolution_modes.length>1||scope==='model-defaults'&&!resolutionAvailable)&&<label>输出分辨率<select aria-label="输出分辨率" value={resolutionValue} onChange={e=>{const value=e.target.value;onChange({...p,resolution:value.startsWith('tier:')?{mode:'tier',value:value.slice(5)}:value.startsWith('pixels:')?{mode:'pixel_budget',pixels:Number(value.slice(7))}:value==='exact'?{mode:'exact',width:1024,height:1024}:{mode:'default'}});}}>
      {!resolutionAvailable&&<option value={resolutionValue} disabled>当前分辨率不可用</option>}
      {contract.resolution_modes.includes('default')&&<option value="default">接口默认</option>}{contract.resolution_modes.includes('tier')&&contract.tiers.map(v=><option key={v} value={'tier:'+v}>{v}</option>)}{contract.resolution_modes.includes('pixel_budget')&&contract.pixel_budgets.map(v=><option key={v} value={'pixels:'+v}>约 {Math.round(v/10000)} 万像素</option>)}{contract.resolution_modes.includes('exact')&&<option value="exact">自定义宽×高</option>}
    </select></label>}
    {primaryFields.map(field)}
    {r.mode==='exact'&&<><div className="parameter-grid">{(['width','height'] as const).map((key,index)=><label key={key}>{index?'高度':'宽度'}（像素）<input aria-label={index?'输出高度':'输出宽度'} type="number" step={contract.size_limits?.step} min={contract.size_limits?.step} max={contract.size_limits?.max_edge} key={key+':'+r[key]} defaultValue={r[key]} onBlur={e=>{const next=Number(e.target.value);if(next!==r[key])onChange({...p,resolution:{...r,[key]:next}});}}/></label>)}</div><small>明确宽×高决定最终比例。步长 {contract.size_limits?.step}；最长边 {contract.size_limits?.max_edge}。</small></>}
    {unsupportedFields.length>0&&<div className="settings-unsupported-parameters">{unsupportedFields.map(key=><div className="settings-parameter-reset" key={key}><small role="alert">当前型号不支持已保存的“{model.generation_contract?.fields.find(f=>f.key===key)?.title??key}”。</small><button type="button" aria-label={`清除不适用参数${key}`} onClick={()=>update(key,undefined)}>清除该参数</button></div>)}</div>}
    {advancedFields.length>0&&<details open={model.purpose==='understanding'?true:undefined}><summary>{model.purpose==='understanding'?'推理选项':'更多设置'}</summary>{scope==='model-defaults'?<div className="settings-advanced-fields">{advancedFields.map(field)}</div>:advancedFields.map(field)}</details>}
  </div>;
}
