import sharp from 'sharp';
import {InferenceSession,Tensor} from 'onnxruntime-node';

export interface SegmentationModelPaths {encoder:string;decoder:string}
export interface RegionMask {pixels:Uint8Array;area:number;quality:number}

// MobileSAM predicts regions, not object-class labels. These limits keep the
// fully automatic CPU path bounded: one encoder call and sixty-four point prompts.
const modelEdge=1024,maskEdge=256,pointsPerSide=8;
const minimumQuality=0.78,minimumStability=0.88,maximumRegions=32;

function checkedFloatTensor(value:unknown,name:string,shape:readonly number[]):Tensor {
  if(!(value instanceof Tensor)||value.type!=='float32'||value.dims.length!==shape.length||value.dims.some((dimension,index)=>dimension!==shape[index]))throw new Error(`${name} 的模型输出格式不匹配。`);
  return value;
}

function disposeOutputs(outputs:InferenceSession.ReturnType){for(const value of Object.values(outputs))if(value instanceof Tensor)value.dispose();}

// The decoder's 256-square logits describe the padded 1024-square encoder input.
// Map pixel centres through the resized, unpadded image before thresholding, so
// portrait and landscape inputs do not inherit the padded background as content.
function decodedMask(logits:Float32Array,index:number,width:number,height:number,resizedWidth:number,resizedHeight:number,minimumArea:number):Omit<RegionMask,'quality'>|null {
  const pixels=new Uint8Array(width*height),offset=index*maskEdge*maskEdge;
  const left=new Uint16Array(width),right=new Uint16Array(width),weight=new Float32Array(width);
  for(let x=0;x<width;x++){
    const source=Math.max(0,Math.min(maskEdge-1,(x+0.5)*resizedWidth/width/4-0.5));
    left[x]=Math.floor(source);right[x]=Math.min(maskEdge-1,left[x]+1);weight[x]=source-left[x];
  }
  let area=0,inner=0,outer=0;
  for(let y=0;y<height;y++){
    const source=Math.max(0,Math.min(maskEdge-1,(y+0.5)*resizedHeight/height/4-0.5));
    const top=Math.floor(source),bottom=Math.min(maskEdge-1,top+1),vertical=source-top;
    for(let x=0;x<width;x++){
      const a=logits[offset+top*maskEdge+left[x]],b=logits[offset+top*maskEdge+right[x]];
      const c=logits[offset+bottom*maskEdge+left[x]],d=logits[offset+bottom*maskEdge+right[x]];
      const value=(a+(b-a)*weight[x])*(1-vertical)+(c+(d-c)*weight[x])*vertical;
      if(!Number.isFinite(value))throw new Error('区域分割模型返回了无效数值。');
      if(value>0){pixels[y*width+x]=1;area++;}
      if(value>1)inner++;
      if(value>-1)outer++;
    }
  }
  if(area<minimumArea||area>width*height*0.98||!outer||inner/outer<minimumStability)return null;
  return {pixels,area};
}

function rememberMask(masks:RegionMask[],candidate:RegionMask){
  for(let index=0;index<masks.length;index++){
    const previous=masks[index];
    if(Math.min(previous.area,candidate.area)/Math.max(previous.area,candidate.area)<0.88)continue;
    let intersection=0;
    for(let pixel=0;pixel<candidate.pixels.length;pixel++)if(previous.pixels[pixel]&&candidate.pixels[pixel])intersection++;
    if(intersection/(previous.area+candidate.area-intersection)>0.88){if(candidate.quality>previous.quality)masks[index]=candidate;return;}
  }
  masks.push(candidate);
}

// Split disconnected pieces after resolving overlaps, then merge small pieces
// into the neighbour sharing the longest border. This also fills small holes.
// Working with connected components prevents unrelated background areas from
// being painted with one shared colour just because SAM left both unlabelled.
function cleanedRegions(labels:Uint32Array,width:number,height:number,minimumArea:number):Uint32Array {
  const count=labels.length,components=new Uint32Array(count),queue=new Uint32Array(count);
  const sizes=[0];let next=0;
  for(let start=0;start<count;start++){
    if(components[start])continue;
    const id=++next,label=labels[start];let head=0,tail=1;queue[0]=start;components[start]=id;
    while(head<tail){
      const pixel=queue[head++],x=pixel%width;
      for(const neighbour of [x?pixel-1:-1,x+1<width?pixel+1:-1,pixel>=width?pixel-width:-1,pixel+width<count?pixel+width:-1]){
        if(neighbour<0||components[neighbour]||labels[neighbour]!==label)continue;
        components[neighbour]=id;queue[tail++]=neighbour;
      }
    }
    sizes[id]=tail;
  }
  const parent=Uint32Array.from({length:next+1},(_,index)=>index);
  const root=(id:number):number=>{while(parent[id]!==id){parent[id]=parent[parent[id]];id=parent[id];}return id;};
  const borders=new Map<number,Map<number,number>>();
  const addBorder=(a:number,b:number)=>{
    if(a===b)return;
    let neighbours=borders.get(a);if(!neighbours){neighbours=new Map();borders.set(a,neighbours);}
    neighbours.set(b,(neighbours.get(b)??0)+1);
  };
  for(let pixel=0;pixel<count;pixel++){
    const a=components[pixel];
    for(const neighbour of [pixel%width+1<width?pixel+1:-1,pixel+width<count?pixel+width:-1]){
      if(neighbour<0)continue;const b=components[neighbour];addBorder(a,b);addBorder(b,a);
    }
  }
  const order=Array.from({length:next},(_,index)=>index+1).sort((a,b)=>sizes[a]-sizes[b]||a-b);
  for(let position=0;position<order.length;position++){
    const original=order[position];
    const id=root(original);if(id!==original||sizes[id]>=minimumArea)continue;
    const neighbours=new Map<number,number>();
    for(const [adjacent,length] of borders.get(id)??[]){const candidate=root(adjacent);if(candidate!==id)neighbours.set(candidate,(neighbours.get(candidate)??0)+length);}
    let target=0,longest=0;
    for(const [candidate,length] of neighbours)if(length>longest||length===longest&&candidate<target){target=candidate;longest=length;}
    if(!target)continue;
    parent[id]=target;sizes[target]+=sizes[id];
    let targetBorders=borders.get(target);if(!targetBorders){targetBorders=new Map();borders.set(target,targetBorders);}
    for(const [adjacent,length] of borders.get(id)??[])targetBorders.set(adjacent,(targetBorders.get(adjacent)??0)+length);
    if(sizes[target]<minimumArea)order.push(target);
  }
  for(let pixel=0;pixel<count;pixel++)components[pixel]=root(components[pixel]);
  return components;
}

/** Resolve automatic masks into flat regions and preserve original transparency. */
export function regionMeanPixels(rgba:Uint8Array,width:number,height:number,masks:readonly RegionMask[],minimumArea=Math.max(4,Math.round(width*height*0.002))):Buffer {
  const count=width*height;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||rgba.length!==count*4||masks.some(mask=>mask.pixels.length!==count))throw new Error('区域图尺寸与像素不匹配。');
  const labels=new Uint32Array(count);
  // Larger masks establish the scene; smaller masks then preserve contained
  // objects. Stable area/quality ordering makes overlapping results repeatable.
  const ordered=[...masks].sort((a,b)=>b.area-a.area||a.quality-b.quality);
  for(let index=0;index<ordered.length;index++)for(let pixel=0;pixel<count;pixel++)if(ordered[index].pixels[pixel]&&rgba[pixel*4+3])labels[pixel]=index+1;
  const regions=cleanedRegions(labels,width,height,minimumArea),colours=new Map<number,[number,number,number,number]>();
  for(let pixel=0;pixel<count;pixel++){
    const offset=pixel*4,alpha=rgba[offset+3];if(!alpha)continue;
    const id=regions[pixel],sum=colours.get(id)??[0,0,0,0];
    sum[0]+=rgba[offset]*alpha;sum[1]+=rgba[offset+1]*alpha;sum[2]+=rgba[offset+2]*alpha;sum[3]+=alpha;colours.set(id,sum);
  }
  for(const sum of colours.values()){sum[0]=Math.round(sum[0]/sum[3]);sum[1]=Math.round(sum[1]/sum[3]);sum[2]=Math.round(sum[2]/sum[3]);}
  const result=Buffer.from(rgba);
  for(let pixel=0;pixel<count;pixel++){
    if(!rgba[pixel*4+3])continue;const colour=colours.get(regions[pixel])!;
    result[pixel*4]=colour[0];result[pixel*4+1]=colour[1];result[pixel*4+2]=colour[2];
  }
  return result;
}

/** Local, automatic MobileSAM region segmentation; no points are requested from the user. */
export async function segmentImage(bytes:Buffer,paths:SegmentationModelPaths,isCancelled?:()=>boolean):Promise<Buffer> {
  let encoder:InferenceSession|undefined,decoder:InferenceSession|undefined,embedding:Tensor|undefined;
  const checkCancelled=()=>{if(isCancelled?.())throw new Error('图像预处理已取消。');};
  try{
    checkCancelled();
    const {data:rgba,info}=await sharp(bytes,{limitInputPixels:1_048_576,failOn:'warning'}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
    checkCancelled();
    const {width,height}=info;
    if(Math.max(width,height)>modelEdge)throw new Error('请先将参考图缩至最长边 1K 或 512。');
    const scale=modelEdge/Math.max(width,height),resizedWidth=Math.max(1,Math.round(width*scale)),resizedHeight=Math.max(1,Math.round(height*scale));
    // The selected ONNX encoder already performs SAM normalization and padding.
    const rgb=await sharp(rgba,{raw:{width,height,channels:4}}).flatten({background:'#ffffff'}).resize(resizedWidth,resizedHeight,{fit:'fill',kernel:'linear'}).raw().toBuffer();
    checkCancelled();
    const options:InferenceSession.SessionOptions={executionProviders:['cpu'],intraOpNumThreads:4,interOpNumThreads:1,executionMode:'sequential',graphOptimizationLevel:'all'};
    encoder=await InferenceSession.create(paths.encoder,options);checkCancelled();
    decoder=await InferenceSession.create(paths.decoder,options);checkCancelled();
    if(encoder.inputNames.length!==1||encoder.inputNames[0]!=='input_image'||!encoder.outputNames.includes('image_embeddings')||!['image_embeddings','point_coords','point_labels','mask_input','has_mask_input','orig_im_size'].every(name=>decoder!.inputNames.includes(name))||!['iou_predictions','low_res_masks'].every(name=>decoder!.outputNames.includes(name)))throw new Error('区域分割模型与已支持的 MobileSAM 接口不匹配。');
    const input=new Tensor('float32',Float32Array.from(rgb),[resizedHeight,resizedWidth,3]);
    try{
      const output=await encoder.run({input_image:input},['image_embeddings']);
      try{embedding=checkedFloatTensor(output.image_embeddings,'图像编码',[1,256,64,64]);}catch(error){disposeOutputs(output);throw error;}
    }finally{input.dispose();}
    checkCancelled();
    const masks:RegionMask[]=[],minimumArea=Math.max(4,Math.round(width*height*0.002));
    const maskInput=new Tensor('float32',new Float32Array(maskEdge*maskEdge),[1,1,maskEdge,maskEdge]);
    const hasMask=new Tensor('float32',new Float32Array([0]),[1]),originalSize=new Tensor('float32',new Float32Array([height,width]),[2]);
    const labels=new Tensor('float32',new Float32Array([1,-1]),[1,2]);
    try{
      for(let y=0;y<pointsPerSide;y++)for(let x=0;x<pointsPerSide;x++){
        checkCancelled();
        const point=new Tensor('float32',new Float32Array([(x+0.5)*resizedWidth/pointsPerSide,(y+0.5)*resizedHeight/pointsPerSide,0,0]),[1,2,2]);
        let output:InferenceSession.ReturnType|undefined;
        try{
          output=await decoder.run({image_embeddings:embedding,point_coords:point,point_labels:labels,mask_input:maskInput,has_mask_input:hasMask,orig_im_size:originalSize},['iou_predictions','low_res_masks']);
          checkCancelled();
          const quality=checkedFloatTensor(output.iou_predictions,'区域评分',[1,4]).data as Float32Array;
          const logits=checkedFloatTensor(output.low_res_masks,'区域掩码',[1,4,maskEdge,maskEdge]).data as Float32Array;
          // Index 0 is SAM's single-mask token; 1..3 are its multimask proposals.
          for(let index=1;index<4;index++){
            if(!Number.isFinite(quality[index]))throw new Error('区域分割模型返回了无效评分。');
            if(quality[index]<minimumQuality)continue;
            const candidate=decodedMask(logits,index,width,height,resizedWidth,resizedHeight,minimumArea);
            if(candidate)rememberMask(masks,{...candidate,quality:quality[index]});
          }
        }finally{point.dispose();if(output)disposeOutputs(output);}
      }
    }finally{maskInput.dispose();hasMask.dispose();originalSize.dispose();labels.dispose();}
    checkCancelled();
    if(!masks.length)throw new Error('未识别到稳定区域，请选择其他预处理方式。');
    const kept=masks.sort((a,b)=>b.quality-a.quality).slice(0,maximumRegions);
    const output=regionMeanPixels(rgba,width,height,kept,minimumArea);
    checkCancelled();
    const result=await sharp(output,{raw:{width,height,channels:4}}).png().toBuffer();
    checkCancelled();return result;
  }catch(error){throw new Error(`参考图区域分割失败：${error instanceof Error?error.message:String(error)}`,{cause:error});}
  finally{embedding?.dispose();await Promise.allSettled([encoder?.release(),decoder?.release()]);}
}
