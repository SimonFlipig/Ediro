import type { ModelConfig,Parameters } from '../core/domain.js';
import { contractFor,normalizeParameters,parameterFields,fieldError } from '../core/generation-parameters.js';
import type { ParameterField } from '../core/generation-contract.js';

export function GenerationOptionsPanel({model,parameters,references,onChange}:{model:ModelConfig;parameters:Parameters;references:{asset_id:string;name:string}[];onChange:(patch:Partial<Parameters>|((current:Parameters)=>Partial<Parameters>))=>void}){
  let p:Parameters;try{p=normalizeParameters(parameters,model);}catch{return <p className="notice warning">当前参数需要重新选择模型或恢复默认值。</p>;}
  const contract=contractFor(model),r=p.resolution??{mode:'default'},values=p.extensions?.[model.adapter_id]??{};
  const update=(key:string,value:typeof values[string]|undefined)=>onChange(current=>{
    const next=normalizeParameters(current,model),extensions=structuredClone(next.extensions??{}),own=extensions[model.adapter_id]??{};
    if(value===undefined)delete own[key];else own[key]=value;
    extensions[model.adapter_id]=own;return {...next,extensions};
  });
  const resolutionValue=r.mode==='tier'?'tier:'+r.value:r.mode==='pixel_budget'?'pixels:'+r.pixels:r.mode;
  const field=(f:ParameterField)=>{
    if(f.formats&&!f.formats.includes(p.output_format))return null;
    const defaultValue=f.kind==='select'&&f.default!==undefined&&!f.values?.includes(String(f.default))?undefined:f.default;
    const value=values[f.key]??defaultValue;
    if(f.kind==='references')return <div key={f.key}><small>{f.title}</small>{references.map(ref=><label key={ref.asset_id}>{ref.name}<select aria-label={ref.name+'识别精度'} value={(value as Record<string,string>|undefined)?.[ref.asset_id]??'inherit'} onChange={e=>{const overrides={...(value as Record<string,string>|undefined)};if(e.target.value==='inherit')delete overrides[ref.asset_id];else overrides[ref.asset_id]=e.target.value;update(f.key,overrides);}}><option value="inherit">跟随全局精度</option>{f.values?.map(v=><option key={v} value={v}>{f.value_labels?.[v]??v}</option>)}</select></label>)}</div>;
    return <label key={f.key}>{f.kind==='boolean'?<><input type="checkbox" checked={value===true} onChange={e=>update(f.key,e.target.checked)}/>{f.title}</>:<>{f.title}{f.kind==='number'?<input aria-label={f.title} type="number" min={f.minimum} max={f.maximum} key={String(value)} defaultValue={Number(value??0)} onBlur={e=>update(f.key,Number(e.target.value))}/>:<select aria-label={f.title} value={String(value??'')} onChange={e=>update(f.key,e.target.value||undefined)}><option value="">模型默认</option>{f.values?.map(v=><option key={v} value={v} disabled={!!fieldError(f,v,p.output_format)}>{f.value_labels?.[v]??v}</option>)}</select>}</>}{f.help&&<small>{f.help}</small>}</label>;
  };
  return <div className="generation-options">
    {model.purpose!=='understanding'&&contract.resolution_modes.length>1&&<label>输出分辨率<select aria-label="输出分辨率" value={resolutionValue} onChange={e=>{const value=e.target.value;onChange({...p,resolution:value.startsWith('tier:')?{mode:'tier',value:value.slice(5)}:value.startsWith('pixels:')?{mode:'pixel_budget',pixels:Number(value.slice(7))}:value==='exact'?{mode:'exact',width:1024,height:1024}:{mode:'default'}});}}>
      <option value="default">接口默认</option>{contract.tiers.map(v=><option key={v} value={'tier:'+v}>{v}</option>)}{contract.pixel_budgets.map(v=><option key={v} value={'pixels:'+v}>约 {Math.round(v/10000)} 万像素</option>)}{contract.resolution_modes.includes('exact')&&<option value="exact">自定义宽×高</option>}
    </select></label>}
    {r.mode==='exact'&&<><div className="parameter-grid">{(['width','height'] as const).map((key,index)=><label key={key}>{index?'高度':'宽度'}（像素）<input aria-label={index?'输出高度':'输出宽度'} type="number" step={contract.size_limits?.step} min={contract.size_limits?.step} max={contract.size_limits?.max_edge} key={key+':'+r[key]} defaultValue={r[key]} onBlur={e=>onChange({...p,resolution:{...r,[key]:Number(e.target.value)}})}/></label>)}</div><small>明确宽×高决定最终比例。步长 {contract.size_limits?.step}；最长边 {contract.size_limits?.max_edge}。</small></>}
    {parameterFields(model).length>0&&<details open={model.purpose==='understanding'?true:undefined}><summary>{model.purpose==='understanding'?'推理选项':'更多设置'}</summary>{parameterFields(model).filter(f=>f.kind!=='references'||references.length>0).map(field)}</details>}
  </div>;
}
