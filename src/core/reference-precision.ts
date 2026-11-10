import type { Job, ModelConfig } from './domain.js';
import { parameterFields } from './generation-parameters.js';
import { defaultModuleSettings, referencePrecisionModules, type ModuleSettings, type ReferencePrecision } from './module-settings.js';

// Precision is separate from image preprocessing: subject and generated
// references can choose precision without changing their pixels.
export function referencePrecisionDefault(module:{reference_type:string;reference_precision?:ReferencePrecision},defaults:ModuleSettings=defaultModuleSettings,values?:string[]):ReferencePrecision {
  const type=referencePrecisionModules.find(item=>item.type===module.reference_type)?.type;
  const precision=module.reference_precision??(type?defaults.reference_precision?.[type]:undefined)??'inherit';
  return precision==='inherit'||!values||values.includes(precision)?precision:'inherit';
}

// Explicit overrides keep their existing asset-wide scope. Defaults resolve
// per image occurrence so a shared asset can differ between subject and style.
export function referencePrecisionForImage(job:Job,model:ModelConfig,assetId:string,imageIndex:number,override?:string):string|undefined {
  if(override!==undefined)return override==='inherit'?undefined:override;
  if(model.purpose==='understanding'||job.mask_edit)return undefined;
  if(!job.module_settings_snapshot&&!job.recipe_snapshot.modules?.some(module=>module.reference_precision!==undefined))return undefined;
  const field=parameterFields(model).find(field=>field.key==='reference_overrides'&&field.kind==='references');
  if(!field)return undefined;
  const image=job.chain_snapshot.blocks.filter(block=>block.type==='image')[imageIndex];
  if(!image)return undefined;
  if(image.asset_id!==assetId)throw new Error('参考图顺序与本次任务快照不一致。');
  const module=job.recipe_snapshot.modules?.find(module=>module.module_id===image.source_module_id);
  if(!module)return undefined;
  const precision=referencePrecisionDefault(module,job.module_settings_snapshot,field.values);
  return precision==='inherit'?undefined:precision;
}
