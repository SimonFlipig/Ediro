import { z } from 'zod';
import { idSchema,recipeSchema } from './domain.js';
import {resolutionSchema,validSize,type SizeLimits} from './generation-contract.js';

export const maskCropSchema=z.object({x:z.number().int().min(-20000).max(20000),y:z.number().int().min(-20000).max(20000),width:z.number().int().positive().max(20000),height:z.number().int().positive().max(20000)}).refine(c=>c.width*c.height<=40_000_000,'送入范围超过本地 4000 万像素处理上限。');
export type MaskCrop=z.infer<typeof maskCropSchema>;

export const maskStrokeSchema = z.object({
  tool: z.enum(['paint', 'erase']),
  closed: z.boolean().optional(),
  size: z.number().min(1).max(1000),
  points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(1).max(10000),
});
export const maskModeSchema = z.enum(['strict', 'natural']);
export const MASK_FEATHER_VERSION=2;
export const maskStrokesSchema = z.array(maskStrokeSchema).max(500).refine(strokes=>strokes.reduce((n,s)=>n+s.points.length,0)<=100000,'蒙版笔迹过多，请开始一个新版本。');
export const maskDraftSchema = z.object({
  source_asset_id: idSchema,
  width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000),
  strokes: maskStrokesSchema,
  crop:maskCropSchema.optional(), context_padding:z.number().int().min(0).max(2048).optional(),
  resolution:resolutionSchema.optional(),
  instruction: z.string().max(32000), model_config_id: z.union([idSchema, z.literal('')]),
  quality: z.string().max(40), mode: maskModeSchema, feather: z.number().int().min(0).max(64),
});
export const maskEditSchema = z.object({
  main_recipe_snapshot:recipeSchema,
  draft: maskDraftSchema, source_snapshot_id: idSchema, mask_asset_id: idSchema,
  request_source_id:idSchema.optional(), crop:maskCropSchema.optional(),
  method:z.enum(['native','guided']).optional(), guide_asset_id:idSchema.optional(),
  parent_revision_id: idSchema.optional(), raw_asset_ids: z.array(idSchema),
  composite_strokes: maskStrokesSchema.optional(),
  variants: z.array(z.object({asset_id:idSchema, mode:maskModeSchema, feather:z.number().int().min(0).max(64),feather_version:z.literal(MASK_FEATHER_VERSION).optional(),composite_strokes:maskStrokesSchema.optional()})),
}).refine(edit=>!!edit.crop===!!edit.request_source_id,'裁切任务需要同时保存送入底图与原图坐标。')
  .refine(edit=>edit.method==='guided'?!!edit.guide_asset_id&&!!edit.crop:!edit.guide_asset_id,'黑白引导任务需要独立区域图和固定贴回范围。');
export type MaskDraft = z.infer<typeof maskDraftSchema>;
export type MaskStroke = z.infer<typeof maskStrokeSchema>;
export type MaskMode = z.infer<typeof maskModeSchema>;
export type MaskEdit = z.infer<typeof maskEditSchema>;

// Pre-fix feathered files remain historical outputs, but cannot satisfy a new
// preview/save request. Zero feather and natural blending are unchanged.
export function currentMaskFeather(variant:Pick<MaskEdit['variants'][number],'mode'|'feather'|'feather_version'>){
  return variant.mode==='natural'||variant.feather===0||variant.feather_version===MASK_FEATHER_VERSION;
}

// Pixel processing is provided by the host; the task contract is provider neutral.
export interface MaskPixelsPort {
  createPreview?(input:MaskPreviewInput):Promise<MaskPreviewSession>;
  guidance(mask:Buffer):Promise<Buffer>;
  alignGuidedResult(generated:Buffer,width:number,height:number):Promise<Buffer>;
  rasterize(width:number,height:number,strokes:MaskStroke[]):Promise<Buffer>;
  prepare(source:Buffer, draft:MaskDraft,crop?:MaskCrop):Promise<{source:Buffer; mask:Buffer;requestSource?:Buffer}>;
  compose(source:Buffer, mask:Buffer, generated:Buffer, feather:number,crop?:MaskCrop,mode?:MaskMode):Promise<Buffer>;
}
export interface MaskPreviewInput {
  source:Buffer; generated:Buffer; width:number; height:number; crop?:MaskCrop; guided:boolean;
}
export interface MaskPreviewSession {
  render(strokes:MaskStroke[],mode:MaskMode,feather:number):Promise<Buffer>;
  dispose():void;
}

// Plan in original-image pixels. Expanding context is allowed; resampling is not.
// Paint bounds are conservative after erasing so no remaining selection is lost.
export function planMaskCrop(draft:MaskDraft,limits?:SizeLimits):MaskCrop {
  let left=draft.width,top=draft.height,right=0,bottom=0;
  for(const stroke of draft.strokes)if(stroke.tool==='paint')for(const [x,y] of stroke.points){
    left=Math.min(left,x*draft.width-stroke.size/2);right=Math.max(right,x*draft.width+stroke.size/2);
    top=Math.min(top,y*draft.height-stroke.size/2);bottom=Math.max(bottom,y*draft.height+stroke.size/2);
  }
  if(right<=left||bottom<=top)throw new Error('请先涂出需要修改的区域。');
  left=Math.max(0,Math.floor(left));top=Math.max(0,Math.floor(top));right=Math.min(draft.width,Math.ceil(right));bottom=Math.min(draft.height,Math.ceil(bottom));
  const padding=draft.context_padding??128;
  const wanted=draft.crop??{x:Math.max(0,left-padding),y:Math.max(0,top-padding),width:Math.min(draft.width,right+padding)-Math.max(0,left-padding),height:Math.min(draft.height,bottom+padding)-Math.max(0,top-padding)};
  if(wanted.x>left||wanted.y>top||wanted.x+wanted.width<right||wanted.y+wanted.height<bottom)throw new Error('送入范围需要覆盖绘制选区，请扩大范围或恢复自动范围。');
  let width=wanted.width,height=wanted.height;
  if(limits){
    const target=Math.min(limits.max_pixels,Math.max(limits.min_pixels,limits.default_pixels));
    const square=Math.ceil(Math.sqrt(target)/limits.step)*limits.step;
    if(width<=square&&height<=square&&validSize(square,square,limits)){width=square;height=square;}
    else {
      let best:{width:number;height:number;score:number}|undefined;
      for(let w=Math.ceil(width/limits.step)*limits.step;w<=limits.max_edge;w+=limits.step){
        const h=Math.ceil(Math.max(height,target/w,w/limits.max_ratio)/limits.step)*limits.step;
        if(!validSize(w,h,limits))continue;
        const score=w*h+target*.05*Math.abs(Math.log((w/h)/(width/height)));
        if(!best||score<best.score)best={width:w,height:h,score};
      }
      if(!best)throw new Error('选区与周边范围超过此模型的尺寸上限，请减少周边范围或分次修改；原图不会自动缩小。');
      ({width,height}=best);
    }
  }
  const place=(start:number,length:number,extent:number,full:number)=>extent<=full?Math.max(0,Math.min(full-extent,Math.round(start+(length-extent)/2))):Math.round((full-extent)/2);
  return {x:place(wanted.x,wanted.width,width,draft.width),y:place(wanted.y,wanted.height,height,draft.height),width,height};
}

// Decide closure only for the current gesture, in displayed pixels so the
// endpoint tolerance follows zoom without bridging a large part of the loop.
export function closeMaskStroke(stroke:MaskStroke,width:number,height:number,scale=1):MaskStroke {
  if(stroke.closed||stroke.points.length<4||![width,height,scale].every(n=>Number.isFinite(n)&&n>0))return stroke;
  const points=stroke.points.map(([x,y])=>[x*width*scale,y*height*scale]);
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,length=0,twiceArea=0;
  for(let i=0;i<points.length;i++){
    const [x,y]=points[i],[nx,ny]=points[(i+1)%points.length];
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
    twiceArea+=x*ny-nx*y;
    if(i+1<points.length)length+=Math.hypot(nx-x,ny-y);
  }
  const spanX=right-left,spanY=bottom-top,shortSide=Math.min(spanX,spanY),area=Math.abs(twiceArea)/2;
  const brush=stroke.size*scale;
  // Reject clicks, retraced lines and tiny hooks. Complex self-crossing marks
  // whose signed areas cancel are conservatively left as ordinary strokes.
  if(shortSide<2||area<Math.max(4,Math.min(64,brush*brush/8),spanX*spanY*.04))return stroke;
  const first=points[0],last=points.at(-1)!,gap=Math.hypot(last[0]-first[0],last[1]-first[1]);
  const tolerance=Math.min(12,Math.max(6,brush/2),shortSide*.2,length*.08);
  if(gap>tolerance)return stroke;
  return {...stroke,closed:true};
}

export function sameMaskStrokes(a:MaskStroke[],b:MaskStroke[]){return JSON.stringify(a)===JSON.stringify(b);}

// Shared shape construction keeps the visible selection and exported mask aligned.
export function maskSelectionSvg(width:number, height:number, strokes:MaskStroke[]) {
  const marks = strokes.map(s => {
    const color=s.tool==='paint'?'white':'black';
    if(s.points.length===1) return `<circle cx="${s.points[0][0]*width}" cy="${s.points[0][1]*height}" r="${s.size/2}" fill="${color}"/>`;
    const points=s.points.map(([x,y])=>`${x*width},${y*height}`).join(' ');
    if(s.closed)return `<polygon points="${points}" fill="${color}" fill-rule="evenodd" stroke="${color}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round"/>`;
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="black"/>${marks}</svg>`;
}
