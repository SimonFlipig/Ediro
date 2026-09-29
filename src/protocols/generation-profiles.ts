// Pure protocol declarations. No HTTP, UI, credentials or task ownership.
import { generationContractSchema } from '../core/generation-contract.js';
export const imagesProfile=generationContractSchema.parse({
  version:1,input_forms:['numbered_flat'],resolution_modes:['default','pixel_budget','exact'],pixel_budgets:[1048576,4194304,8294400],
  size_limits:{step:16,max_edge:3840,max_ratio:3,min_pixels:655360,max_pixels:8294400,default_pixels:1048576},
  size_presets:{'1:1':'1024x1024','3:2':'1536x1024','2:3':'1024x1536'},max_images:16,
  legacy_extension_key:'images_options',compatibility_editor:true,
  fields:[
    {key:'background',title:'输出背景',kind:'select',values:['auto','opaque','transparent'],value_labels:{auto:'自动',opaque:'不透明',transparent:'透明背景'},default:'auto',forbidden_values_by_format:{jpeg:['transparent']}},
    {key:'output_compression',title:'输出压缩率',kind:'number',integer:true,minimum:0,maximum:100,formats:['jpeg','webp'],default:100},
    {key:'moderation',title:'内容过滤',kind:'select',values:['auto','low'],value_labels:{auto:'标准',low:'较宽松'},default:'auto'},
  ],
});
export const geminiProfile=generationContractSchema.parse({
  quality_control:false,
  version:1,input_forms:['interleaved','numbered_flat'],resolution_modes:['default','tier'],tiers:['1K','2K','4K'],legacy_resolution_quality:true,legacy_extension_key:'gemini_options',
  features:['reference_overrides','google_search'],
  fields:[
    {key:'reference_precision',title:'参考图识别精度',kind:'select',values:['default','low','medium','high'],value_labels:{default:'模型默认',low:'低',medium:'中',high:'高'},default:'default',help:'控制输入细节读取，不改变输出分辨率；可能影响费用和耗时。'},
    {key:'reference_overrides',title:'逐图识别精度',kind:'references',values:['low','medium','high','ultra_high'],value_labels:{low:'低',medium:'中',high:'高',ultra_high:'超高（实验性）'},feature:'reference_overrides'},
    {key:'google_search',title:'网页搜索（可能另计费用）',kind:'boolean',feature:'google_search'},
    {key:'response_mode',title:'返回内容',kind:'select',values:['image','image_text'],value_labels:{image:'仅图片',image_text:'图片与文字'},default:'image_text'},
  ],
});
export const mockProfile=generationContractSchema.parse({version:1,input_forms:['interleaved','numbered_flat'],resolution_modes:['default']});
