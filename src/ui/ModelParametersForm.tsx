import type { ModelConfig,Parameters } from '../core/domain.js';
import { contractFor,updateParameters } from '../core/generation-parameters.js';
import { GenerationOptionsPanel } from './GenerationOptionsPanel.js';

export function ModelParametersForm({model,value,onChange}:{model:ModelConfig;value:Parameters;onChange:(value:Parameters)=>void}){
  const patch=(change:Partial<Parameters>)=>onChange(updateParameters(value,change,model));
  return <div className="model-parameter-form">
    {model.purpose!=='understanding'&&<div className="settings-field-grid">
      <label>默认画面比例<select value={value.aspect_ratio} onChange={e=>patch({aspect_ratio:e.target.value})}><option value="auto">自动</option>{model.capabilities.aspect_ratios.filter(v=>v!=='auto').map(v=><option key={v}>{v}</option>)}</select></label>
      {contractFor(model).quality_control&&<label>默认质量<select value={value.quality} onChange={e=>patch({quality:e.target.value})}>{model.capabilities.qualities.map(v=><option key={v}>{v}</option>)}</select></label>}
      <label>默认输出格式<select value={value.output_format} onChange={e=>patch({output_format:e.target.value as Parameters['output_format']})}>{model.capabilities.formats.map(v=><option key={v}>{v}</option>)}</select></label>
      <label>默认输出数量<input type="number" min={1} max={model.capabilities.max_count} value={value.count} onChange={e=>patch({count:Number(e.target.value)})}/></label>
    </div>}
    <GenerationOptionsPanel model={model} parameters={value} references={[]} onChange={change=>patch(typeof change==='function'?change(value):change)}/>
  </div>;
}
