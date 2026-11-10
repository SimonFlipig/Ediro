import { z } from 'zod';
import { promptRoleSchema } from './prompt-roles.js';

export const referencePrecisionSchema = z.enum(['inherit','low','medium','high','ultra_high']);
export type ReferencePrecision = z.infer<typeof referencePrecisionSchema>;
export const referencePrecisionOptions: {value:ReferencePrecision;title:string}[] = [
  {value:'inherit',title:'跟随全局精度'}, {value:'low',title:'低'}, {value:'medium',title:'中'},
  {value:'high',title:'高'}, {value:'ultra_high',title:'超高（实验性）'},
];
export const referencePrecisionModules = [
  {type:'image_text',title:'图文'}, {type:'subject',title:'主体'}, {type:'composition',title:'构图'},
  {type:'style',title:'风格'}, {type:'viewpoint',title:'视角控制'},
] as const;
export type ReferencePrecisionModuleType = typeof referencePrecisionModules[number]['type'];

export const referenceSettingsSchema = z.object({
  max_edge: z.union([z.literal(1024), z.literal(512)]),
  preprocess: z.enum(['none','blur','depth','segment']).default('none'),
  blur_strength: z.enum(['weak','medium','strong']).default('medium'),
}).strict();
export type ReferenceSettings = z.infer<typeof referenceSettingsSchema>;
export type ReferenceModelStates = Record<'depth'|'segment','missing'|'ready'|'downloading'>;

export const moduleSettingsSchema = z.object({
  version: z.literal(1),
  composition: referenceSettingsSchema,
  style: referenceSettingsSchema,
  prompt: z.object({role:promptRoleSchema}).strict().default({role:'general'}),
  reference_precision: z.object({
    image_text:referencePrecisionSchema.optional(),subject:referencePrecisionSchema.optional(),
    composition:referencePrecisionSchema.optional(),style:referencePrecisionSchema.optional(),
    viewpoint:referencePrecisionSchema.optional(),
  }).strict().optional(),
}).strict();

export type ModuleSettings = z.infer<typeof moduleSettingsSchema>;

export const defaultModuleSettings: ModuleSettings = {
  version: 1,
  composition: { max_edge: 1024, preprocess: 'none', blur_strength: 'medium' },
  style: { max_edge: 1024, preprocess: 'none', blur_strength: 'medium' },
  prompt: { role: 'general' },
};

export function isReferenceModuleType(type:string):type is 'composition'|'style'{return type==='composition'||type==='style';}

// Module choices are project data. Defaults only fill legacy modules that have
// no explicit choice yet; parsing also returns a separate object for new modules.
export function resolveReferenceSettings(module:{reference_type:string;reference_settings?:ReferenceSettings},defaults:ModuleSettings=defaultModuleSettings):ReferenceSettings|undefined{
  if(!isReferenceModuleType(module.reference_type))return undefined;
  return referenceSettingsSchema.parse(module.reference_settings??defaults[module.reference_type]);
}
