import { z } from 'zod';
import { normalizePromptConfig, type CurrentPromptConfig } from './prompt-config.js';

export const customizableModuleTypeSchema=z.enum(['subject','composition','style','viewpoint']);
export type CustomizableModuleType=z.infer<typeof customizableModuleTypeSchema>;
export const customizableModuleTypes=customizableModuleTypeSchema.options;

const instruction=z.string().max(32000);
const template=instruction.refine(value=>!/[{}]/.test(value.replaceAll('{images}','').replaceAll('{viewpoint}','')),'模板只能使用完整的 {images} 或 {viewpoint} 占位符。');
export const moduleInstructionOverridesSchema=z.object({
  native_instruction:template.optional(),
  numbered_instruction:template.optional(),
}).strict();
export type ModuleInstructionOverrides=z.infer<typeof moduleInstructionOverridesSchema>;
export const roleInstructionsSchema=z.object({general:instruction.optional(),merchandiser:instruction.optional()}).strict();
export type RoleInstructions=z.infer<typeof roleInstructionsSchema>;

// This portable document contains user overrides only. Omission means use the
// installed version's default; an explicit empty string disables that text.
export const promptCustomizationsSchema=z.object({
  version:z.literal(1),
  modules:z.object({
    subject:moduleInstructionOverridesSchema.optional(),
    composition:moduleInstructionOverridesSchema.optional(),
    style:moduleInstructionOverridesSchema.optional(),
    viewpoint:moduleInstructionOverridesSchema.optional(),
  }).strict(),
  roles:roleInstructionsSchema,
}).strict().superRefine((value,context)=>{
  for(const type of customizableModuleTypes){
    if(type==='viewpoint')continue;
    const entry=value.modules[type];
    for(const key of ['native_instruction','numbered_instruction'] as const){
      if(entry?.[key]?.includes('{viewpoint}'))context.addIssue({code:'custom',path:['modules',type,key],message:'{viewpoint} 仅可用于视角指令。'});
    }
  }
});
export type PromptCustomizations=z.infer<typeof promptCustomizationsSchema>;
export const emptyPromptCustomizations:PromptCustomizations={version:1,modules:{},roles:{}};

export function applyPromptCustomizations(base:CurrentPromptConfig,input:PromptCustomizations):CurrentPromptConfig{
  const customizations=promptCustomizationsSchema.parse(input),config=structuredClone(base);
  for(const type of customizableModuleTypes){
    const overrides=customizations.modules[type];
    if(overrides)config.modules[type]={...config.modules[type],...overrides};
  }
  return normalizePromptConfig(config);
}
