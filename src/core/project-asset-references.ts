import type {Project,Recipe} from './domain.js';

/** Result/history pointers may survive deletion, but inputs must remain readable.
 * Disabled modules and historical recipes still count: users can restore them. */
export function optionalRemovedResults(project:Project):Set<string>{
  const required=new Set<string>();
  const recipe=(value:Recipe)=>{for(const module of value.modules)for(const id of module.asset_ids)required.add(id);};
  recipe(project.recipe);
  for(const draft of project.mask_drafts??[])required.add(draft.source_asset_id);
  for(const job of project.jobs){
    recipe(job.recipe_snapshot);
    for(const block of job.chain_snapshot.blocks)if(block.type==='image')required.add(block.asset_id);
    for(const block of job.adapted_input.blocks??[])if(block.type==='image')required.add(block.asset_id);
    for(const id of job.adapted_input.image_asset_ids??[])required.add(id);
    const edit=job.mask_edit;
    if(edit){
      recipe(edit.main_recipe_snapshot);
      for(const id of [edit.draft.source_asset_id,edit.source_snapshot_id,edit.mask_asset_id,edit.request_source_id,edit.guide_asset_id,...edit.raw_asset_ids])if(id)required.add(id);
    }
  }
  return new Set(project.assets.filter(asset=>asset.kind==='output'&&asset.removed_result&&!required.has(asset.asset_id)).map(asset=>asset.asset_id));
}
