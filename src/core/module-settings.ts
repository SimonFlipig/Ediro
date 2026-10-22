import { z } from 'zod';
import { promptRoleSchema } from './prompt-roles.js';

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
