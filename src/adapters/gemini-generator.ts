import sharp from 'sharp';
import { z } from 'zod';
import type { AdapterDescription } from '../core/model-library.js';
import type { CloudExecutionContext, ExecutionResult } from '../core/ports.js';
import { captureModelInput } from './capture-model-input.js';
import { validateGeminiUpload } from '../core/image-limits.js';
import { geminiProfile } from '../protocols/generation-profiles.js';
import { normalizeParameters,extensionOptions,validateGenerationParameters } from '../core/generation-parameters.js';

const partSchema=z.object({thought:z.boolean().optional(),text:z.string().optional(),inlineData:z.object({data:z.string(),mimeType:z.string()}).optional()});
const responseSchema=z.object({candidates:z.array(z.object({content:z.object({parts:z.array(partSchema)}).optional(),finishReason:z.string().optional()})).optional(),promptFeedback:z.object({blockReason:z.string().optional()}).optional(),responseId:z.string().nullish(),usageMetadata:z.record(z.string(),z.unknown()).optional()});
export function geminiRoot(endpoint:string){const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Google 连接须为无凭据和查询参数的 HTTPS 地址。');
  const p=url.pathname.replace(/\/$/,'');if(p.endsWith('/openai')||p==='/v1')throw new Error('请选择 Google 原生连接，不使用 /v1 或 /openai 兼容入口。');url.pathname=p.endsWith('/v1beta')?p:`${p}/v1beta`;return url.toString().replace(/\/$/,'');}
async function boundedJson(response:Response,maximum=60*1024*1024){const reader=response.body?.getReader();if(!reader)throw new Error('上游返回空响应。');const chunks:Uint8Array[]=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maximum)throw new Error('上游响应超过当前传输限制。');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});}}
export class GeminiGenerator {
  readonly description:AdapterDescription={generation_contract:geminiProfile,geometry_support:'ratio',adapter_id:'gemini-generate-content',version:4,title:'Google 原生 GenerateContent',kind:'cloud',installed:true,purposes:['generation','understanding'],requires_credential:true,supports_probe:true,interleaving:['native','separated'],operations:['generate','referenceEdit','guidedMaskEdit','understand'],parameters:[{key:'aspect_ratio',title:'比例'},{key:'quality',title:'分辨率',values:['1K','2K','4K']},{key:'output_format',title:'图片格式',values:['png']},{key:'count',title:'数量',maximum:1}]};
  constructor(private request:typeof fetch=fetch){}
  private async call(url:string,key:string,body:string|undefined,signal:AbortSignal){let response:Response;try{response=await this.request(url,{method:body?'POST':'GET',headers:{'x-goog-api-key':key,...(body?{'Content-Type':'application/json'}:{})},body,signal,redirect:'error'});}catch{throw new Error(signal.aborted?'请求已取消或超时，上游计费状态未知。':'无法连接模型服务，上游是否收到请求未知；未自动重试。');}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error(response.status===401||response.status===403?'模型鉴权失败或权限不足。':response.status===429?'模型额度不足或请求受限。':response.status===413?'当前渠道拒绝了请求大小（HTTP 413），请缩小送入范围或按渠道限制调整接口兼容设置；未自动重试。':response.status===400?'模型拒绝请求参数，请核对模型 ID 与能力配置。':`模型服务返回 HTTP ${response.status}；未自动重试。`);}
    try{return await boundedJson(response);}catch{throw new Error('模型响应读取或解析失败，上游计费状态未知；未自动重试。');}}
  async probe(endpoint:string,key:string,signal:AbortSignal){const root=geminiRoot(endpoint),models:string[]=[];let pageToken:string|undefined;
    for(let page=0;page<20;page++){const url=new URL(`${root}/models`);url.searchParams.set('pageSize','100');if(pageToken)url.searchParams.set('pageToken',pageToken);
      const data=z.object({models:z.array(z.object({name:z.string()})).optional(),nextPageToken:z.string().optional()}).parse(await this.call(url.toString(),key,undefined,signal));models.push(...(data.models??[]).map(m=>m.name.replace(/^models\//,'')));pageToken=data.nextPageToken;if(!pageToken)return [...new Set(models)];}
    throw new Error('模型列表分页超出限制，请手动添加模型。');}
  async execute(context:CloudExecutionContext,signal:AbortSignal,progress:(stage:string,value:number)=>Promise<void>):Promise<ExecutionResult>{
    const {model,job}=context,parameters=normalizeParameters(job.recipe_snapshot.core_parameters,model);
    validateGenerationParameters(parameters,model);

    const understanding=model.purpose==='understanding';
    const defaultEditSize=job.mask_edit?.method==='guided'&&parameters.resolution?.mode==='default';
    const imageSize=defaultEditSize?undefined:parameters.resolution?.mode==='tier'?parameters.resolution.value:model.generation_contract?.tiers[0],options=extensionOptions(parameters,model);
    if(!understanding&&(parameters.count!==1||!imageSize&&!defaultEditSize||parameters.output_format!=='png'))throw new Error('当前 Google 生图适配器支持单图、1K/2K/4K 和 PNG 请求；实际响应格式将如实保存。');
    const parts:({text:string}|{inlineData:{mimeType:string;data:string};mediaResolution?:{level:string}})[]=[];
    const blocks=job.adapted_input.kind==='native_blocks'?job.adapted_input.blocks??[]:[{type:'text' as const,text:job.adapted_input.prompt??''},...(job.adapted_input.image_asset_ids??[]).map(asset_id=>({type:'image' as const,asset_id}))];
    if(job.mask_edit){
      const edit=job.mask_edit,ids=blocks.flatMap(b=>b.type==='image'?[b.asset_id]:[]);
      if(understanding||edit.method!=='guided'||!model.capabilities.operations.includes('guidedMaskEdit')||!model.capabilities.operations.includes('referenceEdit')||model.capabilities.max_images<2)throw new Error('此接入未声明黑白区域图编辑能力。');
      if(!edit.crop||!edit.guide_asset_id||ids.length!==2||ids[0]!==edit.request_source_id||ids[1]!==edit.guide_asset_id)throw new Error('局部编辑必须按底图、黑白区域图的顺序发送两张图片。');
      const [source,guide]=await Promise.all([context.readImage(ids[0]),context.readImage(ids[1])]);
      const [baseMeta,guideMeta]=await Promise.all([sharp(source,{limitInputPixels:40_000_000}).metadata(),sharp(guide,{limitInputPixels:40_000_000}).metadata()]);
      if(baseMeta.width!==edit.crop.width||baseMeta.height!==edit.crop.height||guideMeta.format!=='png'||guideMeta.hasAlpha||guideMeta.width!==baseMeta.width||guideMeta.height!==baseMeta.height)throw new Error('黑白区域图必须为无透明通道的 PNG，且与送入底图尺寸一致。');
      const gray=await sharp(guide,{limitInputPixels:40_000_000}).toColourspace('srgb').raw().toBuffer();
      let selected=false;for(let i=0;i<gray.length;i+=3){if(gray[i]!==gray[i+1]||gray[i]!==gray[i+2])throw new Error('区域图只能包含黑白灰度，不能包含颜色。');if(gray[i])selected=true;}
      if(!selected)throw new Error('黑白区域图没有允许编辑的白色区域。');
    }
    for(const block of blocks){if(signal.aborted)throw new Error('任务已取消。');if(block.type==='text')parts.push({text:block.text});else{const bytes=await context.readImage(block.asset_id),meta=await sharp(bytes).metadata();if(!['png','jpeg','webp'].includes(meta.format??''))throw new Error('参考图格式不支持。');const precision=(options.reference_overrides as Record<string,string>|undefined)?.[block.asset_id];parts.push({inlineData:{mimeType:`image/${meta.format}`,data:bytes.toString('base64')},...(precision?{mediaResolution:{level:`MEDIA_RESOLUTION_${precision.toUpperCase()}`}}:{})});}}
    const geometry=job.output_geometry;
    if(!job.execution_plan&&!understanding&&geometry?.target==='auto'&&geometry.ratio)parts.push({text:`期望输出画面的宽高比为 ${geometry.ratio}。请尽量保持该比例。`});
    const ratio=geometry?geometry.request_ratio:parameters.aspect_ratio==='auto'?undefined:parameters.aspect_ratio;
    const mediaResolution=options?.reference_precision&&options.reference_precision!=='default'?{mediaResolution:`MEDIA_RESOLUTION_${String(options.reference_precision).toUpperCase()}`}:{},search=options?.google_search?{tools:[{googleSearch:{}}]}:{};
    const reasoning={...(options.temperature!==undefined?{temperature:options.temperature}:{}),...(options.thinking_level?{thinkingConfig:{thinkingLevel:String(options.thinking_level).toUpperCase()}}:{})};
    const body=JSON.stringify({contents:[{role:'user',parts}],...search,generationConfig:understanding?{responseModalities:['TEXT'],maxOutputTokens:context.text_output_limit??2048,...mediaResolution,...reasoning}:{responseModalities:options?.response_mode==='image'?['IMAGE']:['TEXT','IMAGE'],...mediaResolution,imageConfig:{...(ratio?{aspectRatio:ratio}:{}),...(imageSize?{imageSize}:{})}}});
    validateGeminiUpload(Buffer.byteLength(body),model.gemini_compatibility);
    await progress(understanding?'等待模型返回理解结果（无上游百分比）':'等待模型返回图片（无上游百分比）',30);
    const timed=AbortSignal.any([signal,AbortSignal.timeout(180_000)]);
    if(signal.aborted)throw new Error('任务已取消，未发送请求。');
    const requestUrl=`${geminiRoot(model.endpoint)}/models/${encodeURIComponent(model.model)}:generateContent`;
    await captureModelInput(context,new URL(requestUrl).pathname,body);
    if(signal.aborted)throw new Error('任务已取消，未发送请求。');
    const parsed=responseSchema.safeParse(await this.call(requestUrl,await context.resolveCredential(),body,timed));
    if(!parsed.success){const fields=parsed.error.issues.slice(0,3).map(issue=>issue.path.reduce<string>((path,key)=>typeof key==='number'?`${path}[${key}]`:`${path}${path?'.':''}${String(key)}`,'')||'响应根节点');throw new Error(`模型响应结构不符合 Google 原生协议：${fields.join('、')} 字段的类型或内容无效；未保存图片，未自动重试。`);}
    const data=parsed.data;
    if(data.promptFeedback?.blockReason)throw new Error('模型拦截了本次输入，没有返回图片。');
    const candidate=data.candidates?.[0];if(candidate?.finishReason&&candidate.finishReason!=='STOP')throw new Error('模型未正常完成本次生成，没有保存不完整结果。');
    const images:ExecutionResult['images']=[],texts:string[]=[];
    for(const part of candidate?.content?.parts??[]){if(part.thought)continue;if(part.text)texts.push(part.text);if(part.inlineData){const {data:encoded,mimeType}=part.inlineData;if(!['image/png','image/jpeg','image/webp'].includes(mimeType)||!encoded||encoded.length%4===1||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('模型返回无效图片。');const bytes=Buffer.from(encoded,'base64');let meta;try{meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();await sharp(bytes,{limitInputPixels:40_000_000}).stats();}catch{throw new Error('模型图片无法完整解码。');}if(!meta.width||!meta.height||!['png','jpeg','webp'].includes(meta.format??'')||`image/${meta.format}`!==mimeType)throw new Error('模型返回图片的格式或尺寸无效。');images.push({bytes,format:meta.format as 'png'|'jpeg'|'webp',width:meta.width,height:meta.height});}}
    if(!understanding&&!images.length)throw new Error('模型没有返回图片，可能被内容限制或模型不支持生图。');
    if(!understanding&&images.length!==1)throw new Error('模型返回数量与单图任务不一致。');
    if(understanding&&!texts.some(t=>t.trim()))throw new Error('理解模型没有返回文本结果。');
    const usage=Object.fromEntries(Object.entries(data.usageMetadata??{}).filter((entry):entry is [string,number]=>typeof entry[1]==='number'&&Number.isFinite(entry[1])));
    return {images,text:texts.join('\n').slice(0,64000),request_id:data.responseId?.slice(0,200),usage};
  }
}
