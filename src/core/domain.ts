import { z } from 'zod';
import {MAX_GEMINI_REQUEST_MB} from './image-limits.js';
import type { OutputGeometry } from './output-geometry.js';
import type { ModuleInferenceTask } from './module-inference-tasks.js';
import { promptConfigSchema,modelNameSchema,type PromptConfig } from './prompt-config.js';
import { generationContractSchema,inputStrategySchema,resolutionSchema,extensionValueSchema,parameterLimitSchema,sizeLimitsSchema,type PlanSummary,type SizeLimits,type ParameterField } from './generation-contract.js';

export const idSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{1,95}$/);
const text = z.string().max(32000);
export const moduleSchema = z.object({
  module_id: idSchema,
  reference_type: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  reference_id: idSchema,
  title: z.string().min(1).max(80),
  enabled: z.boolean(),
  base_instruction: text,
  numbered_instruction:text.optional(),
  model_name:modelNameSchema.optional(),
  user_instruction: text,
  asset_ids: z.array(idSchema).max(64),
  // Future interactive reference tools own their state, not model adapters.
  tool_state: z.record(z.string(), z.unknown()).optional(),
});
export type SemanticModule = z.infer<typeof moduleSchema>;

export const parametersSchema = z.object({
  version:z.literal(2).optional(),
  resolution:resolutionSchema.optional(),
  extensions:z.record(z.string(),z.record(z.string(),extensionValueSchema)).optional(),
  aspect_ratio: z.string().max(20),
  quality: z.string().max(30),
  output_format: z.enum(['png', 'jpeg', 'webp']),
  count: z.number().int().min(1).max(10),
  output_resolution:z.enum(['default','1MP','4MP','8MP','custom']).optional(),
  output_width:z.number().int().positive().optional(),
  output_height:z.number().int().positive().optional(),
  image_size:z.enum(['1K','2K','4K']).optional(),
  images_options:z.object({
    background:z.enum(['auto','opaque','transparent']).optional(),
    output_compression:z.number().int().min(0).max(100).optional(),
    moderation:z.enum(['auto','low']).optional(),
  }).strict().optional(),
  gemini_options:z.object({
    reference_precision:z.enum(['default','low','medium','high']).optional(),
    reference_overrides:z.record(idSchema,z.enum(['low','medium','high','ultra_high'])).optional(),
    google_search:z.boolean().optional(),
    response_mode:z.enum(['image','image_text']).optional(),
  }).strict().optional(),
}).strict().superRefine((p,ctx)=>{
  if(p.version===2&&['output_resolution','output_width','output_height','image_size','images_options','gemini_options'].some(k=>(p as Record<string,unknown>)[k]!==undefined))ctx.addIssue({code:'custom',message:'新版参数不能混入旧版字段。'});
});
export type Parameters = z.infer<typeof parametersSchema>;
export const recipeSchema = z.object({
  input_strategy:inputStrategySchema.optional(),
  prompt_config:promptConfigSchema.optional(),
  recipe_id: idSchema,
  schema_version: z.literal(1),
  modules: z.array(moduleSchema).min(1).max(40),
  model_config_id: idSchema,
  model_preset_id: z.string().optional(),
  core_parameters: parametersSchema,
  model_parameters: z.record(z.string(),parametersSchema).optional(),
  model_channels: z.record(z.string(),idSchema).optional(),
}).superRefine((r, ctx) => {
  if (!r.modules.some(m => m.reference_type === 'prompt' && m.enabled)) {
    ctx.addIssue({ code: 'custom', message: '必须至少保留一个启用的提示词模块。' });
  }
  for (const key of ['module_id', 'reference_id'] as const) {
    if (new Set(r.modules.map(m => m[key])).size !== r.modules.length) {
      ctx.addIssue({ code: 'custom', message: `${key} 必须唯一；复制模块也需要新 ID。` });
    }
  }
});
export type Recipe = z.infer<typeof recipeSchema>;

export interface ModuleDefinition {
  inference_task?: ModuleInferenceTask;
  tool_fields?:ParameterField[];
  model_name?:string;
  type: string;
  title: string;
  description: string;
  base_instruction: string;
  numbered_instruction?:string;
  editor_kind: 'text' | 'image_collection' | 'generated_reference';
  accepts_images: boolean;
  default_tool_state?: Record<string, unknown>;
}
export type Block =
  | { type: 'text'; text: string; numbered_text?:string; text_role?:'instruction'|'header'|'user'|'image_label'; model_name?:string; source_module_id: string; reference_type: string; reference_id: string }
  | { type: 'image'; asset_id: string; image_name?:string; model_name?:string; source_module_id: string; reference_type: string; reference_id: string };
export interface CompiledChain { format_version?:2; prompt_config?:PromptConfig; blocks: Block[]; mode: 'text_to_image' | 'reference_generation' }
export interface Asset {
  asset_id: string;
  name: string;
  location: { type: 'managed'; relative_path: string } | { type: 'external'; path: string; sha256: string; size: number; modified_at: number };
  thumbnail_path: string;
  width: number;
  height: number;
  mime_type: string;
  created_at: string;
  kind: 'import' | 'output' | 'generated';
  hidden_from_materials?: boolean;
  removed_result?: boolean;
  hidden_from_results?: boolean;
}
export interface Capabilities {
  features?:string[];
  input_forms?:('interleaved'|'numbered_flat')[];
  parameter_limits?:Record<string,z.infer<typeof parameterLimitSchema>>;
  size_limits?:SizeLimits;
  interleaving: 'native' | 'separated' | 'mediated';
  max_images: number;
  aspect_ratios: string[];
  qualities: string[];
  formats: Parameters['output_format'][];
  max_count: number;
  operations: string[];
  disabled_operations?: string[];
}
export const imagesCompatibilitySchema=z.object({
  format_field:z.enum(['output_format','format']).default('output_format'),
  image_field:z.enum(['image[]','image']).default('image[]'),
  send_response_format:z.boolean().default(false),
  max_prompt_chars:z.number().int().min(1).max(32000).default(32000),
  max_image_mb:z.number().int().min(1).max(50).optional(),
  max_request_mb:z.number().int().min(1).max(100).optional(),
});
export const defaultImagesCompatibility=imagesCompatibilitySchema.parse({});
export const geminiCompatibilitySchema=z.object({
  max_request_mb:z.number().int().min(1).max(MAX_GEMINI_REQUEST_MB).optional(),
});
export const modelConfigSchema = z.object({
  preset_id:z.string().optional(),
  legacy_defaults_pending:z.boolean().optional(),
  model_config_id: idSchema,
  title: z.string().min(1).max(100),
  kind: z.enum(['cloud', 'local', 'mock']),
  provider: z.string().min(1).max(60),
  model: z.string().min(1).max(100),
  adapter_id: z.string().min(1).max(80),
  images_compatibility:imagesCompatibilitySchema.optional(),
  gemini_compatibility:geminiCompatibilitySchema.optional(),
  endpoint: z.string().max(500).refine(v => !v || (() => {
    try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; }
    catch { return false; }
  })(), '端点必须为不含凭据、查询参数的 HTTPS 地址。'),
  enabled: z.boolean(),
  executable: z.boolean(),
  revision: z.number().int().min(1),
  credential_ref: idSchema.optional(),
  capabilities: z.object({
    features:z.array(z.string()).optional(),
    input_forms:z.array(z.enum(['interleaved','numbered_flat'])).optional(),
    parameter_limits:z.record(z.string(),parameterLimitSchema).optional(),
    size_limits:sizeLimitsSchema.optional(),
    interleaving: z.enum(['native', 'separated', 'mediated']),
    max_images: z.number().int().min(0).max(100),
    aspect_ratios: z.array(z.string()).min(1),
    qualities: z.array(z.string()).min(1),
    formats: z.array(z.enum(['png', 'jpeg', 'webp'])).min(1),
    max_count: z.number().int().min(1).max(10),
    operations: z.array(z.string()),
    disabled_operations: z.array(z.string()).optional(),
  }),
  defaults: parametersSchema,
  generation_contract:generationContractSchema.optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema> & { geometry_support?:'ratio'|'size'|'free_ratio'; connection_id?: string; connection_revision?: number; adapter_version?: number; purpose?: 'generation' | 'understanding'; capability_source?: 'documented' | 'user' | 'tested'; validation?: {test_id:string;model_revision:number;connection_revision:number;adapter_version:number;checked_at:string;operation:'understand'}; validation_status?:'untested'|'passed'|'stale' };
export type PublicModel = Omit<ModelConfig, 'credential_ref'> & { has_credential: boolean; readiness_error?:string; declared_capabilities?:Capabilities; unavailable_operations?:string[] };
export type JobStatus = 'queued' | 'preparing' | 'running' | 'post_processing' | 'succeeded' | 'failed' | 'cancelled';
export interface AdaptedInput {
  kind: 'native_blocks' | 'separated_inputs';
  blocks?: Block[];
  prompt?: string;
  image_asset_ids?: string[];
  adjustments: string[];
}
export interface Job {
  mask_edit?: import('./mask.js').MaskEdit;
  execution_plan?:PlanSummary;
  output_geometry?:OutputGeometry;
  recoverable_result?:boolean;
  execution_summary?: { adapter_version:number; capabilities:Capabilities; text?:string; request_id?:string; usage?:Record<string,number>; fee:'unknown'; actual_formats:Parameters['output_format'][] };
  task_id: string;
  status: JobStatus;
  stage: string;
  progress: number;
  created_at: string;
  finished_at?: string;
  error?: string;
  recipe_snapshot: Recipe;
  chain_snapshot: CompiledChain;
  // Non-sensitive resolved config: credentials/endpoint are not UI history.
  model_snapshot: Pick<ModelConfig, 'model_config_id' | 'preset_id' | 'title' | 'provider' | 'model' | 'adapter_id' | 'revision' | 'kind' | 'images_compatibility' | 'gemini_compatibility'>;
  adapted_input: AdaptedInput;
  output_asset_ids: string[];
}
export interface Revision {
  revision_id: string;
  asset_id: string;
  parent_revision_id?: string;
  task_id: string;
  created_at: string;
}
export interface Project {
  storage_version?:1;
  mask_drafts?: import('./mask.js').MaskDraft[];
  schema_version: 2 | 3;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  recipe: Recipe;
  assets: Asset[];
  jobs: Job[];
  revisions: Revision[];
}
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
export const defaultParameters: Parameters = { aspect_ratio: '1:1', quality: 'standard', output_format: 'png', count: 1 };

export interface LocalOperationRequest {
  project_id: string;
  model_config_id: string;
  source_revision_id: string;
  operation_type: 'erase' | 'inpaint';
  mask_asset_id: string;
  instruction: string;
}
export interface LocalEnginePort {
  execute(request: LocalOperationRequest, signal: AbortSignal): Promise<{ asset_id: string }>;
}
