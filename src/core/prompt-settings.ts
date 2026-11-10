import { z } from 'zod';
import { customizableModuleTypeSchema, emptyPromptCustomizations, moduleInstructionOverridesSchema, promptCustomizationsSchema, type PromptCustomizations } from './prompt-customization.js';
import { promptRoleSchema } from './prompt-roles.js';
import { moduleInferenceInstructionsSchema } from './module-inference-instructions.js';

const presetId=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/,'预设 ID 格式无效。');
const presetName=z.string().trim().min(1,'请输入预设名称。').max(80,'预设名称不能超过 80 个字符。');

export const moduleInstructionPresetSchema=z.object({
  id:presetId,
  name:presetName,
  module:customizableModuleTypeSchema,
  instructions:moduleInstructionOverridesSchema,
}).strict().superRefine((preset,context)=>{
  const result=promptCustomizationsSchema.safeParse({version:1,modules:{[preset.module]:preset.instructions},roles:{}});
  if(!result.success)for(const issue of result.error.issues)context.addIssue({code:'custom',path:['instructions',...issue.path.slice(2)],message:issue.message});
});
export type ModuleInstructionPreset=z.infer<typeof moduleInstructionPresetSchema>;

export const roleInstructionPresetSchema=z.object({
  id:presetId,
  name:presetName,
  role:promptRoleSchema,
  instruction:z.string().max(32000).optional(),
}).strict();
export type RoleInstructionPreset=z.infer<typeof roleInstructionPresetSchema>;
export const inferenceInstructionPresetSchema=z.object({
  id:presetId,
  name:presetName,
  kind:z.literal('inference'),
  module:customizableModuleTypeSchema,
  instruction:z.string().max(32000).optional(),
}).strict();
export type InferenceInstructionPreset=z.infer<typeof inferenceInstructionPresetSchema>;
export const instructionPresetSchema=z.union([moduleInstructionPresetSchema,roleInstructionPresetSchema,inferenceInstructionPresetSchema]);
export type InstructionPreset=z.infer<typeof instructionPresetSchema>;
export function presetTarget(preset:InstructionPreset){
  if('kind' in preset)return `inference:${preset.module}` as const;
  return 'module' in preset?preset.module:preset.role;
}

export const promptPresetLibrarySchema=z.array(instructionPresetSchema).max(200,'最多保存 200 个指令预设。').superRefine((presets,context)=>{
  const ids=new Set<string>(),names=new Set<string>();
  presets.forEach((preset,index)=>{
    if(ids.has(preset.id))context.addIssue({code:'custom',path:[index,'id'],message:'预设 ID 不能重复。'});
    ids.add(preset.id);
    const nameKey=`${presetTarget(preset)}\0${preset.name}`;
    if(names.has(nameKey))context.addIssue({code:'custom',path:[index,'name'],message:'同一指令项不能使用重复的预设名称。'});
    names.add(nameKey);
  });
});

export const promptSettingsSchema=z.object({
  version:z.literal(2),
  customizations:promptCustomizationsSchema,
  inference_instructions:moduleInferenceInstructionsSchema.optional(),
  presets:promptPresetLibrarySchema,
  selected_presets:z.object({
    subject:presetId.optional(),composition:presetId.optional(),style:presetId.optional(),viewpoint:presetId.optional(),general:presetId.optional(),merchandiser:presetId.optional(),
    'inference:subject':presetId.optional(),'inference:composition':presetId.optional(),'inference:style':presetId.optional(),'inference:viewpoint':presetId.optional(),
  }).strict(),
}).strict().superRefine((settings,context)=>{
  for(const [target,id] of Object.entries(settings.selected_presets)){
    if(id===undefined)continue;
    const preset=settings.presets.find(preset=>preset.id===id);
    if(!preset||presetTarget(preset)!==target)context.addIssue({code:'custom',path:['selected_presets',target],message:'所选预设不存在或不属于此指令项。'});
  }
});
export type PromptSettingsDocument=z.infer<typeof promptSettingsSchema>;
export const promptSettingsImportSchema=z.union([promptCustomizationsSchema,promptSettingsSchema]);
export type PromptSettingsImport=z.infer<typeof promptSettingsImportSchema>;

export function createPromptSettings(customizations:PromptCustomizations=emptyPromptCustomizations):PromptSettingsDocument{
  return promptSettingsSchema.parse({version:2,customizations,presets:[],selected_presets:{}});
}

export function mergeImportedPromptSettings(current:PromptSettingsDocument,input:PromptSettingsImport):PromptSettingsDocument{
  const imported=promptSettingsImportSchema.parse(input);
  if(imported.version===2)return imported;
  // Legacy documents replace only their generation/role overrides. They carry
  // no library or module-inference settings, so retain those settings and links.
  const settings=promptSettingsSchema.parse(current);
  const selected_presets=Object.fromEntries(Object.entries(settings.selected_presets).filter(([target])=>target.startsWith('inference:')));
  return promptSettingsSchema.parse({...settings,customizations:imported,selected_presets});
}
