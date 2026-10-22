import { generationContractSchema } from '../core/generation-contract.js';

// Compatibility settings describe the wire protocol, not a particular model's abilities.
export const chatProfile=generationContractSchema.parse({
  version:1,input_forms:['interleaved','numbered_flat'],resolution_modes:['default'],quality_control:false,
  fields:[
    {key:'temperature',title:'温度',kind:'number',minimum:0,maximum:2,help:'留空使用模型默认值；部分推理模型不接受温度参数。'},
    {key:'reasoning_effort',title:'推理强度',kind:'select',values:['low','medium','high'],value_labels:{low:'低',medium:'中',high:'高'},help:'仅在渠道和模型明确支持时设置。'},
    {key:'max_output_tokens',title:'最大输出 Token',kind:'number',integer:true,minimum:1,maximum:32768,default:16384,help:'推理任务会进一步限制输出上限；部分模型会将思考 Token 计入此预算。'},
    {key:'token_limit_field',title:'输出上限兼容方式',kind:'select',values:['max_completion_tokens','max_tokens'],value_labels:{max_completion_tokens:'标准（max_completion_tokens）',max_tokens:'旧版兼容（max_tokens）'},default:'max_completion_tokens',help:'仅在渠道要求时切换，不会在失败后自动重试。'},
    {key:'image_detail',title:'图片识别精度',kind:'select',values:['auto','low','high'],value_labels:{auto:'自动',low:'低',high:'高'},help:'留空使用接口默认值；仅支持图片的模型可用。'},
  ],
});
