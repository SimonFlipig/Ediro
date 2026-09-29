import { type ModelConfig, type Parameters, type Recipe } from './domain.js';
import { librarySchema, type LibraryData } from './model-library.js';
import { normalizeParameters, parameterFields } from './generation-parameters.js';
import { findPreset, identifyPreset, modelIdentity } from '../protocols/model-catalog.js';

export function snapshotParameters(input:Parameters,model:ModelConfig):Parameters {
  const p=structuredClone(normalizeParameters(input,model));
  const own={...p.extensions?.[model.adapter_id]};
  for(const f of parameterFields(model))if(own[f.key]===undefined&&f.default!==undefined&&(!f.formats||f.formats.includes(p.output_format))&&(!f.values||f.values.includes(String(f.default))))own[f.key]=f.default;
  p.extensions={...p.extensions,[model.adapter_id]:own};return p;
}
export function selectWorkflowModel(recipe:Recipe,model:ModelConfig,previous?:ModelConfig):Recipe {
  const remembered=structuredClone(recipe.model_parameters??{});
  const channels={...recipe.model_channels};
  if(previous){remembered[modelIdentity(previous)]=structuredClone(recipe.core_parameters);channels[modelIdentity(previous)]=previous.model_config_id;}
  const parameters=remembered[modelIdentity(model)]??snapshotParameters(model.defaults,model);
  channels[modelIdentity(model)]=model.model_config_id;
  return {...recipe,model_config_id:model.model_config_id,model_channels:channels,model_parameters:remembered,core_parameters:structuredClone(parameters)};
}
// Preserve all entry IDs, credentials and conflicting legacy defaults. The UI asks
// which legacy values should become shared; migration never silently chooses them.
export function migrateModelSettings(input:LibraryData):LibraryData {
  if(input.schema_version===3)return structuredClone(input);
  const data=librarySchema.parse({...input,schema_version:3,defaults_by_model:input.defaults_by_model??{}});
  for(const m of data.models){
    const p=findPreset(m.preset_id)??identifyPreset(m.model);
    if(!p||p.config.adapter_id!==m.adapter_id||p.purpose!==m.purpose)continue;
    m.preset_id=p.id;
    m.defaults=normalizeParameters(m.defaults,{...m,endpoint:'',executable:false} as ModelConfig);
    // Old hand-entered option lists are replaced by the complete reviewed list.
    // Explicit channel restrictions and compatibility mappings remain intact.
    m.capabilities={...structuredClone(p.config.capabilities),interleaving:m.capabilities.interleaving,...(m.capabilities.parameter_limits?{parameter_limits:m.capabilities.parameter_limits}:{}),...(m.capabilities.size_limits?{size_limits:m.capabilities.size_limits}:{})};
    m.generation_contract=structuredClone(p.config.generation_contract);
    if(m.purpose==='understanding'&&m.defaults.extensions?.[m.adapter_id])delete m.defaults.extensions[m.adapter_id].response_mode;
  }
  for(const p of new Set(data.models.map(m=>m.preset_id).filter((x):x is string=>!!x))){
    const entries=data.models.filter(m=>m.preset_id===p);
    const first=entries.find(m=>Object.values(data.assignments).includes(m.model_config_id))??entries[0];
    data.defaults_by_model![p]=structuredClone(first.defaults);
    const conflict=entries.some(m=>JSON.stringify(m.defaults)!==JSON.stringify(first.defaults));
    if(conflict)entries.forEach(m=>{m.legacy_defaults_pending=true;});
  }
  return data;
}
