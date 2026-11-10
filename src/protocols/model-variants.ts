import type { ModelConfig } from '../core/domain.js';
import { generationContractSchema,type GenerationContract,type ParameterField } from '../core/generation-contract.js';
import { geminiProfile,imagesProfile } from './generation-profiles.js';

export type VariantFamily='nano'|'gpt-image';
export type ModelVariantInput=Pick<ModelConfig,'model'|'adapter_id'|'purpose'|'family'|'model_variant_override'|'nano_model_override'>;
export interface ModelVariant {
  id:string;
  title:string;
  model_id:string;
  family:VariantFamily;
  adapter_id:string;
  aliases:string[];
  suffix:'nano'|'date';
  qualities?:string[];
  contract?:Partial<GenerationContract>;
}
export interface ModelVariantInfo {
  family?:VariantFamily;
  variant?:ModelVariant;
  source:'automatic'|'manual'|'unknown';
  invalidOverride?:string;
}
const thinking=(values:string[],fixed=false):ParameterField=>({key:'thinking_level',title:'推理强度',kind:'select',values,value_labels:{minimal:'极低',medium:'中',high:'高'},display_scopes:['model-defaults'],default_placement:'primary',...(fixed?{fixed:true}:{}),help:'不设置时使用模型默认值；可能影响生成耗时和费用。'});
const imageQualities=['auto','low','medium','high'];
export const modelVariants:ModelVariant[]=[
  {id:'nano-banana-pro',title:'Nano Banana Pro',model_id:'gemini-3-pro-image',family:'nano',adapter_id:'gemini-generate-content',aliases:['gemini-3-pro-image','nano-banana-pro'],suffix:'nano',contract:{fields:[thinking(['high'],true)]}},
  {id:'nano-banana-2',title:'Nano Banana 2',model_id:'gemini-3.1-flash-image',family:'nano',adapter_id:'gemini-generate-content',aliases:['gemini-3.1-flash-image'],suffix:'nano',contract:{fields:[thinking(['minimal','high'])]}},
  {id:'nano-banana-2.1',title:'Nano Banana 2.1',model_id:'gemini-nano-banana-2.1',family:'nano',adapter_id:'gemini-generate-content',aliases:['gemini-nano-banana-2.1'],suffix:'nano',contract:{fields:[thinking(['minimal','medium','high'])]}},
  {id:'gpt-image-2-5-sunburst',title:'GPT Image 2.5 Sunburst',model_id:'gpt-image-2.5-sunburst',family:'gpt-image',adapter_id:'openai-images',aliases:['gpt-image-2.5-sunburst'],suffix:'date',qualities:[...imageQualities,'xhigh','max']},
  {id:'gpt-image-2-5-flare',title:'GPT Image 2.5 Flare',model_id:'gpt-image-2.5-flare',family:'gpt-image',adapter_id:'openai-images',aliases:['gpt-image-2.5-flare'],suffix:'date',qualities:[...imageQualities,'xhigh','max']},
  {id:'gpt-image-2',title:'GPT Image 2',model_id:'gpt-image-2',family:'gpt-image',adapter_id:'openai-images',aliases:['gpt-image-2'],suffix:'date',qualities:[...imageQualities]},
];
const familyContracts:Record<VariantFamily,GenerationContract>={nano:geminiProfile,'gpt-image':imagesProfile};
const legacyNanoVariants:Record<NonNullable<ModelConfig['nano_model_override']>,string>={pro:'nano-banana-pro','2':'nano-banana-2','2.1':'nano-banana-2.1'};
const dateSuffix='(?:-\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01]))?';
const suffixes={nano:'(?:-preview)?'+dateSuffix+'(?:-[124]k)?',date:dateSuffix};
function variantFamily(model:ModelVariantInput):VariantFamily|undefined {
  if(model.purpose==='understanding')return;
  if(model.adapter_id==='gemini-generate-content'&&(!model.family||model.family==='nano'))return 'nano';
  if(model.adapter_id==='openai-images'&&(!model.family||model.family==='gpt-image'))return 'gpt-image';
}
export function modelVariantOptions(model:ModelVariantInput):ModelVariant[] {
  const family=variantFamily(model);
  return modelVariants.filter(v=>v.family===family&&v.adapter_id===model.adapter_id).map(v=>structuredClone(v));
}
export function modelVariantInfo(model:ModelVariantInput):ModelVariantInfo {
  const family=variantFamily(model),options=modelVariantOptions(model);
  // Legacy correction is read-only compatibility. A generic override always wins.
  const override=model.model_variant_override??(family==='nano'&&model.nano_model_override?legacyNanoVariants[model.nano_model_override]:undefined);
  if(override!==undefined){
    const variant=options.find(v=>v.id===override);
    if(!variant)return {family,source:'unknown',invalidOverride:'型号覆盖不存在或与当前模型家族、接口协议不匹配。'};
    return {family,variant,source:'manual'};
  }
  const id=model.model.trim().toLowerCase().replace(/^models\//,'');
  const variant=options.find(v=>v.aliases.some(alias=>new RegExp('^'+alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+suffixes[v.suffix]+'$').test(id)));
  return {family,variant,source:variant?'automatic':'unknown'};
}

// Keep custom stored fields, refresh declared family fields, then layer only the
// selected variant's fields. Channel restrictions are applied by contractFor.
export function modelVariantContract(model:ModelVariantInput&Pick<ModelConfig,'generation_contract'>):GenerationContract|undefined {
  const info=modelVariantInfo(model);
  if(!info.family)return model.generation_contract?generationContractSchema.parse(model.generation_contract):undefined;
  const base=familyContracts[info.family],stored=model.generation_contract;
  const managed=new Set(modelVariantOptions(model).flatMap(v=>v.contract?.fields?.map(f=>f.key)??[]));
  const fields=new Map((stored?.fields??[]).filter(f=>!managed.has(f.key)).map(f=>[f.key,f]));
  for(const field of base.fields)fields.set(field.key,field);
  for(const field of info.variant?.contract?.fields??[])fields.set(field.key,field);
  return generationContractSchema.parse({...base,...stored,...info.variant?.contract,features:[...new Set([...base.features,...stored?.features??[],...info.variant?.contract?.features??[]])],fields:[...fields.values()]});
}
