import sharp from 'sharp';
import { z } from 'zod';
import type { AdapterDescription } from '../core/model-library.js';
import type { CloudExecutionContext, ExecutionResult } from '../core/ports.js';
import { defaultImagesCompatibility } from '../core/domain.js';
import { captureModelInput } from './capture-model-input.js';
import { imagesProfile } from '../protocols/generation-profiles.js';
import { normalizeParameters,extensionOptions,validateGenerationParameters } from '../core/generation-parameters.js';
import { validSize } from '../core/generation-contract.js';
import {validateImagesUpload} from '../core/image-limits.js';
const validImagesSize=(w:number,h:number)=>validSize(w,h,imagesProfile.size_limits!);

const sizes:Record<string,string>={'1:1':'1024x1024','3:2':'1536x1024','2:3':'1024x1536'};
const qualities=['low','medium','high','xhigh','max','auto'];
export function imagesRoot(endpoint:string){
  const url=new URL(endpoint);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Images 连接须为无凭据和查询参数的 HTTPS 地址。');
  const p=url.pathname.replace(/\/$/,'');
  if(p.endsWith('/v1beta')||p.endsWith('/images/generations')||p.endsWith('/images/edits'))throw new Error('请输入 Images 服务根地址或 /v1 地址。');
  url.pathname=p.endsWith('/v1')?p:`${p}/v1`;return url.toString().replace(/\/$/,'');
}
async function json(response:Response){
  const reader=response.body?.getReader();if(!reader)throw new Error('空响应');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>60*1024*1024)throw new Error('响应过大');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  finally{await reader.cancel().catch(()=>{});}
}
const resultSchema=z.object({data:z.array(z.object({b64_json:z.string().optional(),url:z.string().optional()})).max(10),id:z.string().optional(),usage:z.record(z.string(),z.unknown()).optional()});
export class ImagesGenerator {
  readonly description:AdapterDescription={generation_contract:imagesProfile,geometry_support:'size',adapter_id:'openai-images',version:6,title:'OpenAI Images／兼容协议',kind:'cloud',installed:true,purposes:['generation'],requires_credential:true,supports_probe:true,interleaving:['separated'],operations:['generate','referenceEdit','nativeMaskEdit'],parameters:[{key:'aspect_ratio',title:'比例'},{key:'quality',title:'质量',values:qualities},{key:'output_format',title:'格式',values:['png','jpeg','webp']},{key:'count',title:'数量',maximum:10}]};
  constructor(private request:typeof fetch=fetch){}
  private async call(url:string,key:string,body:string|FormData|undefined,signal:AbortSignal){
    let response:Response;
    try{response=await this.request(url,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${key}`,...(typeof body==='string'?{'Content-Type':'application/json'}:{})},body,signal,redirect:'error'});}
    catch{throw new Error(signal.aborted?signal.reason?.name==='TimeoutError'?'等待 Images 服务超过 10 分钟，客户端已停止等待；上游可能仍在生成，计费状态未知，未自动重试。':'请求已取消，上游计费状态未知；未自动重试。':'无法连接 Images 服务，上游是否收到请求未知；未自动重试。');}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error(response.status===401||response.status===403?'Images 鉴权失败或权限不足。':response.status===429?'Images 额度不足或请求受限。':response.status===413?'Images 渠道拒绝了请求体大小，请缩小送入范围或按渠道上限调低请求预算；未自动重试。':`Images 服务返回 HTTP ${response.status}，请核对模型与参数；未自动重试。`);}
    try{return await json(response);}catch{throw new Error('Images 响应读取或解析失败，上游计费状态未知；未自动重试。');}
  }
  async probe(endpoint:string,key:string,signal:AbortSignal){
    const data=z.object({data:z.array(z.object({id:z.string().min(1).max(200)})).max(10000)}).parse(await this.call(`${imagesRoot(endpoint)}/models`,key,undefined,signal));
    return [...new Set(data.data.map(m=>m.id))];
  }
  async execute(context:CloudExecutionContext,signal:AbortSignal,progress:(stage:string,value:number)=>Promise<void>):Promise<ExecutionResult>{
    const {job,model}=context,input=job.adapted_input,p=normalizeParameters(job.recipe_snapshot.core_parameters,model);
    validateGenerationParameters(p,model);
    if(model.purpose==='understanding'||input.kind!=='separated_inputs')throw new Error('Images 适配器需要参考图集合与提示词，仅支持生图用途。');
    const compatibility=model.images_compatibility??defaultImagesCompatibility;
    const hint=!job.execution_plan&&job.output_geometry?.target==='auto'&&job.output_geometry.ratio?`\n\n期望输出画面的宽高比为 ${job.output_geometry.ratio}，请尽量保持该比例。`:'';
    const prompt=(input.prompt??'')+hint,ids=input.image_asset_ids??[];
    if(!prompt.trim()||Array.from(prompt).length>compatibility.max_prompt_chars)throw new Error(`当前 Images 配置要求非空提示词且不超过 ${compatibility.max_prompt_chars} 个字符；请精简模块内容，不会自动截断。`);
    const geometry=job.output_geometry,size=geometry?.target==='size'?geometry.request_size:geometry?.target==='ratio'?sizes[geometry.request_ratio??'']:geometry?.target==='auto'||p.aspect_ratio==='auto'?'auto':sizes[p.aspect_ratio];
    if(size&&size!=='auto'){const [width,height]=size.split('x').map(Number);if(!validImagesSize(width,height))throw new Error('请求尺寸超出 Images 参数边界。');}
    if(!size||!qualities.includes(p.quality)||!['png','jpeg','webp'].includes(p.output_format)||!Number.isInteger(p.count)||p.count<1||p.count>10||ids.length>16)throw new Error('当前 Images 支持 1:1、3:2、2:3、自动与受限自定义尺寸，最多 16 参考图、1–10 输出；请检查参数。');
    if(!model.capabilities.operations.includes(job.mask_edit?'nativeMaskEdit':ids.length?'referenceEdit':'generate'))throw new Error('模型未声明本次 Images 操作能力。');
    if(job.mask_edit&&(ids.length!==1||ids[0]!==(job.mask_edit.request_source_id??job.mask_edit.source_snapshot_id)||p.count!==1))throw new Error('蒙版必须绑定本次第一张底图，且只生成一个结果。');
    const fields={model:model.model,prompt,size,quality:p.quality,[compatibility.format_field]:p.output_format,n:p.count,...extensionOptions(p,model),...(compatibility.send_response_format?{response_format:'b64_json'}:{})};
    let body:string|FormData=JSON.stringify(fields);
    if(ids.length){const form=new FormData();for(const [key,value] of Object.entries(fields))form.append(key,String(value));let size=Buffer.byteLength(prompt);
      for(const [index,id] of ids.entries()){
        if(signal.aborted)throw new Error('任务已取消。');const bytes=await context.readImage(id);size+=bytes.length;
        validateImagesUpload(bytes.length,size,compatibility);
        let meta;try{meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();await sharp(bytes,{limitInputPixels:40_000_000}).stats();}catch{throw new Error('参考图无法完整解码。');}
        if(!['png','jpeg','webp'].includes(meta.format??''))throw new Error('参考图格式不支持。');
        form.append(compatibility.image_field,new Blob([new Uint8Array(bytes)],{type:`image/${meta.format}`}),`reference-${index+1}.${meta.format}`);
      }
      if(job.mask_edit){
        const bytes=await context.readImage(job.mask_edit.mask_asset_id);size+=bytes.length;
        validateImagesUpload(bytes.length,size,compatibility);
        const [maskMeta,baseMeta]=await Promise.all([sharp(bytes).metadata(),sharp(await context.readImage(ids[0])).metadata()]);
        await sharp(bytes,{limitInputPixels:40_000_000}).stats();
        if(maskMeta.format!=='png'||baseMeta.format!=='png'||!maskMeta.hasAlpha||maskMeta.width!==baseMeta.width||maskMeta.height!==baseMeta.height)throw new Error('蒙版与底图必须为相同尺寸的 PNG，蒙版需要透明通道。');
        const alpha=await sharp(bytes).ensureAlpha().extractChannel('alpha').raw().toBuffer();
        if(!alpha.some(value=>value<255))throw new Error('蒙版没有可编辑区域。');
        form.append('mask',new Blob([new Uint8Array(bytes)],{type:'image/png'}),'mask.png');
      }
      body=form;
    }
    if(signal.aborted)throw new Error('任务已取消。');
    await progress('等待 Images 返回图片（无上游百分比）',30);
    const requestUrl=`${imagesRoot(model.endpoint)}/images/${ids.length?'edits':'generations'}`;
    await captureModelInput(context,new URL(requestUrl).pathname,body);
    if(signal.aborted)throw new Error('任务已取消，未发送请求。');
    const raw=await this.call(requestUrl,await context.resolveCredential(),body,AbortSignal.any([signal,AbortSignal.timeout(600_000)]));
    const parsed=resultSchema.safeParse(raw);if(!parsed.success)throw new Error('Images 返回结构不受支持，没有保存不完整结果。');const data=parsed.data;
    if(data.data.length!==p.count)throw new Error('Images 返回数量与任务不一致，没有保存不完整结果。');
    const images:ExecutionResult['images']=[];
    for(const item of data.data){const encoded=item.b64_json;
      if(!encoded)throw new Error('Images 未按请求返回 Base64 图片；当前不下载 URL 结果，未自动重试。');
      if(encoded.length%4===1||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('Images 返回无效 Base64 图片。');
      const bytes=Buffer.from(encoded,'base64');let meta;
      try{meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();await sharp(bytes,{limitInputPixels:40_000_000}).stats();}catch{throw new Error('Images 图片无法完整解码。');}
      if(!meta.width||!meta.height||!['png','jpeg','webp'].includes(meta.format??''))throw new Error('Images 图片格式或尺寸无效。');
      images.push({bytes,format:meta.format as 'png'|'jpeg'|'webp',width:meta.width,height:meta.height});
    }
    const usage=Object.fromEntries(Object.entries(data.usage??{}).filter((entry):entry is [string,number]=>typeof entry[1]==='number'&&Number.isFinite(entry[1])));
    return {images,request_id:data.id?.slice(0,200),usage};
  }
}
