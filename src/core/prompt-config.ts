import { z } from 'zod';

// User-facing model labels are prose, not registry identifiers.
export const modelNameSchema=z.string().min(1).max(80).refine(value=>value.trim().length>0&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value),'模型语义名需为 1～80 个字符的单行文字。');

function template(tokens:string[]){return z.string().max(32000).refine(value=>!/[{}]/.test(tokens.reduce((text,token)=>text.split(`{${token}}`).join(''),value)),'模板包含未知或不完整的占位符。');}
const modulePrompts=z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),z.object({
  model_name:modelNameSchema.optional(),
  header:z.boolean().optional(),native_instruction:template(['images','viewpoint']).optional(),
  numbered_instruction:template(['images','viewpoint']).optional(),
}).strict()).superRefine((modules,context)=>{
  for(const [type,options] of Object.entries(modules)){
    if(type==='viewpoint')continue;
    for(const key of ['native_instruction','numbered_instruction'] as const){
      if(options[key]?.includes('{viewpoint}'))context.addIssue({code:'custom',path:[type,key],message:'{viewpoint} 仅可用于视角模块。'});
    }
  }
});
const commonFields={
  revision:z.string().min(1).max(100),
  module_header:template(['module','images']),image_label:template(['image']),
  image_separator:z.string().max(100),
  modules:modulePrompts,
};
const legacyPromptConfigSchema=z.object({...commonFields,version:z.literal(1),text_separator:z.string().max(100)}).strict();
export const currentPromptConfigSchema=z.object({
  ...commonFields,version:z.literal(2),
  module_header:template(['module','images','module_number']),
  intra_module_separator:z.string().max(100),
  inter_module_separator:z.string().max(100),
}).strict();
// Stored snapshots retain their original version; only active editing/execution migrates.
export const promptConfigSchema=z.discriminatedUnion('version',[legacyPromptConfigSchema,currentPromptConfigSchema]);
export type PromptConfig=z.infer<typeof promptConfigSchema>;
export type CurrentPromptConfig=z.infer<typeof currentPromptConfigSchema>;
export const defaultPromptConfig:CurrentPromptConfig={version:2,revision:'ediro-input-v3',module_header:'{module}:',image_label:'{image}',image_separator:', ',intra_module_separator:'\n',inter_module_separator:'\n\n',modules:{prompt:{header:false},image_text:{header:false}}};
export function normalizePromptConfig(input:unknown):CurrentPromptConfig{
  const config=promptConfigSchema.parse(input);
  if(config.version===2)return config;
  const {version,text_separator,...rest}=config;
  return {...rest,version:2,
    intra_module_separator:text_separator==='\n\n'?'\n':text_separator,
    inter_module_separator:text_separator};
}
export function renderPromptTemplate(template:string,values:Record<string,string>){return template.replace(/\{([a-z_]+)\}/g,(_match,key:string)=>values[key]??'');}
