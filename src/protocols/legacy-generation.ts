import type { ModelEntry } from '../core/model-library.js';
import type { ModelConfig } from '../core/domain.js';
import { normalizeParameters } from '../core/generation-parameters.js';
import { geminiProfile,imagesProfile,mockProfile } from './generation-profiles.js';

// Version-boundary migration only. Historical name rules must not leak into
// planning/UI; new model declarations explicitly select their capabilities.
export function migrateGenerationModel(source:ModelEntry):ModelEntry {
  const m=structuredClone(source);
  const profiles:Record<string,typeof geminiProfile>={'gemini-generate-content':geminiProfile,'openai-images':imagesProfile,mock:mockProfile};
  const profile=profiles[m.adapter_id];
  if(!profile)return m;
  m.generation_contract=structuredClone(profile);
  if(m.capabilities.features===undefined){
    m.capabilities.features=[];
    if(m.adapter_id==='gemini-generate-content'){
      if(/^gemini-3/.test(m.model))m.capabilities.features.push('reference_overrides');
      if(/^gemini-3(?:\.1)?-(?:pro|flash)-image/.test(m.model))m.capabilities.features.push('google_search');
    }
  }
  if(m.purpose==='understanding'&&!m.capabilities.operations.includes('understand'))m.capabilities.operations.push('understand');
  m.defaults=normalizeParameters(m.defaults,{...m,executable:false,endpoint:''} as ModelConfig);
  delete m.validation;
  return m;
}
