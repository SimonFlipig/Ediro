import sharp from 'sharp';
import type { CloudExecutionContext } from '../core/ports.js';
import {isReferenceModuleType,resolveReferenceSettings} from '../core/module-settings.js';
import {blurReferenceImage} from './blur-preprocessor.js';

// This clear, proportion-preserving image is the common starting point for
// understanding and any later generation-only reference transformations.
export async function resizeReferenceImage(bytes:Buffer,maxEdge:1024|512):Promise<Buffer>{
  if(maxEdge!==1024&&maxEdge!==512)throw new Error('参考图缩图长边只能为 1024 或 512。');
  try{
    const input=sharp(bytes,{limitInputPixels:40_000_000,failOn:'warning'});
    const metadata=await input.metadata();
    if(!['png','jpeg','webp'].includes(metadata.format??''))throw new Error('不支持的参考图格式');
    if(metadata.width&&metadata.height&&Math.max(metadata.width,metadata.height)<=maxEdge&&(!metadata.orientation||metadata.orientation===1)){
      await input.stats();return bytes;
    }
    // PNG avoids introducing lossy artifacts and retains an existing alpha channel.
    return await input.rotate().resize(maxEdge,maxEdge,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
  }catch{throw new Error('参考图无法缩图，请使用可完整解码的 PNG、JPEG 或 WebP 图片，且不超过 4000 万像素。');}
}

export async function readReferenceImage(context:CloudExecutionContext,assetId:string,imageIndex:number):Promise<Buffer>{
  const {job}=context,settings=job.module_settings_snapshot;
  // Older jobs and mask editing must replay their original image bytes.
  if(!settings||job.mask_edit)return context.readImage(assetId);
  const image=job.chain_snapshot.blocks.filter(block=>block.type==='image')[imageIndex];
  if(!Number.isInteger(imageIndex)||imageIndex<0||!image||image.asset_id!==assetId)throw new Error('参考图顺序与本次任务快照不一致。');
  if(!isReferenceModuleType(image.reference_type))return context.readImage(assetId);
  const module=job.recipe_snapshot.modules.find(module=>module.module_id===image.source_module_id);
  if(!module||module.reference_type!==image.reference_type||!module.asset_ids.includes(assetId))throw new Error('参考图所属模块与本次任务快照不一致。');
  const referenceSettings=resolveReferenceSettings(module,settings)!;
  const bytes=await context.readImage(assetId);
  const clear=await resizeReferenceImage(bytes,referenceSettings.max_edge);
  if(context.model.purpose==='understanding'||referenceSettings.preprocess==='none')return clear;
  if(context.preprocessReferenceImage)return context.preprocessReferenceImage(clear,referenceSettings);
  if(referenceSettings.preprocess==='blur')return blurReferenceImage(clear,referenceSettings.blur_strength);
  throw new Error('本地图像预处理未初始化，请重新打开 Ediro 后重试。');
}
