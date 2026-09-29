import sharp from 'sharp';
import { maskSelectionSvg, type MaskCrop,type MaskMode,type MaskDraft, type MaskStroke, type MaskPixelsPort } from '../core/mask.js';

const decode = (bytes:Buffer) => sharp(bytes,{limitInputPixels:40_000_000}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
export class MaskPixels implements MaskPixelsPort {
  async guidance(mask:Buffer){
    const {data,info}=await sharp(mask,{limitInputPixels:40_000_000}).ensureAlpha().extractChannel('alpha').raw().toBuffer({resolveWithObject:true});
    const rgb=Buffer.alloc(info.width*info.height*3);
    for(let i=0;i<data.length;i++)rgb.fill(255-data[i],i*3,i*3+3);
    return sharp(rgb,{raw:{width:info.width,height:info.height,channels:3}}).png({compressionLevel:9}).toBuffer();
  }
  async alignGuidedResult(generated:Buffer,width:number,height:number){
    const result=await decode(generated);
    // Tier-based models round dimensions to their pixel grid. Accommodate that
    // small rounding only; unrelated aspect ratios must never be stretched in.
    if(Math.abs((result.info.width/result.info.height)/(width/height)-1)>.02)throw new Error('模型返回的画面比例与送入范围不同，无法可靠贴回；原始返回图已保留，请查看模型原始返回。');
    if(result.info.width===width&&result.info.height===height)return generated;
    return sharp(result.data,{raw:result.info}).resize(width,height,{fit:'fill',kernel:'lanczos3'}).png().toBuffer();
  }
  async prepare(bytes:Buffer, draft:MaskDraft,crop?:MaskCrop) {
    const decoded=await decode(bytes);
    if(decoded.info.width!==draft.width||decoded.info.height!==draft.height)throw new Error('底图尺寸已改变，请重新进入局部编辑。');
    const source=await sharp(decoded.data,{raw:decoded.info}).png({compressionLevel:9}).toBuffer();
    let mask=await this.rasterize(draft.width,draft.height,draft.strokes);
    const alpha=await sharp(mask).extractChannel('alpha').raw().toBuffer();
    if(!alpha.some(a=>a<255))throw new Error('请先涂出需要修改的区域。');
    if(!crop)return {source,mask};
    const left=Math.max(0,crop.x),top=Math.max(0,crop.y),right=Math.min(draft.width,crop.x+crop.width),bottom=Math.min(draft.height,crop.y+crop.height);
    if(right<=left||bottom<=top)throw new Error('送入范围未覆盖底图。');
    const extract={left,top,width:right-left,height:bottom-top};
    const extend={left:left-crop.x,top:top-crop.y,right:crop.x+crop.width-right,bottom:crop.y+crop.height-bottom};
    const requestSource=await sharp(source).extract(extract).extend({...extend,extendWith:'copy'}).png({compressionLevel:9}).toBuffer();
    mask=await sharp(mask).extract(extract).extend({...extend,background:{r:255,g:255,b:255,alpha:1}}).png({compressionLevel:9}).toBuffer();
    return {source,mask,requestSource};
  }
  async rasterize(width:number,height:number,strokes:MaskStroke[]){
    const selection=await sharp(Buffer.from(maskSelectionSvg(width,height,strokes))).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const rgba=Buffer.alloc(width*height*4,255);
    for(let i=0;i<width*height;i++){
      const coverage=selection.data[i*selection.info.channels];
      rgba[i*4+3]=255-coverage;
    }
    return sharp(rgba,{raw:{width,height,channels:4}}).png({compressionLevel:9}).toBuffer();
  }
  async compose(source:Buffer, mask:Buffer, generated:Buffer, feather:number,crop?:MaskCrop,mode:MaskMode='strict') {
    const [base,region,result]=await Promise.all([decode(source),decode(mask),decode(generated)]);
    const {width,height}=base.info;
    if(region.info.width!==width||region.info.height!==height)throw new Error('合成蒙版尺寸与底图不同。');
    if(result.info.width!==(crop?.width??width)||result.info.height!==(crop?.height??height))throw new Error(crop?'模型返回尺寸与送入范围不同，无法按原坐标贴回；原始返回图已保留。':'模型返回尺寸与底图不同，无法严格合成；原始返回图已保留，可选择自然融合。');
    if(mode==='natural')feather=0;
    if(crop)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const inside=x>=crop.x&&x<crop.x+crop.width&&y>=crop.y&&y<crop.y+crop.height;
      if(!inside||mode==='natural')region.data[(y*width+x)*4+3]=inside?0:255;
    }
    const count=width*height, distance=new Uint16Array(count);
    if(feather){
      // Feather only towards protected pixels inside the image. Missing neighbours
      // beyond the canvas are not protected pixels; crop boundaries still are.
      const limit=feather+1;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const i=y*width+x;
        distance[i]=region.data[i*4+3]===255?0:Math.min(x?distance[i-1]+1:limit,y?distance[i-width]+1:limit,limit);
      }
      for(let y=height-1;y>=0;y--)for(let x=width-1;x>=0;x--){
        const i=y*width+x;if(distance[i])distance[i]=Math.min(distance[i],x+1<width?distance[i+1]+1:limit,y+1<height?distance[i+width]+1:limit);
      }
    }
    const out=Buffer.from(base.data);
    for(let i=0;i<count;i++){
      const coverage=(255-region.data[i*4+3])/255;
      if(!coverage)continue; // Exact copy, including RGB in fully transparent pixels.
      const weight=coverage*(feather?Math.min(1,distance[i]/(feather+1)):1);
      const ri=crop?((Math.floor(i/width)-crop.y)*crop.width+i%width-crop.x):i;
      const ba=base.data[i*4+3]/255,ra=result.data[ri*4+3]/255,a=ba*(1-weight)+ra*weight;
      for(let c=0;c<3;c++)out[i*4+c]=a?Math.round((base.data[i*4+c]*ba*(1-weight)+result.data[ri*4+c]*ra*weight)/a):0;
      out[i*4+3]=Math.round(a*255);
    }
    return sharp(out,{raw:{width,height,channels:4}}).png().toBuffer();
  }
}
