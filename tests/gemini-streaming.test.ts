import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { seedModels } from '../src/core/models.js';
import { modelInputSchema } from '../src/core/model-input.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import type { Block, Job } from '../src/core/domain.js';

function context(onTextDelta?:(delta:string)=>void):CloudExecutionContext{
  const model=seedModels()[2];model.purpose='understanding';model.model='models/gemini-understanding';model.endpoint='https://relay.test.invalid';
  const blocks:Block[]=[{type:'text',text:'生成提示词',source_module_id:'module_prompt',reference_type:'prompt',reference_id:'ref_prompt'}];
  const job={recipe_snapshot:{core_parameters:model.defaults},chain_snapshot:{blocks,mode:'reference_generation'},adapted_input:{kind:'native_blocks',blocks,adjustments:[]}} as unknown as Job;
  return {model,job,readImage:async()=>{throw new Error('unexpected image read');},resolveCredential:async()=>'private-test-key',onTextDelta};
}
function frame(value:unknown){return `data: ${JSON.stringify(value)}\r\n\r\n`;}
function candidate(text:string,finishReason?:string){return {candidates:[{index:0,content:{parts:[{text}]},...(finishReason?{finishReason}:{})}]};}
function response(events:unknown[],bytewise=false){
  const bytes=new TextEncoder().encode(events.map(frame).join(''));
  const stream=new ReadableStream<Uint8Array>({start(controller){if(bytewise)for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));else controller.enqueue(bytes);controller.close();}});
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
}
const execute=(adapter:GeminiGenerator,c=context(()=>{}),signal=new AbortController().signal)=>adapter.execute(c,signal,async()=>{});

test('Gemini 流式实时拼接中文和分包，过滤思考，正常 EOF 后收齐 usage 与请求编号',async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>,seen!:()=>void,calls=0,settled=false,capturedRoute='';
  const firstDelta=new Promise<void>(resolve=>{seen=resolve;}),deltas:string[]=[];
  const stream=new ReadableStream<Uint8Array>({start(value){controller=value;}});
  const c=context(delta=>{deltas.push(delta);seen();});c.text_output_limit=16384;
  c.recordModelInput=async input=>{modelInputSchema.parse(input);capturedRoute=input.route;assert.equal(JSON.parse(input.body.encoding==='json'?input.body.json:'{}').generationConfig.maxOutputTokens,16384);};
  const adapter=new GeminiGenerator(async(url,init)=>{
    calls++;assert.equal(String(url),'https://relay.test.invalid/v1beta/models/gemini-understanding:streamGenerateContent?alt=sse');
    assert.equal(capturedRoute,'/v1beta/models/gemini-understanding:streamGenerateContent');
    assert.equal((init?.headers as Record<string,string>)['x-goog-api-key'],'private-test-key');
    const body=JSON.parse(String(init?.body));assert.deepEqual(body.generationConfig,{responseModalities:['TEXT'],maxOutputTokens:16384});
    return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
  });
  const resultPromise=execute(adapter,c).finally(()=>{settled=true;});
  const first=frame({candidates:[{content:{parts:[{thought:true,text:'隐藏思考'},{text:'白色'}]}}],responseId:'early-id'});
  for(const byte of new TextEncoder().encode(first))controller.enqueue(Uint8Array.of(byte));
  await firstDelta;assert.deepEqual(deltas,['白色']);assert.equal(settled,false);
  controller.enqueue(new TextEncoder().encode(frame(candidate('瓶身。','STOP'))));
  controller.enqueue(new TextEncoder().encode(frame({usageMetadata:{promptTokenCount:10,totalTokenCount:28,ignored:'secret'},responseId:'final-id'})));
  controller.close();
  const result=await resultPromise;
  assert.equal(result.text,'白色瓶身。');assert.deepEqual(deltas,['白色','瓶身。']);assert.deepEqual(result.images,[]);
  assert.deepEqual(result.usage,{promptTokenCount:10,totalTokenCount:28});assert.equal(result.request_id,'final-id');assert.equal(calls,1);
});

test('没有增量回调时 Gemini 理解仍使用一次性端点',async()=>{
  const result=await execute(new GeminiGenerator(async url=>{
    assert.ok(String(url).endsWith(':generateContent'));
    return Response.json(candidate('完整建议','STOP'));
  }),context());
  assert.equal(result.text,'完整建议');
});

test('Gemini 流式拒绝缺失 STOP、非正常结束、安全拦截和非文本内容',async()=>{
  const cases:[unknown[],RegExp][]=[
    [[candidate('半截正文')],/缺少正常结束标志/],
    [[candidate('半截正文','MAX_TOKENS')],/未正常完成/],
    [[candidate('半截正文','SAFETY')],/未正常完成/],
    [[{promptFeedback:{blockReason:'SAFETY'}}],/拦截/],
    [[{candidates:[{content:{parts:[{functionCall:{name:'private-test-key',args:{}}}]},finishReason:'STOP'}]}],/非文字结果/],
    [[{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'AAAA'}}]},finishReason:'STOP'}]}],/非文字结果/],
    [[{candidates:[{index:1,content:{parts:[{text:'wrong'}]},finishReason:'STOP'}]}],/意外候选/],
    [[{candidates:[{content:{parts:[{text:'a'}]},finishReason:'STOP'},{content:{parts:[{text:'b'}]},finishReason:'STOP'}]}],/结构不符合/],
    [[candidate('','STOP')],/没有返回文本/],
    [[{candidates:[{content:{parts:[{thought:true,text:'仅有思考'}]},finishReason:'STOP'}]}],/没有返回文本/],
    [[candidate('正文','STOP'),candidate('迟到内容')],/结束标志后/],
    [[{error:{message:'private-test-key upstream secret'}}],/报告错误/],
  ];
  for(const [events,expected] of cases){
    let calls=0;const adapter=new GeminiGenerator(async()=>{calls++;return response(events,true);});
    await assert.rejects(()=>execute(adapter),error=>error instanceof Error&&expected.test(error.message)&&!error.message.includes('private-test-key'));
    assert.equal(calls,1);
  }
});

test('Gemini 流式不截断保存超长正文，达到 32000 后的增量不会发出',async()=>{
  const deltas:string[]=[];
  const adapter=new GeminiGenerator(async()=>response([candidate('文'.repeat(32000)),candidate('字','STOP')]));
  await assert.rejects(()=>execute(adapter,context(delta=>deltas.push(delta))),/32000/);
  assert.equal(deltas.join('').length,32000);
});

test('Gemini 流式中途错误、无完整帧结尾和伪装 JSON 响应均不成功且不泄露原始错误',async()=>{
  const badResponses=[
    ()=>new Response('data: private-test-key broken json\n\n',{headers:{'Content-Type':'text/event-stream'}}),
    ()=>new Response(frame(candidate('正文','STOP'))+'data: '+JSON.stringify({responseId:'private-test-key'}),{headers:{'Content-Type':'text/event-stream'}}),
    ()=>Response.json(candidate('正文','STOP')),
    ()=>new Response(new ReadableStream({start(controller){controller.error(new Error('private-test-key upstream secret'));}}),{headers:{'Content-Type':'text/event-stream'}}),
  ];
  for(const makeResponse of badResponses){
    let calls=0;
    await assert.rejects(()=>execute(new GeminiGenerator(async()=>{calls++;return makeResponse();})),error=>error instanceof Error&&/读取或解析失败/.test(error.message)&&!error.message.includes('private-test-key'));
    assert.equal(calls,1);
  }
});

test('Gemini 流式收到部分文字后取消会结束挂起读取，释放 reader 且不返回成功',async()=>{
  const abort=new AbortController();let cancelled=false,seen!:()=>void;
  const firstDelta=new Promise<void>(resolve=>{seen=resolve;});const deltas:string[]=[];
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(frame(candidate('临时正文'))));},cancel(){cancelled=true;}});
  const adapter=new GeminiGenerator(async()=>new Response(stream,{headers:{'Content-Type':'text/event-stream'}}));
  const pending=execute(adapter,context(delta=>{deltas.push(delta);seen();}),abort.signal);
  await firstDelta;abort.abort();
  await assert.rejects(pending,/已取消或超时/);
  assert.deepEqual(deltas,['临时正文']);assert.equal(cancelled,true);assert.equal(stream.locked,false);
});

test('Gemini 流式收到 STOP 后若连接报错也不能返回成功',async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>,seen!:()=>void;
  const received=new Promise<void>(resolve=>{seen=resolve;});
  const stream=new ReadableStream<Uint8Array>({start(value){controller=value;controller.enqueue(new TextEncoder().encode(frame(candidate('临时正文','STOP'))));}});
  const pending=execute(new GeminiGenerator(async()=>new Response(stream,{headers:{'Content-Type':'text/event-stream'}})),context(()=>{seen();}));
  await received;controller.error(new Error('private-test-key broken socket'));
  await assert.rejects(pending,error=>error instanceof Error&&/读取或解析失败/.test(error.message)&&!error.message.includes('private-test-key'));
  assert.equal(stream.locked,false);
});

test('Gemini 等待凭据期间取消不会发送请求',async()=>{
  const abort=new AbortController(),c=context(()=>{});let calls=0;
  c.resolveCredential=async()=>{abort.abort();return 'private-test-key';};
  await assert.rejects(()=>execute(new GeminiGenerator(async()=>{calls++;return response([candidate('不应生成','STOP')]);}),c,abort.signal),/未发送请求/);
  assert.equal(calls,0);
});

test('Gemini 流式 HTTP 错误只返回安全摘要且不重试',async()=>{
  let calls=0;
  await assert.rejects(()=>execute(new GeminiGenerator(async()=>{calls++;return Response.json({error:{message:'private-test-key upstream secret'}},{status:429});})),error=>error instanceof Error&&/受限/.test(error.message)&&!error.message.includes('private-test-key'));
  assert.equal(calls,1);
});

test('Gemini 流式发送独立系统指令，用户图文顺序与捕获正文保持一致',async()=>{
  const deltas:string[]=[],c=context(delta=>deltas.push(delta));let calls=0,captured='';const read:string[]=[];
  const png=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer(),jpeg=await sharp(png).jpeg().toBuffer();
  const meta={source_module_id:'module_subject',reference_type:'subject',reference_id:'reference_subject'};
  c.job.adapted_input.system_instruction='流式任务的稳定角色与规则';
  c.job.adapted_input.blocks=[{type:'text',text:'第一张',...meta},{type:'image',asset_id:'asset_one',...meta},{type:'text',text:'第二张',...meta},{type:'image',asset_id:'asset_two',...meta},{type:'image',asset_id:'asset_one',...meta}];
  c.readImage=async id=>{read.push(id);return id==='asset_two'?jpeg:png;};
  c.recordModelInput=async input=>{modelInputSchema.parse(input);if(input.body.encoding==='json')captured=input.body.json;};
  const result=await execute(new GeminiGenerator(async(url,init)=>{
    calls++;assert.ok(String(url).endsWith(':streamGenerateContent?alt=sse'));assert.equal(init?.body,captured);
    const body=JSON.parse(String(init?.body));assert.deepEqual(body.systemInstruction,{parts:[{text:'流式任务的稳定角色与规则'}]});
    assert.equal(body.contents[0].role,'user');assert.deepEqual(body.contents[0].parts.map((part:any)=>part.text??part.inlineData.mimeType),['第一张','image/png','第二张','image/jpeg','image/png']);
    assert.equal(body.contents[0].parts[1].inlineData.data,body.contents[0].parts[4].inlineData.data);
    return response([candidate('完整','STOP')]);
  }),c);
  assert.equal(result.text,'完整');assert.deepEqual(deltas,['完整']);assert.deepEqual(read,['asset_one','asset_two','asset_one']);assert.equal(calls,1);
});

test('Gemini 流式系统指令不支持时保留一次失败，不切回普通端点或 user 文字',async()=>{
  const c=context(()=>{});c.job.adapted_input.system_instruction='稳定规则';let calls=0;
  await assert.rejects(execute(new GeminiGenerator(async(url,init)=>{
    calls++;assert.ok(String(url).includes(':streamGenerateContent'));
    assert.deepEqual(JSON.parse(String(init?.body)).systemInstruction,{parts:[{text:'稳定规则'}]});
    return Response.json({error:{message:'private-test-key unsupported systemInstruction'}},{status:400});
  }),c),error=>error instanceof Error&&/拒绝请求参数/.test(error.message)&&!error.message.includes('private-test-key'));
  assert.equal(calls,1);
});
