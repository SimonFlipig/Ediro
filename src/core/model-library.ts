import { z } from 'zod';
import { idSchema, modelConfigSchema, parametersSchema, newId, type ModelConfig } from './domain.js';
import { mockProfile } from '../protocols/generation-profiles.js';
import type { GenerationContract } from './generation-contract.js';

export const connectionSchema = modelConfigSchema.pick({ endpoint: true, enabled: true, revision: true, credential_ref: true }).extend({ connection_id: idSchema, title: z.string().trim().min(1).max(100),adapter_id:z.string().optional() });
export const modelEntrySchema = modelConfigSchema.omit({ endpoint: true, credential_ref: true, executable: true }).extend({
  validation:z.object({test_id:idSchema,model_revision:z.number().int(),connection_revision:z.number().int(),adapter_version:z.number().int(),checked_at:z.string(),operation:z.literal('understand')}).optional(),
  connection_id: idSchema.optional(), purpose: z.enum(['generation', 'understanding']).default('generation'),
  capability_source: z.enum(['documented', 'user', 'tested']).default('documented'),
});
export const librarySchema = z.object({ schema_version: z.union([z.literal(1),z.literal(2),z.literal(3)]), defaults_by_model:z.record(z.string(),parametersSchema).optional(), connections: z.array(connectionSchema).max(200), models: z.array(modelEntrySchema).max(1000), assignments: z.object({ generation_default: idSchema, understanding_default: idSchema.optional(), editing_default:idSchema.optional() }) }).superRefine((data, ctx) => {
  for (const [items, key] of [[data.connections, 'connection_id'], [data.models, 'model_config_id']] as const) {
    if (new Set(items.map(item => (item as unknown as Record<string,string>)[key])).size !== items.length) ctx.addIssue({ code: 'custom', message: '模型库身份重复。' });
  }
  for (const model of data.models) {
    if (model.kind === 'cloud' && !data.connections.some(c => c.connection_id === model.connection_id)) ctx.addIssue({ code: 'custom', message: '云端模型缺少有效连接。' });
    if (model.kind !== 'cloud' && model.connection_id) ctx.addIssue({ code: 'custom', message: '本地或模拟模型不应绑定远端连接。' });
  }
  if(data.assignments.editing_default&&!data.models.some(m=>m.model_config_id===data.assignments.editing_default&&m.purpose==='generation'))ctx.addIssue({code:'custom',message:'默认编辑模型不存在或用途不匹配。'});
  for (const purpose of ['generation','understanding'] as const) {
    const id = data.assignments[`${purpose}_default`];
    if (id && !data.models.some(m => m.model_config_id === id && m.purpose === purpose)) ctx.addIssue({ code: 'custom', message: '默认功能模型不存在或用途不匹配。' });
  }
});
export type Connection = z.infer<typeof connectionSchema>;
export type PublicConnection = Omit<Connection,'credential_ref'> & { has_credential: boolean };
export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type LibraryData = z.infer<typeof librarySchema>;
export interface AdapterDescription {
  generation_contract?:GenerationContract;
  geometry_support?:'ratio'|'size'|'free_ratio';
  adapter_id: string; version: number; title: string; kind: ModelConfig['kind']; installed: boolean;
  purposes: ModelEntry['purpose'][]; requires_credential: boolean; supports_probe: boolean;
  interleaving: ModelConfig['capabilities']['interleaving'][]; operations: string[];
  parameters: { key: string; title: string; values?: string[]; maximum?: number }[];
}
export const mockDescription: AdapterDescription = { generation_contract:mockProfile,geometry_support:'free_ratio',adapter_id:'mock',version:2,title:'模拟执行',kind:'mock',installed:true,purposes:['generation'],requires_credential:false,supports_probe:false,interleaving:['native','separated'],operations:['generate','nativeMaskEdit'],parameters:[] };
export function migrateModels(models: ModelConfig[]): LibraryData {
  const ids=new Map(models.filter(m=>m.kind==='cloud').map(m=>[m.model_config_id,newId('connection')]));
  return librarySchema.parse({ schema_version:1, connections:models.filter(m=>m.kind==='cloud').map(m=>({ connection_id:ids.get(m.model_config_id),title:`${m.title.slice(0,90)} · 连接`,endpoint:m.endpoint,enabled:true,revision:m.revision,credential_ref:m.credential_ref })),
    models:models.map(({ endpoint,credential_ref,executable,...model })=>({ ...model,...(model.kind==='cloud'?{connection_id:ids.get(model.model_config_id)}:{}) })),assignments:{generation_default:models.find(m=>m.kind==='mock')?.model_config_id??models[0]?.model_config_id} });
}
