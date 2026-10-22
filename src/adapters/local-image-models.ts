import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,rename,stat,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';

export type LocalImageModelKind='depth'|'segment';
export interface LocalImageModelFile {role:string;name:string;url:string;sha256:string;size:number}
export interface LocalImageModelManifest {title:string;repository:string;revision:string;license:string;upstream:string;files:readonly LocalImageModelFile[]}
const depthRevision='c3b67641fd837b2368757101311e5d21e511441e';
const segmentRevision='0d3b403339b4674a82493d5e97964dd78089ddc8';
// Sources are pinned data artifacts, never remote executable model code.
export const localImageModels:Record<LocalImageModelKind,LocalImageModelManifest>={
  depth:{title:'Depth Anything V2 Small',repository:'https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX',revision:depthRevision,license:'Apache-2.0',upstream:'https://github.com/DepthAnything/Depth-Anything-V2',files:[
    {role:'model',name:'model.onnx',url:`https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX/resolve/${depthRevision}/onnx/model.onnx`,sha256:'345f249eda90f33e0548890f2fe1e89662c1dbb5a8b7c10a50492558f65e85a3',size:127382},
    {role:'weights',name:'model.onnx_data',url:`https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX/resolve/${depthRevision}/onnx/model.onnx_data`,sha256:'c4fba31e921953367d8c5348b92296b2bf41f9cef9745ffaca01e2b1653e6d08',size:98798080},
  ]},
  segment:{title:'MobileSAM',repository:'https://huggingface.co/Acly/MobileSAM',revision:segmentRevision,license:'Apache-2.0 (MobileSAM upstream); MIT (ONNX conversion)',upstream:'https://github.com/ChaoningZhang/MobileSAM',files:[
    {role:'encoder',name:'mobile_sam_image_encoder.onnx',url:`https://huggingface.co/Acly/MobileSAM/resolve/${segmentRevision}/mobile_sam_image_encoder.onnx`,sha256:'580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',size:28157093},
    {role:'decoder',name:'sam_mask_decoder_multi.onnx',url:`https://huggingface.co/Acly/MobileSAM/resolve/${segmentRevision}/sam_mask_decoder_multi.onnx`,sha256:'8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',size:16496559},
  ]},
};

export function modelDirectory(runtimeDirectory:string){return path.resolve(runtimeDirectory,'local-image-models');}
function modelEntry(kind:LocalImageModelKind){const entry=localImageModels[kind];if(!entry)throw new Error('不支持的本地图像处理模型。');return entry;}
function filePath(runtimeDirectory:string,kind:LocalImageModelKind,file:LocalImageModelFile){return path.join(modelDirectory(runtimeDirectory),kind,file.name);}
const checks=new Map<string,{stamp:string;promise:Promise<boolean>}>();
async function verified(filename:string,file:LocalImageModelFile):Promise<boolean>{
  let info;try{info=await stat(filename);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  if(!info.isFile()||info.size!==file.size)return false;
  const stamp=`${info.size}:${info.mtimeMs}:${info.ctimeMs}:${file.sha256}`,cached=checks.get(filename);
  if(cached?.stamp===stamp)return cached.promise;
  const promise=(async()=>{const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);return hash.digest('hex')===file.sha256;})();
  checks.set(filename,{stamp,promise});
  try{return await promise;}catch(error){checks.delete(filename);throw error;}
}

export async function resolveLocalImageModel(runtimeDirectory:string,kind:LocalImageModelKind):Promise<Record<string,string>>{
  const entry=modelEntry(kind),files:Record<string,string>={};
  for(const file of entry.files){const filename=filePath(runtimeDirectory,kind,file);if(!await verified(filename,file))throw new Error(`${entry.title} 本地资源未准备或校验失败，请在模块设置中下载资源。`);files[file.role]=filename;}
  return files;
}

export async function localImageModelStatus(runtimeDirectory:string):Promise<Record<LocalImageModelKind,'missing'|'ready'>>{
  const status=async(kind:LocalImageModelKind):Promise<'missing'|'ready'>=>{try{await resolveLocalImageModel(runtimeDirectory,kind);return 'ready';}catch{return 'missing';}};
  const [depth,segment]=await Promise.all([status('depth'),status('segment')]);return {depth,segment};
}

const preparing=new Map<string,Promise<void>>();
export async function prepareLocalImageModel(runtimeDirectory:string,kind:LocalImageModelKind,signal?:AbortSignal):Promise<void>{
  const entry=modelEntry(kind),directory=path.join(modelDirectory(runtimeDirectory),kind),active=preparing.get(directory);
  if(active)return active;
  const operation=(async()=>{
    await mkdir(directory,{recursive:true});
    for(const file of entry.files){
      if(signal?.aborted)throw new Error('本地资源下载已取消。');
      const filename=filePath(runtimeDirectory,kind,file);if(await verified(filename,file))continue;
      const temporary=path.join(directory,`${file.name}.${randomUUID()}.tmp`);
      try{
        const response=await fetch(file.url,{signal:AbortSignal.any([AbortSignal.timeout(180_000),...(signal?[signal]:[])])});
        if(!response.ok||!response.body)throw new Error(`下载失败（HTTP ${response.status}）`);
        const length=response.headers.get('content-length');if(length&&Number(length)!==file.size){await response.body.cancel();throw new Error('下载文件大小与固定版本不符');}
        const handle=await open(temporary,'wx'),hash=createHash('sha256'),reader=response.body.getReader();let size=0;
        try{
          while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>file.size)throw new Error('下载文件超过固定版本大小');hash.update(value);await handle.writeFile(value);}
          if(size!==file.size||hash.digest('hex')!==file.sha256)throw new Error('下载文件校验失败');
        }finally{await reader.cancel().catch(()=>{});await handle.close();}
        await rename(temporary,filename);checks.delete(filename);
      }catch(error){await unlink(temporary).catch(()=>{});throw new Error(`${entry.title} 资源下载未完成：${error instanceof Error?error.message:'未知错误'}。未自动切换来源。`);}
    }
    // Keep provenance beside optional weights, including after offline copying.
    await writeFile(path.join(directory,'source.json'),JSON.stringify({...entry,prepared_at:new Date().toISOString()},null,2),'utf8');
    await resolveLocalImageModel(runtimeDirectory,kind);
  })();
  preparing.set(directory,operation);
  try{await operation;}finally{preparing.delete(directory);}
}
