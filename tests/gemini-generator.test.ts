import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GeminiGenerator,geminiRoot } from '../src/adapters/gemini-generator.js';
import { ExecutionRegistry } from '../src/adapters/execution-registry.js';
import { seedModels } from '../src/core/models.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import type { Job,Block } from '../src/core/domain.js';
import {geminiCompatibilitySchema} from '../src/core/domain.js';
import {MB,validateGeminiUpload,geminiUploadLimits} from '../src/core/image-limits.js';
function context(bytes:Buffer):CloudExecutionContext {const model=seedModels()[2],blocks:Block[]=[{type:'text',text:'first',source_module_id:'mod_one',reference_type:'subject',reference_id:'ref_one'},{type:'image',asset_id:'asset_one',source_module_id:'mod_one',reference_type:'subject',reference_id:'ref_one'},{type:'text',text:'last',source_module_id:'mod_two',reference_type:'prompt',reference_id:'ref_two'}];
  const job={recipe_snapshot:{core_parameters:model.defaults},chain_snapshot:{blocks,mode:'reference_generation'},adapted_input:{kind:'native_blocks',blocks,adjustments:[]}} as unknown as Job;
  return {model,job,readImage:async()=>bytes,resolveCredential:async()=>'test-key'};}
test('Google 请求保留图文顺序与参数；JPEG 响应如实保存，忽略思考图',async()=>{
  const input=await sharp({create:{width:20,height:10,channels:3,background:'#fff'}}).png().toBuffer(),output=await sharp(input).jpeg().toBuffer();let requestBody:any,url='';
  const adapter=new GeminiGenerator(async(u,init)=>{url=String(u);requestBody=JSON.parse(init!.body as string);assert.equal((init!.headers as Record<string,string>)['x-goog-api-key'],'test-key');return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,inlineData:{mimeType:'image/png',data:input.toString('base64')}},{text:'done'},{inlineData:{mimeType:'image/jpeg',data:output.toString('base64')}}]}}],usageMetadata:{totalTokenCount:42},responseId:'request-one'});});
  const c=context(input);c.model.endpoint='https://api.aipix.one';const result=await new ExecutionRegistry().register(adapter).execute(c,new AbortController().signal,async()=>{});
  assert.equal(url,'https://api.aipix.one/v1beta/models/gemini-3-pro-image:generateContent');assert.deepEqual(requestBody.contents[0].parts.map((p:any)=>p.text??'image'),['first','image','last']);assert.deepEqual(requestBody.generationConfig.imageConfig,{aspectRatio:'1:1',imageSize:'2K'});
  assert.equal(result.images.length,1);assert.equal(result.images[0].format,'jpeg');assert.equal(result.images[0].width,20);assert.equal(result.text,'done');assert.equal(result.usage!.totalTokenCount,42);
});
test('原生路径规范化；未知协议不自动回退',async()=>{assert.equal(geminiRoot('https://api.aipix.one/v1beta'),'https://api.aipix.one/v1beta');assert.equal(geminiRoot('https://api.aipix.one/gemini'),'https://api.aipix.one/gemini/v1beta');assert.throws(()=>geminiRoot('https://api.aipix.one/v1'),/原生连接/);
  const c=context(Buffer.alloc(0));c.model.adapter_id='unknown';assert.throws(()=>new ExecutionRegistry().execute(c,new AbortController().signal,async()=>{}),/未安装/);});
test('失败不自动重试、不回显上游错误或 Key；空图不成功',async()=>{let calls=0;const adapter=new GeminiGenerator(async()=>{calls++;return Response.json({error:{message:'test-key secret upstream detail'}},{status:429});});await assert.rejects(()=>adapter.execute(context(awaitBuffer),new AbortController().signal,async()=>{}),error=>error instanceof Error&&error.message.includes('受限')&&!error.message.includes('test-key'));assert.equal(calls,1);
  const empty=new GeminiGenerator(async()=>Response.json({candidates:[{content:{parts:[{text:'no image'}]}}]}));await assert.rejects(()=>empty.execute(context(awaitBuffer),new AbortController().signal,async()=>{}),/没有返回图片/);});
const awaitBuffer=await sharp({create:{width:10,height:10,channels:3,background:'#fff'}}).png().toBuffer();
test('可选请求编号为 null 时仍正常解析图片，且不自动重试',async()=>{
  let calls=0;const adapter=new GeminiGenerator(async()=>{calls++;return Response.json({responseId:null,candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:awaitBuffer.toString('base64')}}]}}]});});
  const result=await adapter.execute(context(awaitBuffer),new AbortController().signal,async()=>{});assert.equal(result.images.length,1);assert.equal(result.images[0].width,10);assert.equal(result.request_id,undefined);assert.equal(calls,1);
});
test('响应结构错误显示具体字段，不回显上游内容或原始校验异常',async()=>{
  const adapter=new GeminiGenerator(async()=>Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:123}}]}}],secret:'test-key secret upstream detail'}));
  await assert.rejects(()=>adapter.execute(context(awaitBuffer),new AbortController().signal,async()=>{}),error=>error instanceof Error&&error.message.includes('candidates[0].content.parts[0].inlineData.data')&&error.message.includes('未自动重试')&&!error.message.includes('test-key')&&!error.message.includes('invalid_type'));
});
test('模型列表探测分页，只返回 ID，不推断能力',async()=>{let page=0;const adapter=new GeminiGenerator(async u=>{page++;if(page===1)return Response.json({models:[{name:'models/image-model'}],nextPageToken:'next'});assert.ok(String(u).includes('pageToken=next'));return Response.json({models:[{name:'models/chat-model'}]});});assert.deepEqual(await adapter.probe('https://example.com','key',new AbortController().signal),['image-model','chat-model']);});

test('内联预算默认 100 MB，支持渠道单独调低，边界明确且拒绝非法配置',()=>{
  assert.equal(geminiUploadLimits().requestMB,100);assert.equal(geminiUploadLimits({}).requestMB,100);
  assert.doesNotThrow(()=>validateGeminiUpload(100*MB));assert.throws(()=>validateGeminiUpload(100*MB+1),/100 MB.*未发送请求/);
  assert.doesNotThrow(()=>validateGeminiUpload(20*MB,{max_request_mb:20}));assert.throws(()=>validateGeminiUpload(20*MB+1,{max_request_mb:20}),/20 MB.*未发送请求/);
  for(const max_request_mb of [0,-1,1.5,101,Infinity])assert.equal(geminiCompatibilitySchema.safeParse({max_request_mb}).success,false);
});

test('上游 413 明确提示渠道拒绝请求大小，保留请求且不重试、不回显上游正文',async()=>{
  const c=context(awaitBuffer);let calls=0,captured=false;c.recordModelInput=async()=>{captured=true;};
  const adapter=new GeminiGenerator(async()=>{calls++;assert.ok(captured);return Response.json({error:'test-key private detail'},{status:413});});
  await assert.rejects(()=>adapter.execute(c,new AbortController().signal,async()=>{}),error=>error instanceof Error&&/当前渠道.*HTTP 413.*未自动重试/.test(error.message)&&!error.message.includes('test-key'));
  assert.equal(calls,1);
});
test('理解用途只请求文本结果，不发送生图参数；不需要修改执行注册表',async()=>{
  const c=context(awaitBuffer);c.model.purpose='understanding';c.model.model='gemini-understanding';let body:any;
  const adapter=new GeminiGenerator(async(_url,init)=>{body=JSON.parse(init!.body as string);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'商品主体为白色瓶身。'}]}}]});});
  const result=await new ExecutionRegistry().register(adapter).execute(c,new AbortController().signal,async()=>{});assert.deepEqual(body.generationConfig,{responseModalities:['TEXT'],maxOutputTokens:2048});assert.equal(result.images.length,0);assert.equal(result.text,'商品主体为白色瓶身。');
});
test('Google 自动尺寸不强制 aspectRatio，非标准期望只作为提示表达',async()=>{
  const c=context(awaitBuffer);c.job.recipe_snapshot.core_parameters.aspect_ratio='auto';c.job.output_geometry={selection:'auto',basis:'composition',ratio:'137:90',target:'auto',adjustments:['由模型自动决定']};const adapter=new GeminiGenerator(async(_url,init)=>{const body=JSON.parse(init!.body as string);assert.equal(body.generationConfig.imageConfig.aspectRatio,undefined);assert.equal(body.generationConfig.imageConfig.imageSize,'2K');assert.match(body.contents[0].parts.at(-1).text,/137:90/);return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:awaitBuffer.toString('base64')}}]}}]});});await adapter.execute(c,new AbortController().signal,async()=>{});
});
