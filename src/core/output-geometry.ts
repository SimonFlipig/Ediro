import { z } from 'zod';
import { contractFor,normalizeParameters } from './generation-parameters.js';
import { validSize } from './generation-contract.js';
import type { Asset,ModelConfig,Recipe } from './domain.js';

export const outputGeometrySchema=z.object({
  selection:z.enum(['auto','fixed','custom']),basis:z.enum(['composition','subject','model','user']),
  asset_id:z.string().optional(),input_width:z.number().optional(),input_height:z.number().optional(),
  ratio:z.string().optional(),target:z.enum(['auto','ratio','size']),request_ratio:z.string().optional(),request_size:z.string().optional(),
  adjustments:z.array(z.string()),
});
export type OutputGeometry=z.infer<typeof outputGeometrySchema>;
export function parseRatio(value:string){
  value=value.replace(/^custom:/,'');
  if(!/^\d{1,6}(?:\.\d{1,3})?:\d{1,6}(?:\.\d{1,3})?$/.test(value))return null;
  const [w,h]=value.split(':').map(Number);return w>0&&h>0?{w,h}:null;
}
function gcd(a:number,b:number):number{return b?gcd(b,a%b):a;}
function reduced(w:number,h:number){const a=Math.round(w*1000),b=Math.round(h*1000),d=gcd(a,b);return {w:a/d,h:b/d};}
export function resolveOutputGeometry(recipe:Recipe,assets:Pick<Asset,'asset_id'|'width'|'height'>[],model:ModelConfig):OutputGeometry{
  const parameters=normalizeParameters(recipe.core_parameters,model),contract=contractFor(model),resolution=parameters.resolution??{mode:'default'};
  const limits=contract.size_limits,valid=(w:number,h:number)=>!!limits&&validSize(w,h,limits);
  const chosen=parameters.aspect_ratio;
  const result:OutputGeometry={selection:chosen==='auto'?'auto':chosen.startsWith('custom:')?'custom':model.capabilities.aspect_ratios.includes(chosen)?'fixed':'custom',basis:chosen==='auto'?'model':'user',target:'auto',adjustments:[]};
  if(resolution.mode==='exact'){
    const w=resolution.width,h=resolution.height;
    if(model.geometry_support!=='size'||!w||!h||!valid(w,h))throw new Error('自定义尺寸不满足当前模型的步长、边长、比例或总像素范围。');
    result.selection='custom';result.basis='user';result.ratio=`${w/gcd(w,h)}:${h/gcd(w,h)}`;result.target='size';result.request_size=`${w}x${h}`;return result;
  }
  let width:number|undefined,height:number|undefined;
  if(chosen==='auto'){
    for(const type of ['composition','subject'] as const){
      const module=recipe.modules.find(m=>m.enabled&&m.reference_type===type&&m.asset_ids.length);
      if(!module)continue;const asset=assets.find(a=>a.asset_id===module.asset_ids[0]);
      if(!asset)throw new Error('自动比例所依据的参考图不存在。');
      width=asset.width;height=asset.height;result.basis=type;result.asset_id=asset.asset_id;result.input_width=width;result.input_height=height;
      const r=reduced(width,height);result.ratio=`${r.w}:${r.h}`;break;
    }
    if(!result.ratio){if(resolution.mode==='pixel_budget')throw new Error('请选定画面比例或添加主体／构图参考图，再指定输出分辨率。');return result;}
  }else{if(!parseRatio(chosen))throw new Error('自定义比例须为正数宽:高，例如 5:3。');result.ratio=chosen.replace(/^custom:/,'');}
  const ratio=parseRatio(result.ratio!)!;
  if(model.geometry_support==='size'&&resolution.mode==='pixel_budget'){
    if(!limits)throw new Error('模型未声明精确尺寸范围。');
    const pixels=resolution.pixels,step=limits.step;
    const r=reduced(ratio.w,ratio.h),scale=Math.floor(Math.sqrt(pixels/(step*step*r.w*r.h))),w=r.w*step*scale,h=r.h*step*scale;
    if(!valid(w,h))throw new Error('当前比例无法在所选分辨率和模型尺寸边界内精确表达，请使用自定义宽×高。');
    result.target='size';result.request_size=`${w}x${h}`;return result;
  }
  if(model.geometry_support==='free_ratio'){result.target='ratio';result.request_ratio=result.ratio;return result;}
  const standard=model.capabilities.aspect_ratios.find(v=>{const r=parseRatio(v);return r&&Math.abs(r.w/r.h-ratio.w/ratio.h)<1e-10;});
  if(standard){result.target='ratio';result.request_ratio=standard;return result;}
  if(model.geometry_support==='size'&&limits){
    if(width&&height&&valid(width,height)){result.target='size';result.request_size=`${width}x${height}`;return result;}
    const r=reduced(ratio.w,ratio.h),scale=Math.max(1,Math.round(Math.sqrt(limits.default_pixels/(limits.step*limits.step*r.w*r.h))));const w=r.w*limits.step*scale,h=r.h*limits.step*scale;
    if(valid(w,h)){result.target='size';result.request_size=`${w}x${h}`;return result;}
  }
  result.adjustments.push(`期望比例 ${result.ratio} 无法在当前模型参数边界内明确传入，将交给模型自动决定；实际比例可能不同。`);return result;
}
export function geometryLabel(g:OutputGeometry){const size=g.target==='size'?` · 请求 ${g.request_size}`:'';if(g.selection==='fixed')return `固定比例 ${g.ratio}${size}`;const basis={composition:'构图参考',subject:'',model:'模型决定',user:'自定义'}[g.basis];return `${g.selection==='auto'?'自动 · ':''}${basis}${g.input_width?` ${g.input_width}×${g.input_height}`:g.ratio?` ${g.ratio}`:''}${size}`;}
