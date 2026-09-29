import type {Job,PublicModel,Recipe} from './domain.js';
import {findPreset,identifyPreset} from '../protocols/model-catalog.js';

// A channel ID is local to a model library. Preset identity travels with a recipe.
export function historicalPreset(recipe:Recipe,jobs:Job[]=[]){
  if(recipe.model_preset_id)return recipe.model_preset_id;
  const snapshot=[...jobs].reverse().find(j=>j.model_snapshot.model_config_id===recipe.model_config_id)?.model_snapshot;
  if(snapshot?.preset_id)return snapshot.preset_id;
  const mapped=Object.entries(recipe.model_channels??{}).filter(([preset,id])=>id===recipe.model_config_id&&findPreset(preset));
  if(mapped.length===1)return mapped[0][0];
  const preset=snapshot&&identifyPreset(snapshot.model);
  return preset?.config.adapter_id===snapshot?.adapter_id?preset?.id:undefined;
}

export function bindHistoricalRecipe(input:Recipe,jobs:Job[],models:PublicModel[],preferred:(string|undefined)[]=[]):Recipe{
  const recipe=structuredClone(input),preset=historicalPreset(recipe,jobs);
  const original=models.find(m=>m.model_config_id===recipe.model_config_id&&m.enabled&&m.purpose!=='understanding'&&(!preset||m.preset_id===preset));
  // Keep an existing channel even if its credentials need repair. Never switch
  // billing channels merely because an endpoint is temporarily unavailable.
  if(original)return recipe;
  if(!preset)return recipe;
  recipe.model_preset_id=preset;
  const candidates=models.filter(m=>m.enabled&&m.executable&&m.purpose==='generation'&&m.preset_id===preset);
  const chosen=preferred.map(id=>candidates.find(m=>m.model_config_id===id)).find(Boolean)??(candidates.length===1?candidates[0]:undefined);
  if(chosen){recipe.model_config_id=chosen.model_config_id;recipe.model_channels={...recipe.model_channels,[preset]:chosen.model_config_id};}
  return recipe;
}
