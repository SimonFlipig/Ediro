import type { ModelConfig,Parameters } from '../core/domain.js';
import { contractFor,effectiveCapabilitiesFor,updateParameters } from '../core/generation-parameters.js';
import { GenerationOptionsPanel } from './GenerationOptionsPanel.js';

export function ModelParametersForm({model,value,onChange}:{model:ModelConfig;value:Parameters;onChange:(value:Parameters)=>void}){
  const patch=(change:Partial<Parameters>)=>onChange(updateParameters(value,change,model));
  const capabilities=effectiveCapabilitiesFor(model);
  return <div className="model-parameter-form settings-parameter-grid">
    {model.purpose!=='understanding'&&<>
      <label>默认画面比例<select value={value.aspect_ratio} onChange={e=>patch({aspect_ratio:e.target.value})}><option value="auto">自动</option>{value.aspect_ratio!=='auto'&&!capabilities.aspect_ratios.includes(value.aspect_ratio)&&<option value={value.aspect_ratio} disabled>{value.aspect_ratio}（当前不可用）</option>}{capabilities.aspect_ratios.filter(v=>v!=='auto').map(v=><option key={v}>{v}</option>)}</select></label>
      {contractFor(model).quality_control&&<label>默认质量<select value={value.quality} onChange={e=>patch({quality:e.target.value})}>{!capabilities.qualities.includes(value.quality)&&<option value={value.quality} disabled>{value.quality}（当前不可用）</option>}{capabilities.qualities.map(v=><option key={v}>{v}</option>)}</select></label>}
      <label>默认输出格式<select value={value.output_format} onChange={e=>patch({output_format:e.target.value as Parameters['output_format']})}>{!capabilities.formats.includes(value.output_format)&&<option value={value.output_format} disabled>{value.output_format}（当前不可用）</option>}{capabilities.formats.map(v=><option key={v}>{v}</option>)}</select></label>
      <label>默认输出数量<input type="number" min={1} max={capabilities.max_count} value={value.count} onChange={e=>patch({count:Number(e.target.value)})}/></label>
    </>}
    <GenerationOptionsPanel scope="model-defaults" model={model} parameters={value} references={[]} onChange={change=>patch(typeof change==='function'?change(value):change)}/>
  </div>;
}
