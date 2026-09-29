import type {Project,PublicModel} from '../core/domain.js';
import type {MaskDraft,MaskStroke} from '../core/mask.js';
import {maskEditMethod} from '../core/mask-request.js';
import {findPreset} from '../protocols/model-catalog.js';

export function defaultMaskModel(models:PublicModel[],defaultId?:string){
  const eligible=models.filter(m=>m.enabled&&maskEditMethod(m));
  const preferred=eligible.find(m=>m.model_config_id===defaultId);if(preferred)return preferred;
  return eligible.find(m=>m.executable&&findPreset(m.preset_id)?.family==='nano')
    ??eligible.find(m=>m.executable&&m.adapter_id==='openai-images')
    ??eligible.find(m=>m.executable&&m.kind==='mock')
    ??eligible.find(m=>findPreset(m.preset_id)?.family==='nano')
    ??eligible.find(m=>m.adapter_id==='openai-images');
}

export function maskEditorEntry(project:Project,assetId:string,options:{fresh?:boolean;taskId?:string}={}):{
  sourceId:string;taskId?:string;draft?:MaskDraft;strokes?:MaskStroke[];display:'mask'|'result';snapshotId?:string;
}{
  const job=options.taskId?project.jobs.find(j=>j.task_id===options.taskId&&j.mask_edit)
    :!options.fresh?project.jobs.find(j=>j.mask_edit?.variants.some(v=>v.asset_id===assetId)):undefined;
  if(!job?.mask_edit)return {sourceId:assetId,draft:structuredClone(project.mask_drafts?.find(d=>d.source_asset_id===assetId)),display:'mask'};
  const edit=job.mask_edit,variant=edit.variants.find(v=>v.asset_id===assetId);
  // Explicit task + version selection uses the saved mask. The usual editing
  // entry for the newest version also resumes later autosaved brush work.
  const latest=!variant||!options.taskId&&variant.asset_id===edit.variants.at(-1)?.asset_id;
  const strokes=latest?edit.composite_strokes??variant?.composite_strokes??edit.draft.strokes:variant.composite_strokes??edit.draft.strokes;
  return {sourceId:edit.draft.source_asset_id,taskId:job.task_id,snapshotId:edit.source_snapshot_id,
    draft:structuredClone({...edit.draft,...(variant?{mode:variant.mode,feather:variant.feather}:{})}),
    strokes:structuredClone(strokes),display:edit.raw_asset_ids.length?'result':'mask'};
}
