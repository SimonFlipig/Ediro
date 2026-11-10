import type { ModelConfig } from '../core/domain.js';
import { modelVariantInfo } from './model-variants.js';

export type NanoModelVariant = 'pro'|'2'|'2.1';
export interface NanoModelInfo {
  variant?:NanoModelVariant;
  source:'automatic'|'manual'|'unknown';
  title:string;
  thinkingLevels:string[];
}
type NanoModelInput=Pick<ModelConfig,'model'|'adapter_id'|'purpose'|'family'|'nano_model_override'|'model_variant_override'>;
const legacyIds:Record<string,NanoModelVariant>={'nano-banana-pro':'pro','nano-banana-2':'2','nano-banana-2.1':'2.1'};

export function nanoModelInfo(model:NanoModelInput):NanoModelInfo {
  const info=modelVariantInfo(model),variant=info.family==='nano'&&info.variant?legacyIds[info.variant.id]:undefined;
  if(!variant)return {source:'unknown',title:'未识别型号',thinkingLevels:[]};
  return {variant,source:info.source,title:info.variant!.title,thinkingLevels:[...info.variant!.contract?.fields?.find(f=>f.key==='thinking_level')?.values??[]]};
}
