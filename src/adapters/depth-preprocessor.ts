import sharp from 'sharp';
import * as ort from 'onnxruntime-node';

const internalMaxEdge=518,patchSize=14;
const mean=[0.485,0.456,0.406],standardDeviation=[0.229,0.224,0.225];
export interface DepthInput {
  pixels:Float32Array;
  width:number;height:number;
  contentWidth:number;contentHeight:number;
  sourceWidth:number;sourceHeight:number;
}

// Keep geometry intact; edge padding makes the transformer patch grid divisible by 14.
// The user's 512/1K choice controls the source/output size, not the inference tensor.
export async function prepareDepthInput(bytes:Buffer):Promise<DepthInput>{
  const source=sharp(bytes,{failOn:'warning',limitInputPixels:40_000_000});
  const metadata=await source.metadata();
  if(!metadata.width||!metadata.height)throw new Error('深度预处理无法读取参考图尺寸。');
  const sideways=metadata.orientation!==undefined&&metadata.orientation>=5&&metadata.orientation<=8;
  const sourceWidth=sideways?metadata.height:metadata.width,sourceHeight=sideways?metadata.width:metadata.height;
  const scale=Math.min(1,internalMaxEdge/Math.max(sourceWidth,sourceHeight));
  const contentWidth=Math.max(1,Math.round(sourceWidth*scale)),contentHeight=Math.max(1,Math.round(sourceHeight*scale));
  const {data,info}=await source.rotate().resize(contentWidth,contentHeight,{fit:'fill',kernel:'cubic'})
    .flatten({background:'#ffffff'}).toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
  if(info.channels!==3)throw new Error('深度预处理无法转换参考图颜色。');
  const width=Math.ceil(contentWidth/patchSize)*patchSize,height=Math.ceil(contentHeight/patchSize)*patchSize;
  const plane=width*height,pixels=new Float32Array(plane*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const sourceIndex=(Math.min(y,contentHeight-1)*contentWidth+Math.min(x,contentWidth-1))*3,index=y*width+x;
    for(let channel=0;channel<3;channel++)pixels[channel*plane+index]=(data[sourceIndex+channel]/255-mean[channel])/standardDeviation[channel];
  }
  return {pixels,width,height,contentWidth,contentHeight,sourceWidth,sourceHeight};
}

export async function renderDepthImage(depth:Float32Array,dims:readonly number[],input:DepthInput):Promise<Buffer>{
  if(dims.length!==3||dims[0]!==1||dims[1]!==input.height||dims[2]!==input.width||depth.length!==input.width*input.height)
    throw new Error('深度模型输出尺寸不符合固定版本约定。');
  let min=Infinity,max=-Infinity;
  for(let y=0;y<input.contentHeight;y++)for(let x=0;x<input.contentWidth;x++){
    const value=depth[y*input.width+x];
    if(!Number.isFinite(value))throw new Error('深度模型输出含有无效数值。');
    min=Math.min(min,value);max=Math.max(max,value);
  }
  const gray=Buffer.alloc(input.contentWidth*input.contentHeight),range=max-min;
  if(range>0)for(let y=0;y<input.contentHeight;y++)for(let x=0;x<input.contentWidth;x++)
    gray[y*input.contentWidth+x]=Math.round((depth[y*input.width+x]-min)/range*255);
  // Relative inverse depth: nearer regions are brighter. This is an ordinary PNG,
  // not a declaration that the destination generator supports depth conditioning.
  return sharp(gray,{raw:{width:input.contentWidth,height:input.contentHeight,channels:1}})
    .resize(input.sourceWidth,input.sourceHeight,{fit:'fill',kernel:'cubic'}).png().toBuffer();
}

export async function depthImage(bytes:Buffer,modelPath:string,isCancelled?:()=>boolean):Promise<Buffer>{
  const checkCancelled=()=>{if(isCancelled?.())throw new Error('图像预处理已取消。');};
  checkCancelled();
  const input=await prepareDepthInput(bytes);
  checkCancelled();
  const session=await ort.InferenceSession.create(modelPath,{executionProviders:['cpu'],intraOpNumThreads:2,graphOptimizationLevel:'all'});
  let inputTensor:ort.Tensor|undefined,output:ort.InferenceSession.ReturnType|undefined;
  try{
    checkCancelled();
    if(!session.inputNames.includes('pixel_values')||!session.outputNames.includes('predicted_depth'))throw new Error('深度模型接口不符合固定版本约定。');
    inputTensor=new ort.Tensor('float32',input.pixels,[1,3,input.height,input.width]);
    output=await session.run({pixel_values:inputTensor},['predicted_depth']);
    checkCancelled();
    const depth=output.predicted_depth;
    if(!depth||depth.type!=='float32'||!(depth.data instanceof Float32Array))throw new Error('深度模型没有返回有效深度图。');
    const result=await renderDepthImage(depth.data,depth.dims,input);
    checkCancelled();return result;
  }finally{
    inputTensor?.dispose();
    if(output)for(const value of Object.values(output))if(value instanceof ort.Tensor)value.dispose();
    await session.release();
  }
}
