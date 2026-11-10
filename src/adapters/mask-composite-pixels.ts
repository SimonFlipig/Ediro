import type {MaskCrop,MaskMode} from '../core/mask.js';

// Pure pixel math is shared by the exact output compositor and its preview worker.
// Keep this self-contained: the worker evaluates the emitted JavaScript function.
export function composeMaskPixels(base:Uint8Array,region:Uint8Array,result:Uint8Array,width:number,height:number,feather:number,crop?:MaskCrop,mode:MaskMode='strict'){
  if(mode==='natural')feather=0;
  if(crop)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const inside=x>=crop.x&&x<crop.x+crop.width&&y>=crop.y&&y<crop.y+crop.height;
    if(!inside||mode==='natural')region[(y*width+x)*4+3]=inside?0:255;
  }
  const count=width*height,distance=feather?(Number.isInteger(feather)?new Uint16Array(count):new Float32Array(count)):undefined;
  if(feather){
    // Feather towards protected pixels inside the image. Missing neighbours
    // beyond the canvas are not protected pixels; crop boundaries still are.
    const limit=feather+1;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const i=y*width+x;
      distance![i]=region[i*4+3]===255?0:Math.min(x?distance![i-1]+1:limit,y?distance![i-width]+1:limit,limit);
    }
    for(let y=height-1;y>=0;y--)for(let x=width-1;x>=0;x--){
      const i=y*width+x;if(distance![i])distance![i]=Math.min(distance![i],x+1<width?distance![i+1]+1:limit,y+1<height?distance![i+width]+1:limit);
    }
  }
  const out=new Uint8Array(base);
  for(let i=0;i<count;i++){
    const coverage=(255-region[i*4+3])/255;
    if(!coverage)continue; // Exact copy, including RGB in fully transparent pixels.
    const weight=coverage*(feather?Math.min(1,distance![i]/(feather+1)):1);
    const ri=crop?((Math.floor(i/width)-crop.y)*crop.width+i%width-crop.x):i;
    const ba=base[i*4+3]/255,ra=result[ri*4+3]/255,a=ba*(1-weight)+ra*weight;
    for(let c=0;c<3;c++)out[i*4+c]=a?Math.round((base[i*4+c]*ba*(1-weight)+result[ri*4+c]*ra*weight)/a):0;
    out[i*4+3]=Math.round(a*255);
  }
  return out;
}
