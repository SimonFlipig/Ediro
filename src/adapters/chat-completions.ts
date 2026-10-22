import sharp from 'sharp';
import { z } from 'zod';
import type { AdapterDescription } from '../core/model-library.js';
import type { CloudExecutionContext, CloudExecutionPort, ExecutionResult } from '../core/ports.js';
import { extensionOptions, normalizeParameters, validateGenerationParameters } from '../core/generation-parameters.js';
import { chatProfile } from '../protocols/chat-profile.js';
import { captureModelInput } from './capture-model-input.js';
import { readReferenceImage } from './reference-image.js';

const MB=1024*1024;
const MAX_IMAGE_BYTES=20*MB,MAX_REQUEST_BYTES=50*MB,MAX_RESPONSE_BYTES=2*MB,MAX_TEXT_CHARS=32000;
const optionsSchema=z.object({
  temperature:z.number().min(0).max(2).optional(),
  reasoning_effort:z.enum(['low','medium','high']).optional(),
  max_output_tokens:z.number().int().min(1).max(32768).default(16384),
  token_limit_field:z.enum(['max_completion_tokens','max_tokens']).default('max_completion_tokens'),
  image_detail:z.enum(['auto','low','high']).optional(),
}).strict();
const responseSchema=z.object({
  id:z.string().nullish(),
  choices:z.array(z.object({
    finish_reason:z.string().nullish(),
    message:z.object({
      content:z.string().nullish(),refusal:z.string().nullish(),
      tool_calls:z.array(z.unknown()).nullish(),function_call:z.unknown().optional(),audio:z.unknown().optional(),
    }),
  })).min(1).max(10),
  usage:z.record(z.string(),z.unknown()).nullish(),
});
type ContentPart={type:'text';text:string}|{type:'image_url';image_url:{url:string;detail?:'auto'|'low'|'high'}};

export function chatRoot(endpoint:string){
  let url:URL;
  try{url=new URL(endpoint);}catch{throw new Error('请输入有效的 OpenAI 兼容服务 HTTPS 地址。');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('OpenAI 兼容连接须为无凭据和查询参数的 HTTPS 地址。');
  let path:string;
  try{path=decodeURIComponent(url.pathname).replace(/\/+$/,'');}catch{throw new Error('OpenAI 兼容服务路径无效。');}
  if(/\/(?:chat\/completions|completions|responses|models|images\/(?:generations|edits|variations))(?:\/|$)/i.test(path)||/generateContent|\/v1beta$/i.test(path)){
    throw new Error('请输入服务根地址或 API 基础地址（例如 /v1），不要填写具体操作路径。');
  }
  // Bare service roots use /v1; an explicit vendor API base path is preserved verbatim.
  url.pathname=url.pathname.replace(/\/+$/,'')||'/v1';
  return url.toString().replace(/\/$/,'');
}

function cancelled(signal:AbortSignal,sent=false){
  if(!signal.aborted)return;
  throw new Error(signal.reason?.name==='TimeoutError'
    ?`等待推理服务超过 3 分钟，客户端已停止等待；${sent?'上游计费状态未知，未自动重试。':'未发送请求。'}`
    :sent?'推理请求已取消，上游计费状态未知；未自动重试。':'推理已取消，未发送请求。');
}
async function boundedJson(response:Response,signal:AbortSignal){
  const reader=response.body?.getReader();
  if(!reader)throw new Error('空响应');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      cancelled(signal,true);
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>MAX_RESPONSE_BYTES)throw new Error('响应超过读取限制');
      chunks.push(value);
    }
    cancelled(signal,true);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }finally{await reader.cancel().catch(()=>{});}
}

export class ChatCompletionsAdapter implements CloudExecutionPort {
  readonly description:AdapterDescription={
    adapter_id:'openai-chat-completions',version:1,title:'OpenAI 兼容 Chat Completions',kind:'cloud',installed:true,
    purposes:['understanding'],requires_credential:true,supports_probe:true,interleaving:['native','separated'],
    operations:['understand'],parameters:[],generation_contract:chatProfile,
  };
  constructor(private request:typeof fetch=fetch){}

  private async call(url:string,key:string,body:string|undefined,signal:AbortSignal){
    cancelled(signal);
    let response:Response;
    try{
      response=await this.request(url,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${key}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body,signal,redirect:'error'});
    }catch{
      cancelled(signal,true);
      throw new Error('无法连接推理服务，上游是否收到请求未知；未自动重试。');
    }
    if(!response.ok){
      await response.body?.cancel().catch(()=>{});
      cancelled(signal,true);
      throw new Error(response.status===401||response.status===403?'推理模型鉴权失败或权限不足；未自动重试。':response.status===429?'推理模型额度不足或请求受限；未自动重试。':response.status===413?'当前渠道拒绝了请求大小（HTTP 413），请缩小送入范围；未自动重试。':response.status===400?'推理模型拒绝请求参数，请核对模型 ID、图片能力与参数配置；未自动重试。':`推理服务返回 HTTP ${response.status}；未自动重试。`);
    }
    try{return await boundedJson(response,signal);}catch{
      cancelled(signal,true);
      throw new Error('推理响应读取或解析失败，或超过 2 MB 读取限制；上游计费状态未知，未自动重试。');
    }
  }

  async probe(endpoint:string,key:string,signal:AbortSignal){
    const root=chatRoot(endpoint),timed=AbortSignal.any([signal,AbortSignal.timeout(180_000)]);
    const result=z.object({data:z.array(z.object({id:z.string().min(1).max(200)})).max(10000)}).safeParse(await this.call(`${root}/models`,key,undefined,timed));
    if(!result.success)throw new Error('模型列表不符合 OpenAI 兼容协议，请手动填写模型 ID。');
    return [...new Set(result.data.data.map(model=>model.id))];
  }

  async execute(context:CloudExecutionContext,signal:AbortSignal,progress:(stage:string,value:number)=>Promise<void>):Promise<ExecutionResult>{
    const {model,job}=context,timed=AbortSignal.any([signal,AbortSignal.timeout(180_000)]);
    cancelled(timed);
    if(model.adapter_id!==this.description.adapter_id||model.purpose!=='understanding'||!model.capabilities.operations.includes('understand')||job.mask_edit||job.execution_plan&&job.execution_plan.operation!=='understand'){
      throw new Error('Chat Completions 适配器仅支持理解／推理任务。');
    }
    const requestUrl=`${chatRoot(model.endpoint)}/chat/completions`;
    const parameters=normalizeParameters(job.recipe_snapshot.core_parameters,model);
    validateGenerationParameters(parameters,model);
    const parsedOptions=optionsSchema.safeParse(extensionOptions(parameters,model));
    if(!parsedOptions.success)throw new Error('OpenAI 兼容推理参数无效，请检查参数配置。');
    const options=parsedOptions.data;
    if(context.text_output_limit!==undefined&&(!Number.isInteger(context.text_output_limit)||context.text_output_limit<1))throw new Error('推理输出上限无效。');
    const tokenLimit=Math.min(options.max_output_tokens,context.text_output_limit??options.max_output_tokens);
    const input=job.adapted_input;
    if(input.kind!=='native_blocks'&&input.kind!=='separated_inputs')throw new Error('推理输入结构不受支持。');
    const blocks=input.kind==='native_blocks'?input.blocks??[]:[{type:'text' as const,text:input.prompt??''},...(input.image_asset_ids??[]).map(asset_id=>({type:'image' as const,asset_id}))];
    const imageCount=blocks.filter(block=>block.type==='image').length;
    if(imageCount>model.capabilities.max_images)throw new Error(`本次输入有 ${imageCount} 张图片，超过推理模型的 ${model.capabilities.max_images} 张上限；没有丢弃图片，未发送请求。`);
    if(!blocks.some(block=>block.type==='image'||block.text.trim()))throw new Error('推理输入不能为空。');
    const content:ContentPart[]=[];let estimatedBytes=0,imageIndex=0;
    for(const block of blocks){
      cancelled(timed);
      if(block.type==='text'){
        estimatedBytes+=Buffer.byteLength(block.text);
        if(estimatedBytes>MAX_REQUEST_BYTES)throw new Error('图文编码请求超过 50 MB 限制，未发送请求。');
        content.push({type:'text',text:block.text});continue;
      }
      const bytes=await readReferenceImage(context,block.asset_id,imageIndex++);cancelled(timed);
      if(bytes.byteLength>MAX_IMAGE_BYTES)throw new Error('参考图超过单图 20 MB 限制，请缩小送入范围；未发送请求。');
      estimatedBytes+=4*Math.ceil(bytes.byteLength/3);
      if(estimatedBytes>MAX_REQUEST_BYTES)throw new Error('图文编码请求超过 50 MB 限制，未发送请求。');
      let metadata;
      try{
        metadata=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();
        if(!['png','jpeg','webp'].includes(metadata.format??''))throw new Error('不支持的图片格式');
        await sharp(bytes,{limitInputPixels:40_000_000,failOn:'warning'}).stats();
      }catch{throw new Error('参考图须为可完整解码的 PNG、JPEG 或 WebP，且不超过 4000 万像素；未发送请求。');}
      cancelled(timed);
      if(!metadata.width||!metadata.height)throw new Error('参考图尺寸无效，未发送请求。');
      content.push({type:'image_url',image_url:{url:`data:image/${metadata.format};base64,${bytes.toString('base64')}`,...(options.image_detail?{detail:options.image_detail}:{})}});
    }
    // A string also works with text-only compatibility endpoints; image tasks retain every block.
    const userContent=imageCount?content:content.map(part=>part.type==='text'?part.text:'').join('\n');
    const body=JSON.stringify({model:model.model,messages:[{role:'user',content:userContent}],stream:false,
      [options.token_limit_field]:tokenLimit,
      ...(options.temperature!==undefined?{temperature:options.temperature}:{}),
      ...(options.reasoning_effort?{reasoning_effort:options.reasoning_effort}:{}),
    });
    if(Buffer.byteLength(body)>MAX_REQUEST_BYTES)throw new Error('图文编码后的完整请求超过 50 MB 限制，未发送请求。');
    await progress('等待模型返回理解结果（无上游百分比）',30);cancelled(timed);
    await captureModelInput(context,new URL(requestUrl).pathname,body);cancelled(timed);
    const key=await context.resolveCredential();cancelled(timed);
    const parsed=responseSchema.safeParse(await this.call(requestUrl,key,body,timed));
    cancelled(timed,true);
    if(!parsed.success)throw new Error('推理响应不符合 Chat Completions 文字结果结构；未自动重试。');
    const data=parsed.data,candidate=data.choices[0],message=candidate.message;
    if(message.refusal||message.tool_calls?.length||message.function_call!=null||message.audio!=null)throw new Error('推理模型返回拒绝、工具调用或非文字内容，没有采用结果；未自动重试。');
    if(candidate.finish_reason!=='stop')throw new Error('推理模型未正常完成或输出被截断，没有采用不完整结果；未自动重试。');
    const text=message.content?.trim();
    if(!text||text.length>MAX_TEXT_CHARS)throw new Error('推理模型没有返回有效文字，或结果超过 32000 字符；没有截断或采用结果，未自动重试。');
    const usage=Object.fromEntries(Object.entries(data.usage??{}).filter((entry):entry is [string,number]=>typeof entry[1]==='number'&&Number.isFinite(entry[1])&&entry[1]>=0));
    return {images:[],text,request_id:data.id?.slice(0,200),usage};
  }
}
