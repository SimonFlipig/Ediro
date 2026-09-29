import { parametersSchema,type ModelConfig,type Parameters } from './domain.js';
import { generationContractSchema,validSize,type GenerationContract,type ParameterField } from './generation-contract.js';

export function contractFor(model:ModelConfig):GenerationContract {
  if(model.generation_contract){
    const c=generationContractSchema.parse(model.generation_contract);
    if(model.capabilities.input_forms)c.input_forms=c.input_forms.filter(f=>model.capabilities.input_forms!.includes(f));
    const limits=model.capabilities.parameter_limits??{};
    c.fields=c.fields.filter(f=>limits[f.key]?.enabled!==false).map(f=>{
      const l=limits[f.key];if(!l)return f;
      return {...f,values:l.values&&f.values?f.values.filter(v=>l.values!.includes(v)):f.values,minimum:l.minimum===undefined?f.minimum:Math.max(f.minimum??-Infinity,l.minimum),maximum:l.maximum===undefined?f.maximum:Math.min(f.maximum??Infinity,l.maximum)};
    });
    if(c.size_limits&&model.capabilities.size_limits){
      const a=c.size_limits,b=model.capabilities.size_limits;
      const gcd=(x:number,y:number):number=>y?gcd(y,x%y):x;
      c.size_limits={step:a.step*b.step/gcd(a.step,b.step),max_edge:Math.min(a.max_edge,b.max_edge),max_ratio:Math.min(a.max_ratio,b.max_ratio),min_pixels:Math.max(a.min_pixels,b.min_pixels),max_pixels:Math.min(a.max_pixels,b.max_pixels),default_pixels:b.default_pixels};
    }
    c.features=c.features.filter(f=>(model.capabilities.features??[]).includes(f));
    if(c.legacy_resolution_quality)c.tiers=c.tiers.filter(v=>model.capabilities.qualities.includes(v));
    return c;
  }
  // Old/local declarations have no advanced controls. Never infer from names.
  return generationContractSchema.parse({version:1,input_forms:model.capabilities.interleaving==='native'?['interleaved','numbered_flat']:['numbered_flat'],resolution_modes:['default']});
}
export function parameterFields(model:ModelConfig){
  const contract=contractFor(model);
  return contract.fields.filter(f=>!f.feature||contract.features.includes(f.feature));
}
export function normalizeParameters(input:Parameters,model:ModelConfig):Parameters {
  const p=parametersSchema.parse(input),contract=contractFor(model);
  if(p.version===2)return p;
  const resolution=p.resolution??(p.image_size?{mode:'tier' as const,value:p.image_size}:p.output_resolution==='custom'?{mode:'exact' as const,width:p.output_width!,height:p.output_height!}:p.output_resolution&&p.output_resolution!=='default'?{mode:'pixel_budget' as const,pixels:{'1MP':1048576,'4MP':4194304,'8MP':8294400}[p.output_resolution]}:contract.legacy_resolution_quality?{mode:'tier' as const,value:p.quality}:{mode:'default' as const});
  const extensions=structuredClone(p.extensions??{});
  for(const key of ['images_options','gemini_options'] as const){
    if(p[key]===undefined)continue;
    if(contract.legacy_extension_key!==key)throw new Error('所选适配器不支持旧 Images／Google 参数，请重新选择参数。');
    extensions[model.adapter_id]={...p[key],...extensions[model.adapter_id]};
  }
  return parametersSchema.parse({version:2,aspect_ratio:p.aspect_ratio,quality:contract.legacy_resolution_quality?'standard':p.quality,output_format:p.output_format,count:p.count,resolution,extensions});
}
export function extensionOptions(p:Parameters,model:ModelConfig){return normalizeParameters(p,model).extensions?.[model.adapter_id]??{};}
export function fieldError(field:ParameterField,value:unknown,format:string):string|undefined {
  if(value===undefined)return field.required?`${field.title}不能为空。`:undefined;
  if(field.formats&&!field.formats.includes(format))return `${field.title}不适用于 ${format.toUpperCase()}。`;
  if(field.forbidden_values_by_format?.[format]?.includes(String(value)))return `${field.title}“${field.value_labels?.[String(value)]??String(value)}”与 ${format.toUpperCase()} 不兼容。`;
  if(field.kind==='boolean'){if(typeof value!=='boolean')return `${field.title}须为开关值。`;}
  else if(field.kind==='number'){if(typeof value!=='number'||!Number.isFinite(value)||field.integer===true&&!Number.isInteger(value)||field.minimum!==undefined&&value<field.minimum||field.maximum!==undefined&&value>field.maximum)return `${field.title}超出数值范围。`;}
  else if(field.kind==='references'){if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(v=>typeof v!=='string'||!field.values?.includes(v)))return `${field.title}包含无效选项。`;}
  else if(typeof value!=='string'||!field.values?.includes(value))return `${field.title}不支持该选项。`;
}
export function validateGenerationParameters(parameters:Parameters,model:ModelConfig){
  const p=normalizeParameters(parameters,model),c=contractFor(model),fields=parameterFields(model);
  for(const [namespace,values] of Object.entries(p.extensions??{})){
    if(namespace!==model.adapter_id&&Object.keys(values).length)throw new Error('参数属于其他执行协议，请重新选择参数。');
    for(const [key,value] of Object.entries(values)){
      const field=fields.find(f=>f.key===key);if(!field)throw new Error(`所选模型未声明参数能力：${key}。`);
      const error=fieldError(field,value,p.output_format);if(error)throw new Error(error);
    }
  }
  for(const field of fields){
    if(field.required){
      const error=fieldError(field,p.extensions?.[model.adapter_id]?.[field.key],p.output_format);
      if(error)throw new Error(error);
    }
  }
  if(model.purpose==='understanding')return;
  const r=p.resolution??{mode:'default'};
  if(!c.resolution_modes.includes(r.mode))throw new Error('所选模型不支持该输出分辨率方式，请重新选择参数。');
  if(r.mode==='tier'&&!c.tiers.includes(r.value))throw new Error('输出分辨率超出所选模型声明的档位。');
  if(r.mode==='pixel_budget'&&!c.pixel_budgets.includes(r.pixels))throw new Error('输出像素档位超出模型声明范围。');
  if(r.mode==='exact'&&c.size_limits&&!validSize(r.width,r.height,c.size_limits))throw new Error('输出尺寸超出模型边长、像素或步长限制。');
  if(c.quality_control&&!model.capabilities.qualities.includes(p.quality))throw new Error('质量与所选模型不兼容，超出模型声明的档位。');
  if(!model.capabilities.formats.includes(p.output_format)||!Number.isInteger(p.count)||p.count<1||p.count>model.capabilities.max_count)throw new Error('格式或输出数量与所选模型不兼容。');
}

// Shared by UI and host edits: hidden inapplicable fields cannot still be sent.
export function updateParameters(current:Parameters,patch:Partial<Parameters>,model:ModelConfig):Parameters {
  const next=normalizeParameters({...normalizeParameters(current,model),...patch},model);
  const values=next.extensions?.[model.adapter_id];
  if(values)for(const f of parameterFields(model))if(f.formats&&!f.formats.includes(next.output_format))delete values[f.key];
  return next;
}
export function switchModelParameters(current:Parameters,model:ModelConfig,previousModel?:ModelConfig){
  const next=normalizeParameters(model.defaults,model);
  next.aspect_ratio=current.aspect_ratio;
  if(model.capabilities.formats.includes(current.output_format))next.output_format=current.output_format;
  next.count=Math.min(current.count,model.capabilities.max_count);
  if(contractFor(model).quality_control&&model.capabilities.qualities.includes(current.quality))next.quality=current.quality;
  const previous=previousModel?normalizeParameters(current,previousModel):current.version===2?current:undefined;
  if(previous){
    const candidate={...next,resolution:previous.resolution};
    try{validateGenerationParameters(candidate,model);next.resolution=previous.resolution;}catch{/* unsupported intent uses the destination default */}
    if(previousModel?.adapter_id===model.adapter_id){
      const allowed=parameterFields(model),own=previous.extensions?.[model.adapter_id]??{};
      next.extensions={[model.adapter_id]:Object.fromEntries(Object.entries(own).filter(([key,value])=>{const f=allowed.find(f=>f.key===key);return f&&!fieldError(f,value,next.output_format);}))};
    }
  }
  return updateParameters(next,{},model);
}
