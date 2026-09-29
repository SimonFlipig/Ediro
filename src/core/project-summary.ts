import type {Project} from './domain.js';
import {sameMaskStrokes} from './mask.js';

export function projectSummary(project:Project){
  const outputs=project.assets.filter(a=>a.kind==='output'&&!a.removed_result&&!a.hidden_from_results);
  const cover=outputs.at(-1)??project.assets.find(a=>a.kind==='import'&&!a.hidden_from_materials)??project.assets.find(a=>a.kind==='generated');
  const latest=project.jobs.at(-1),drafts=project.mask_drafts??[];
  const unconfirmed=project.jobs.some(j=>j.mask_edit&&j.mask_edit.raw_asset_ids.length&&(!j.mask_edit.variants.length||j.mask_edit.variants.at(-1)?.mode==='strict'&&!j.mask_edit.variants.some(v=>v.mode==='strict'&&sameMaskStrokes(v.composite_strokes??j.mask_edit!.draft.strokes,j.mask_edit!.composite_strokes??j.mask_edit!.draft.strokes))));
  const changedMask=drafts.some(d=>d.strokes.length&&!project.jobs.some(j=>j.mask_edit&&JSON.stringify(j.mask_edit.draft)===JSON.stringify(d)));
  const lastMain=[...project.jobs].reverse().find(j=>!j.mask_edit)?.recipe_snapshot;
  const changedRecipe=lastMain?JSON.stringify(project.recipe)!==JSON.stringify(lastMain):!latest&&project.recipe.modules.some(m=>m.user_instruction.trim()||m.asset_ids.length);
  const status=project.jobs.some(j=>['queued','preparing','running','post_processing'].includes(j.status))?'running':unconfirmed||changedMask||changedRecipe?'draft':latest?.status==='failed'?'failed':outputs.length?'saved':'empty';
  return {title:project.name,updated_at:project.updated_at,cover_asset_id:cover?.asset_id,result_count:outputs.length,status} as const;
}
