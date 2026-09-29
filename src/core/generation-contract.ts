import { z } from 'zod';

export const inputStrategySchema=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export type InputStrategy=z.infer<typeof inputStrategySchema>;
export const resolutionSchema=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('default')}),
  z.object({mode:z.literal('tier'),value:z.string().min(1)}),
  z.object({mode:z.literal('pixel_budget'),pixels:z.number().int().positive()}),
  z.object({mode:z.literal('exact'),width:z.number().int().positive(),height:z.number().int().positive()}),
]);
const scalar=z.union([z.string(),z.number(),z.boolean()]);
export const extensionValueSchema=z.union([scalar,z.record(z.string(),z.string())]);
export const parameterFieldSchema=z.object({
  key:z.string(),title:z.string(),kind:z.enum(['select','number','boolean','references']),
  values:z.array(z.string()).optional(),minimum:z.number().optional(),maximum:z.number().optional(),
  value_labels:z.record(z.string(),z.string()).optional(),
  default:scalar.optional(),feature:z.string().optional(),help:z.string().optional(),
  required:z.boolean().optional(),integer:z.boolean().optional(),
  formats:z.array(z.string()).optional(),forbidden_values_by_format:z.record(z.string(),z.array(z.string())).optional(),
});
export type ParameterField=z.infer<typeof parameterFieldSchema>;
export const sizeLimitsSchema=z.object({step:z.number().int().positive(),max_edge:z.number().int().positive(),max_ratio:z.number().positive(),min_pixels:z.number().int().positive(),max_pixels:z.number().int().positive(),default_pixels:z.number().int().positive()});
export type SizeLimits=z.infer<typeof sizeLimitsSchema>;
export const parameterLimitSchema=z.object({enabled:z.boolean().optional(),values:z.array(z.string()).optional(),minimum:z.number().optional(),maximum:z.number().optional()});
export const generationContractSchema=z.object({
  version:z.literal(1),input_forms:z.array(z.enum(['interleaved','numbered_flat'])).min(1),
  resolution_modes:z.array(z.enum(['default','tier','pixel_budget','exact'])),
  tiers:z.array(z.string()).default([]),pixel_budgets:z.array(z.number().int().positive()).default([]),
  size_limits:sizeLimitsSchema.optional(),size_presets:z.record(z.string(),z.string()).optional(),
  fields:z.array(parameterFieldSchema).default([]),features:z.array(z.string()).default([]),
  legacy_resolution_quality:z.boolean().default(false),legacy_extension_key:z.string().optional(),
  quality_control:z.boolean().default(true),
  compatibility_editor:z.boolean().optional(),max_images:z.number().int().nonnegative().optional(),
});
export type GenerationContract=z.infer<typeof generationContractSchema>;
export const diagnosticSchema=z.object({code:z.string(),severity:z.enum(['info','warning']),message:z.string()});
export const planSummarySchema=z.object({version:z.literal(1),operation:z.enum(['generate','referenceEdit','nativeMaskEdit','guidedMaskEdit','understand']),requested_strategy:inputStrategySchema,actual_strategy:inputStrategySchema,contract:generationContractSchema,model_revision:z.number(),adapter_version:z.number(),diagnostics:z.array(diagnosticSchema)});
export type PlanSummary=z.infer<typeof planSummarySchema>;

export function validSize(w:number,h:number,limits:SizeLimits){
  return Number.isInteger(w)&&Number.isInteger(h)&&w>0&&h>0&&w%limits.step===0&&h%limits.step===0&&Math.max(w,h)<=limits.max_edge&&Math.max(w/h,h/w)<=limits.max_ratio&&w*h>=limits.min_pixels&&w*h<=limits.max_pixels;
}
