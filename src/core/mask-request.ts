import type {ModelConfig,Parameters} from './domain.js';
import {contractFor,normalizeParameters,validateGenerationParameters} from './generation-parameters.js';
import {snapshotParameters} from './model-settings.js';
import {parseRatio,type OutputGeometry} from './output-geometry.js';
import {maskCropSchema,planMaskCrop,type MaskCrop,type MaskDraft} from './mask.js';

export function maskEditMethod(model:Pick<ModelConfig,'purpose'|'capabilities'>):'native'|'guided'|undefined{
  if(model.purpose!=='generation')return undefined;
  return model.capabilities.operations.includes('nativeMaskEdit')?'native':model.capabilities.operations.includes('guidedMaskEdit')?'guided':undefined;
}

// Keep the user-tested instruction together; the two images precede this text.
export const maskGuidance={
  instruction:(instruction:string)=>`图1是待编辑原图，图2是与图1逐像素对齐的区域指示图。仅在图2白色区域对应的位置${instruction}，黑色区域对应的内容保持不变。图2只用于指示编辑位置，不要把黑白图案画进结果。保持图1的构图、视角和画面比例，只返回编辑后的图1。`,
};

function ratioCrop(wanted:MaskCrop,draft:MaskDraft,ratios:string[]){
  let best:{crop:MaskCrop;ratio:string}|undefined;
  for(const ratio of ratios){
    const r=parseRatio(ratio);if(!r||!Number.isInteger(r.w)||!Number.isInteger(r.h))continue;
    const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a,divisor=gcd(r.w,r.h),rw=r.w/divisor,rh=r.h/divisor;
    const factor=Math.ceil(Math.max(wanted.width/rw,wanted.height/rh)),width=rw*factor,height=rh*factor;
    const place=(start:number,length:number,extent:number,full:number)=>extent<=full?Math.max(0,Math.min(full-extent,Math.round(start+(length-extent)/2))):Math.round((full-extent)/2);
    const crop={x:place(wanted.x,wanted.width,width,draft.width),y:place(wanted.y,wanted.height,height,draft.height),width,height};
    if(!maskCropSchema.safeParse(crop).success)continue;
    if(!best||width*height<best.crop.width*best.crop.height)best={crop,ratio};
  }
  if(!best)throw new Error('无法按此模型支持的比例覆盖选区，请缩小送入范围或检查比例能力。');
  return best;
}

export function maskResolutionForCrop(crop:Pick<MaskCrop,'width'|'height'>,tiers:string[]):Parameters['resolution']{
  // Use sent pixels, not source size or stroke coverage. A 10% pixel margin
  // avoids promoting near-boundary crops for ratio rounding or a small border.
  const pixels=crop.width*crop.height;
  const value=pixels*100<=1024**2*110?'1K':pixels*100<=2048**2*110?'2K':'4K';
  if(!tiers.includes(value))throw new Error(`此接入不支持按裁片大小匹配的 ${value} 档位，请检查模型能力设置。`);
  return {mode:'tier',value};
}

// Both UI and queue use this plan: source pixels stay at original scale, only
// the guided branch expands its frame to a declared output aspect ratio.
export function planMaskRequest(draft:MaskDraft,model:ModelConfig){
  const method=maskEditMethod(model);if(!method)throw new Error('所选模型或连接不支持局部编辑。');
  const contract=contractFor(model),defaults=normalizeParameters(model.defaults,model);
  let crop:MaskCrop,geometry:OutputGeometry,resolution:Parameters['resolution'],strategy:'interleaved'|'numbered_flat'='numbered_flat';
  if(method==='guided'){
    if(!model.capabilities.operations.includes('referenceEdit')||model.capabilities.max_images<2)throw new Error('黑白区域图编辑需要此接入支持至少两张参考图。');
    const framed=ratioCrop(planMaskCrop(draft),draft,model.capabilities.aspect_ratios);crop=framed.crop;
    // Historical explicit tiers remain reproducible; new edits use the final
    // crop area instead of inheriting the global generation default.
    resolution=!draft.resolution||draft.resolution.mode==='default'?maskResolutionForCrop(crop,contract.tiers):draft.resolution;
    if(resolution?.mode!=='tier'||!contract.tiers.includes(resolution.value))throw new Error('请选择此编辑模型支持的输出分辨率。');
    geometry={selection:'custom',basis:'user',target:'ratio',ratio:framed.ratio,request_ratio:framed.ratio,adjustments:[]};
    strategy=contract.input_forms.includes('interleaved')?'interleaved':'numbered_flat';
  }else{
    if(model.kind==='cloud'&&!contract.size_limits)throw new Error('此模型尚未声明局部编辑尺寸范围。');
    crop=planMaskCrop(draft,contract.size_limits);
    resolution=model.kind==='mock'?{mode:'default'}:{mode:'exact',width:crop.width,height:crop.height};
    geometry={selection:'custom',basis:'user',target:'size',request_size:`${crop.width}x${crop.height}`,ratio:`${crop.width}:${crop.height}`,adjustments:[]};
  }
  if(!contract.input_forms.includes(strategy))throw new Error('此接入不支持局部编辑所需的图文输入形式。');
  const parameters=snapshotParameters({...defaults,quality:draft.quality,output_format:'png',count:1,aspect_ratio:method==='guided'?geometry.request_ratio!:'auto',resolution},model);
  validateGenerationParameters(parameters,model);
  return {method,crop,geometry,parameters,strategy,contract};
}
