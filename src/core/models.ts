import { type ModelConfig, type PublicModel } from './domain.js';
import { librarySchema, migrateModels, mockDescription, modelEntrySchema, connectionSchema, type LibraryData, type Connection, type ModelEntry, type AdapterDescription } from './model-library.js';
export { seedModels } from '../protocols/model-presets.js';
import { newId } from './domain.js';
import { maskEditMethod } from './mask-request.js';
import { normalizeParameters,validateGenerationParameters } from './generation-parameters.js';
import type { ModelTestRecord } from './model-tests.js';
import { findPreset } from '../protocols/model-catalog.js';
import { migrateModelSettings, snapshotParameters } from './model-settings.js';

export interface SecretStore {
  has(ref: string): Promise<boolean>;
  set(ref: string, value: string): Promise<void>;
  resolve?(ref:string):Promise<string>;
}
export class ModelLibrary {
  private data: LibraryData;
  constructor(data: ModelConfig[] | LibraryData, private persist: (data: LibraryData) => Promise<void>, private secrets: SecretStore, readonly adapters: AdapterDescription[] = [mockDescription]) { this.data = migrateModelSettings(librarySchema.parse(Array.isArray(data) ? migrateModels(data) : data)); }
  snapshot() { return structuredClone(this.data); }
  defaultModel() { return this.data.assignments.generation_default; }
  private async save(data: LibraryData) { const parsed = librarySchema.parse(data); await this.persist(parsed); this.data = parsed; }
  resolve(id: string) {
    const m = this.data.models.find(m => m.model_config_id === id);
    if (!m) throw new Error('模型配置不存在，请在本机模型库重新绑定。');
    if (!m.enabled) throw new Error('模型配置已停用。');
    const c = this.data.connections.find(c => c.connection_id === m.connection_id);
    const a = this.adapters.find(a => a.adapter_id === m.adapter_id);
    const valid = !!a?.installed && a.kind === m.kind && a.purposes.includes(m.purpose);
    const capabilities=structuredClone(m.capabilities);
    const declaredPreset=findPreset(m.preset_id);
    // A channel's other manual settings do not opt out of newly added preset abilities.
    // Keep explicit per-operation opt-outs separate from capability provenance.
    for(const operation of ['nativeMaskEdit','guidedMaskEdit'])if(m.purpose==='generation'&&declaredPreset?.config.adapter_id===m.adapter_id&&declaredPreset.config.capabilities.operations.includes(operation)&&!capabilities.operations.includes(operation))capabilities.operations.push(operation);
    capabilities.operations=capabilities.operations.filter(op=>a?.operations.includes(op)&&!capabilities.disabled_operations?.includes(op));
    if(m.purpose==='understanding'&&a?.operations.includes('understand')&&!capabilities.operations.includes('understand'))capabilities.operations.push('understand');

    for(const p of m.purpose==='understanding'?[]:a?.parameters??[]){if(p.key==='aspect_ratio'&&p.values)capabilities.aspect_ratios=capabilities.aspect_ratios.filter(v=>p.values!.includes(v));if(p.key==='quality'&&p.values)capabilities.qualities=capabilities.qualities.filter(v=>p.values!.includes(v));if(p.key==='output_format'&&p.values)capabilities.formats=capabilities.formats.filter(v=>p.values!.includes(v));if(p.key==='count'&&p.maximum)capabilities.max_count=Math.min(capabilities.max_count,p.maximum);}
    const preset=findPreset(m.preset_id);
    const generation_contract=structuredClone(preset?.config.adapter_id===m.adapter_id?preset.config.generation_contract:a?.generation_contract??m.generation_contract);
    if(generation_contract){
      generation_contract.features=generation_contract.features.filter(f=>(m.capabilities.features??[]).includes(f));
      if(generation_contract.legacy_resolution_quality)generation_contract.tiers=generation_contract.tiers.filter(v=>capabilities.qualities.includes(v));
      if(generation_contract.max_images!==undefined)capabilities.max_images=Math.min(capabilities.max_images,generation_contract.max_images);
    }
    const validation_status=!m.validation?'untested':m.validation.model_revision===m.revision&&m.validation.connection_revision===(c?.revision??0)&&m.validation.adapter_version===a?.version?'passed':'stale';
    const defaults=normalizeParameters(!m.legacy_defaults_pending&&m.preset_id?this.data.defaults_by_model?.[m.preset_id]??m.defaults:m.defaults,{...m,capabilities,generation_contract} as ModelConfig);
    return structuredClone({ ...m,defaults,capabilities,generation_contract,validation_status,geometry_support:a?.geometry_support, endpoint:c?.endpoint??'',credential_ref:c?.credential_ref,connection_revision:c?.revision,adapter_version:a?.version,
      executable:valid && (m.kind!=='cloud'||!!c?.enabled&&!!c.endpoint&&(!a?.requires_credential||!!c.credential_ref)) }) as ModelConfig;
  }
  async execution(id:string) { const m=this.resolve(id); if(!m.executable)throw new Error('模型未就绪：请检查连接、凭据、用途与适配器能力。'); if(m.credential_ref && !await this.secrets.has(m.credential_ref))throw new Error('模型连接凭据缺失，请重新设置。'); return m; }
  async credential(model:ModelConfig){if(!model.credential_ref||!this.secrets.resolve)throw new Error('模型凭据不可用。');return this.secrets.resolve(model.credential_ref);}
  async list(): Promise<PublicModel[]> {
    return Promise.all(this.data.models.map(async entry => {
      const model = entry.enabled ? this.resolve(entry.model_config_id) : {...entry,endpoint:this.data.connections.find(c=>c.connection_id===entry.connection_id)?.endpoint??'',executable:false};
      const ref = this.data.connections.find(c=>c.connection_id===entry.connection_id)?.credential_ref;
      const { credential_ref, ...rest } = structuredClone(model) as ModelConfig;
      const has_credential = ref ? await this.secrets.has(ref) : false;
      const adapter=this.adapters.find(a=>a.adapter_id===entry.adapter_id),connection=this.data.connections.find(c=>c.connection_id===entry.connection_id);
      const reasons:string[]=[];
      if(!entry.enabled)reasons.push('模型已停用');
      if(!adapter?.installed)reasons.push('执行协议尚未安装');
      else {
        if(adapter.kind!==entry.kind||!adapter.purposes.includes(entry.purpose))reasons.push('协议与模型用途不匹配');

      }
      if(entry.kind==='cloud'){
        if(!connection?.enabled)reasons.push('接口连接已停用或不存在');
        if(!connection?.endpoint)reasons.push('接口地址未配置');
        if(adapter?.requires_credential&&!has_credential)reasons.push('连接凭据未配置或缺失');
      }
      return { ...rest, executable:rest.executable&&(!adapter?.requires_credential||has_credential), has_credential,readiness_error:reasons.length?reasons.join('；'):undefined,declared_capabilities:structuredClone(entry.capabilities),unavailable_operations:entry.capabilities.operations.filter(op=>!adapter?.operations.includes(op)) };
    }));
  }
  async connections() { return Promise.all(this.data.connections.map(async ({credential_ref,...c})=>({...c,has_credential:credential_ref?await this.secrets.has(credential_ref):false}))); }
  async saveConnection(input: Omit<Connection,'revision'|'credential_ref'>, secret?:string, clear=false) {
    const next=this.snapshot(), old=next.connections.find(c=>c.connection_id===input.connection_id);
    const c=connectionSchema.parse({...input,revision:(old?.revision??0)+1,credential_ref:clear?undefined:old?.credential_ref});
    if(secret&&clear)throw new Error('不能同时设置和清除凭据。');
    if(secret){c.credential_ref=newId('credential');await this.secrets.set(c.credential_ref,secret);}
    const index=next.connections.findIndex(item=>item.connection_id===c.connection_id);if(index<0)next.connections.push(c);else next.connections[index]=c;await this.save(next);
  }
  async saveModel(input: Omit<ModelEntry,'revision'>) {
    const next=this.snapshot(),old=next.models.find(m=>m.model_config_id===input.model_config_id);
    const model=modelEntrySchema.parse({...input,revision:(old?.revision??0)+1});
    const preset=findPreset(model.preset_id);
    if(model.preset_id&&!preset)throw new Error('模型预设不存在。');
    if(preset){
      if(preset.config.adapter_id!==model.adapter_id||preset.purpose!==model.purpose)throw new Error('模型预设与接口协议或用途不匹配。');
      model.generation_contract=structuredClone(preset.config.generation_contract);
      // New channels inherit existing model defaults, never overwrite them.
      if(!old&&next.defaults_by_model?.[preset.id])model.defaults=structuredClone(next.defaults_by_model[preset.id]);
    }
    if((!old||old.connection_id!==model.connection_id||old.model!==model.model||old.adapter_id!==model.adapter_id)&&next.models.some(m=>m.model_config_id!==model.model_config_id&&m.connection_id===model.connection_id&&m.model===model.model&&m.adapter_id===model.adapter_id))throw new Error('此接口的该模型已入库。');
    delete model.validation;
    if(model.capability_source==='tested')throw new Error('不能手动将模型能力标记为已实测。');
    if(model.defaults.aspect_ratio!=='auto'&&!model.capabilities.aspect_ratios.includes(model.defaults.aspect_ratio))throw new Error('默认比例超出模型声明能力。');
    const a=this.adapters.find(a=>a.adapter_id===model.adapter_id);
    if(!a||a.kind!==model.kind||!a.purposes.includes(model.purpose))throw new Error('适配器不存在或与模型用途不匹配。');
    for(const [key,limit] of Object.entries(model.capabilities.parameter_limits??{})){
      const field=(model.generation_contract??a.generation_contract)?.fields.find(f=>f.key===key);
      if(!field)throw new Error('协议未声明此参数：'+key);
      if(limit.minimum!==undefined&&limit.maximum!==undefined&&limit.minimum>limit.maximum)throw new Error('参数最小值不能超过最大值。');
      if(limit.values?.some(v=>!field.values?.includes(v)))throw new Error('参数允许值超出协议实现范围。');
    }
    const resolved={...model,generation_contract:model.generation_contract??a.generation_contract,endpoint:'',executable:false} as ModelConfig;
    model.defaults=snapshotParameters(model.defaults,resolved);
    validateGenerationParameters(model.defaults,resolved);
    if(preset){
      next.defaults_by_model={...next.defaults_by_model,[preset.id]:structuredClone(model.defaults)};
      delete model.legacy_defaults_pending;
      for(const peer of old?next.models.filter(m=>m.preset_id===preset.id&&m.model_config_id!==model.model_config_id):[]){
        peer.defaults=structuredClone(model.defaults);delete peer.legacy_defaults_pending;peer.revision++;delete peer.validation;
      }
    }
    const index=next.models.findIndex(m=>m.model_config_id===model.model_config_id);if(index<0)next.models.push(model);else next.models[index]=model;await this.save(next);
  }
  async acceptTest(record:ModelTestRecord){
    if(record.status!=='succeeded'||record.operation!=='understand')throw new Error('测试未通过。');
    const resolved=this.resolve(record.model_config_id);
    if(resolved.purpose!=='understanding'||resolved.revision!==record.model_revision||resolved.connection_revision!==record.connection_revision||resolved.adapter_version!==record.adapter_version||resolved.model!==record.model||resolved.adapter_id!==record.adapter_id)throw new Error('测试后模型或连接配置已改变，请重新测试。');
    const next=this.snapshot(),m=next.models.find(m=>m.model_config_id===record.model_config_id)!;
    m.validation={test_id:record.test_id,model_revision:m.revision,connection_revision:record.connection_revision,adapter_version:record.adapter_version,checked_at:record.finished_at!,operation:'understand'};
    await this.save(next);
  }
  async deleteConnection(id:string) { const next=this.snapshot();if(next.models.some(m=>m.connection_id===id))throw new Error('此连接仍有关联模型，请先删除模型或重新绑定连接。');next.connections=next.connections.filter(c=>c.connection_id!==id);await this.save(next); }
  async deleteModel(id:string) { const next=this.snapshot();if(Object.values(next.assignments).includes(id))throw new Error('请先更换默认功能模型再删除。');next.models=next.models.filter(m=>m.model_config_id!==id);await this.save(next); }
  async assign(purpose:ModelEntry['purpose']|'editing',id:string) {
    const next=this.snapshot(),model=next.models.find(m=>m.model_config_id===id);
    if(!model?.enabled||(purpose==='editing'?!maskEditMethod(this.resolve(id)):model.purpose!==purpose))throw new Error('默认模型用途不匹配或已停用。');
    next.assignments[`${purpose}_default`]=id;await this.save(next);
  }
  async update(id: string, patch: { title: string; endpoint: string; enabled: boolean }, secret?: string) {
    // Compatibility command for older callers; commit both changes atomically.
    const next=this.snapshot(),m=next.models.find(m=>m.model_config_id===id);if(!m)throw new Error('模型配置不存在。');
    m.title=patch.title;m.enabled=patch.enabled;m.revision++;
    const c=next.connections.find(c=>c.connection_id===m.connection_id);
    if(c){const validated=connectionSchema.parse({...c,endpoint:patch.endpoint,revision:c.revision+1});Object.assign(c,validated);if(secret){c.credential_ref=newId('credential');await this.secrets.set(c.credential_ref,secret);}}
    else if(secret)throw new Error('只有云端模型可保存 API Key。');
    await this.save(next);
  }
}
