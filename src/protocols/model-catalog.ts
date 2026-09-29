import { modelConfigSchema, type ModelConfig, type Parameters } from '../core/domain.js';
import { generationContractSchema } from '../core/generation-contract.js';
import { geminiProfile, imagesProfile } from './generation-profiles.js';

// Reviewed model data, separate from transport capabilities and channel aliases.
// Sources checked 2026-09-22; shortcuts are not advertised as API enum values.
const ratios=['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];
const base:Parameters={version:2,aspect_ratio:'auto',quality:'standard',output_format:'png',count:1,resolution:{mode:'default'},extensions:{}};
export const reasoningProfile=generationContractSchema.parse({version:1,input_forms:['interleaved','numbered_flat'],resolution_modes:['default'],quality_control:false,features:['google_search','reference_overrides'],fields:[
  {key:'temperature',title:'温度',kind:'number',minimum:0,maximum:2,default:1,help:'Gemini 3 官方建议保持 1.0。'},
  {key:'thinking_level',title:'思考强度',kind:'select',values:['low','medium','high'],value_labels:{low:'低',medium:'中',high:'高'},default:'high'},
  {key:'reference_precision',title:'图片识别精度',kind:'select',values:['default','low','medium','high'],value_labels:{default:'接口默认',low:'低',medium:'中',high:'高'},default:'default'},
  {key:'google_search',title:'网页搜索（可能另计费用）',kind:'boolean',feature:'google_search',default:false},
  {key:'reference_overrides',title:'逐图识别精度',kind:'references',values:['low','medium','high','ultra_high'],feature:'reference_overrides'},
]});
export interface ModelPreset {id:string;title:string;family:'nano'|'gpt-image'|'reasoning';purpose:'generation'|'understanding';aliases:string[];source:string;config:Pick<ModelConfig,'provider'|'adapter_id'|'capabilities'|'defaults'|'generation_contract'>}
function images(id:string,title:string,aliases:string[],extraQuality:boolean):ModelPreset{return {id,title,family:'gpt-image',purpose:'generation',aliases,source:'https://developers.openai.com/api/docs/guides/image-generation',config:{provider:'openai',adapter_id:'openai-images',generation_contract:imagesProfile,capabilities:{interleaving:'separated',max_images:16,aspect_ratios:ratios,qualities:['auto','low','medium','high',...(extraQuality?['xhigh','max']:[])],formats:['png','jpeg','webp'],max_count:10,operations:['generate','referenceEdit','nativeMaskEdit']},defaults:{...base,quality:'auto',extensions:{'openai-images':{background:'auto',moderation:'auto'}}}}};}
export const modelCatalog:ModelPreset[]=[
  {id:'nano-banana-pro',title:'Nano Banana Pro',family:'nano',purpose:'generation',aliases:['gemini-3-pro-image','gemini-3-pro-image-preview'],source:'https://ai.google.dev/gemini-api/docs/generate-content/image-generation',config:{provider:'google',adapter_id:'gemini-generate-content',generation_contract:geminiProfile,capabilities:{interleaving:'native',max_images:14,aspect_ratios:ratios,qualities:['1K','2K','4K'],formats:['png'],max_count:1,operations:['generate','referenceEdit','guidedMaskEdit'],features:['google_search','reference_overrides']},defaults:{...base,resolution:{mode:'tier',value:'1K'},extensions:{'gemini-generate-content':{reference_precision:'default',google_search:false,response_mode:'image_text'}}}}},
  images('gpt-image-2-5-sunburst','GPT Image 2.5 Sunburst',['gpt-image-2.5-sunburst','gpt-image-2.5-sunburst-2026-09-08'],true),
  images('gpt-image-2-5-flare','GPT Image 2.5 Flare',['gpt-image-2.5-flare','gpt-image-2.5-flare-2026-09-08'],true),
  images('gpt-image-2','GPT Image 2',['gpt-image-2','gpt-image-2-2026-04-21'],false),
  {id:'gemini-3-1-pro',title:'Gemini 3.1 Pro',family:'reasoning',purpose:'understanding',aliases:['gemini-3.1-pro','gemini-3.1-pro-preview'],source:'https://ai.google.dev/gemini-api/docs/gemini-3',config:{provider:'google',adapter_id:'gemini-generate-content',generation_contract:reasoningProfile,capabilities:{interleaving:'native',max_images:64,aspect_ratios:['auto'],qualities:['standard'],formats:['png'],max_count:1,operations:['understand'],features:['google_search']},defaults:{...base,extensions:{'gemini-generate-content':{temperature:1,thinking_level:'high',reference_precision:'default',google_search:false}}}}},
];
export function findPreset(id?:string){return modelCatalog.find(p=>p.id===id);}
export function identifyPreset(model:string){const id=model.trim().replace(/^models\//,'').toLowerCase();return modelCatalog.find(p=>p.aliases.includes(id));}
export function modelFromPreset(presetId:string,id:string,connectionId:string,remoteId:string):ModelConfig {
  const p=findPreset(presetId);if(!p)throw new Error('请选择具体模型预设。');
  return {...modelConfigSchema.parse({...structuredClone(p.config),preset_id:p.id,model_config_id:id,title:p.title,model:remoteId.trim(),kind:'cloud',endpoint:'',enabled:true,executable:false,revision:1}),purpose:p.purpose,connection_id:connectionId,capability_source:'documented'};
}
export function modelIdentity(model:Pick<ModelConfig,'model_config_id'|'preset_id'|'legacy_defaults_pending'>){return model.legacy_defaults_pending?model.model_config_id:model.preset_id??model.model_config_id;}
