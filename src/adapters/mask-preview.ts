import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {composeMaskPixels} from './mask-composite-pixels.js';
import {maskSelectionSvg,type MaskMode,type MaskPreviewInput,type MaskPreviewSession,type MaskStroke} from '../core/mask.js';

export const MASK_PREVIEW_MAX_EDGE=1536;

// An eval worker resolves sharp from the host installation and works both from
// built Electron sources and source-level tsx tests without a second TS loader.
const workerSource=String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const sharp=require(workerData.sharpPath);
const composeMaskPixels=(${composeMaskPixels.toString()});
const maskSelectionSvg=(${maskSelectionSvg.toString()});
const decode=bytes=>sharp(Buffer.from(bytes),{limitInputPixels:40_000_000}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
let input=workerData.input;workerData.input=null;
const ready=(async()=>{
  const source=await decode(input.source),generated=await decode(input.generated);
  if(source.info.width!==input.width||source.info.height!==input.height)throw new Error('底图尺寸已改变，请重新进入局部编辑。');
  const wantedWidth=input.crop?.width??input.width,wantedHeight=input.crop?.height??input.height;
  if(input.guided){
    if(Math.abs((generated.info.width/generated.info.height)/(wantedWidth/wantedHeight)-1)>.02)throw new Error('模型返回的画面比例与送入范围不同，无法可靠贴回；原始返回图已保留，请查看模型原始返回。');
  }else if(generated.info.width!==wantedWidth||generated.info.height!==wantedHeight)throw new Error('模型返回尺寸与送入范围或底图不同，无法严格合成；原始返回图已保留。');
  const scale=Math.min(1,workerData.maxEdge/Math.max(input.width,input.height,wantedWidth,wantedHeight));
  const width=Math.max(1,Math.round(input.width*scale)),height=Math.max(1,Math.round(input.height*scale));
  const crop=input.crop?{x:Math.round(input.crop.x*scale),y:Math.round(input.crop.y*scale),width:Math.max(1,Math.round((input.crop.x+input.crop.width)*scale)-Math.round(input.crop.x*scale)),height:Math.max(1,Math.round((input.crop.y+input.crop.height)*scale)-Math.round(input.crop.y*scale))}:undefined;
  const resize=async(image,w,h)=>image.info.width===w&&image.info.height===h?image.data:sharp(image.data,{raw:image.info}).resize(w,h,{fit:'fill',kernel:'lanczos3'}).raw().toBuffer();
  const base=await resize(source,width,height),result=await resize(generated,crop?.width??width,crop?.height??height);
  const originalWidth=input.width,originalHeight=input.height;input=null;parentPort.postMessage({ready:true});
  return {base,result,width,height,crop,scale,originalWidth,originalHeight};
})();
ready.catch(error=>parentPort.postMessage({error:error.message}));
let queue=ready;
parentPort.on('message',message=>{
  queue=queue.then(async state=>{
    try{
      const svg=maskSelectionSvg(state.originalWidth,state.originalHeight,message.strokes).replace(/width="[0-9]+" height="[0-9]+"/,'width="'+state.width+'" height="'+state.height+'"');
      const selection=await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({resolveWithObject:true});
      const region=Buffer.alloc(state.width*state.height*4,255);
      for(let i=0;i<state.width*state.height;i++)region[i*4+3]=255-selection.data[i*selection.info.channels];
      const feather=message.feather?Math.max(0,(message.feather+1)*state.scale-1):0;
      const out=composeMaskPixels(state.base,region,state.result,state.width,state.height,feather,state.crop,message.mode);
      const bytes=await sharp(out,{raw:{width:state.width,height:state.height,channels:4}}).png({compressionLevel:state.scale===1?6:1}).toBuffer();
      parentPort.postMessage({id:message.id,bytes});
    }catch(error){parentPort.postMessage({id:message.id,error:error.message});}
    return state;
  });
});
`;

export async function createMaskPreview(input:MaskPreviewInput):Promise<MaskPreviewSession>{
  const worker=new Worker(workerSource,{eval:true,execArgv:[],workerData:{sharpPath:createRequire(import.meta.url).resolve('sharp'),input,maxEdge:MASK_PREVIEW_MAX_EDGE}});
  let disposed=false,nextId=0,failure:Error|undefined;
  const requests=new Map<number,{resolve:(bytes:Buffer)=>void;reject:(error:Error)=>void}>();
  let readyResolve:()=>void,readyReject:(error:Error)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const fail=(error:Error)=>{failure=error;readyReject(error);for(const request of requests.values())request.reject(error);requests.clear();};
  worker.on('message',(message:{ready?:boolean;id?:number;bytes?:Uint8Array;error?:string})=>{
    if(message.ready){readyResolve();worker.unref();return;}
    if(message.id===undefined){fail(new Error(message.error??'预览初始化失败。'));return;}
    const request=requests.get(message.id);if(!request)return;requests.delete(message.id);
    if(message.error)request.reject(new Error(message.error));else request.resolve(Buffer.from(message.bytes!));
    if(!requests.size)worker.unref();
  });
  worker.on('error',fail);worker.on('exit',code=>{if(!disposed)fail(new Error(`预览进程已退出 (${code})。`));});
  try{await ready;}catch(error){disposed=true;void worker.terminate();throw error;}
  return {
    render(strokes:MaskStroke[],mode:MaskMode,feather:number){
      if(disposed||failure)return Promise.reject(failure??new Error('预览已关闭。'));
      const id=++nextId;worker.ref();
      return new Promise<Buffer>((resolve,reject)=>{requests.set(id,{resolve,reject});worker.postMessage({id,strokes,mode,feather});});
    },
    dispose(){if(disposed)return;disposed=true;fail(new Error('预览已关闭。'));void worker.terminate();},
  };
}
