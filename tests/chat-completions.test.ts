import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ChatCompletionsAdapter, chatRoot } from '../src/adapters/chat-completions.js';
import { chatProfile } from '../src/protocols/chat-profile.js';
import { ExecutionRegistry } from '../src/adapters/execution-registry.js';
import { modelConfigSchema, defaultParameters, type ModelConfig, type Job, type Block, type Recipe } from '../src/core/domain.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { prepareModuleInference, executeModuleInference } from '../src/core/module-inference.js';

const meta={source_module_id:'module_subject',reference_type:'subject',reference_id:'reference_subject'};
const blockText=(text:string):Block=>({type:'text',text,...meta});
const blockImage=(asset_id:string):Block=>({type:'image',asset_id,...meta});
function model(maxImages=0):ModelConfig {
  return {...modelConfigSchema.parse({
    model_config_id:'model_chat',title:'Custom chat',kind:'cloud',provider:'openai',model:'vendor-model',
    adapter_id:'openai-chat-completions',endpoint:'https://example.com/v1',enabled:true,executable:true,revision:1,
    generation_contract:chatProfile,
    capabilities:{interleaving:'native',max_images:maxImages,aspect_ratios:['auto'],qualities:['standard'],formats:['png'],max_count:1,operations:['understand']},
    defaults:{version:2,aspect_ratio:'auto',quality:'standard',output_format:'png',count:1,resolution:{mode:'default'},extensions:{}},
  }),purpose:'understanding'};
}
function context(blocks:Block[]=[blockText('优化这段描述')],maxImages=0):CloudExecutionContext {
  const config=model(maxImages);
  const job={recipe_snapshot:{core_parameters:structuredClone(config.defaults)},adapted_input:{kind:'native_blocks',blocks,adjustments:[]}} as unknown as Job;
  return {model:config,job,readImage:async()=>{throw new Error('图片不应读取');},resolveCredential:async()=>'test-secret-key'};
}
function success(content='完整文字建议',message:Record<string,unknown>={}){
  return Response.json({id:'request_test',choices:[{finish_reason:'stop',message:{content,...message}}],usage:{prompt_tokens:5,completion_tokens:8,total_tokens:13,completion_tokens_details:{reasoning_tokens:4},private:'hidden',negative:-1}});
}
const signal=()=>new AbortController().signal;
const quiet=async()=>{};
const imageBytes=await sharp({create:{width:12,height:8,channels:3,background:'white'}}).png().toBuffer();

test('Chat roots accept HTTPS API bases, preserve vendor paths and reject credentials or complete actions',()=>{
  for(const [input,expected] of [
    ['https://example.com','https://example.com/v1'],['https://example.com/','https://example.com/v1'],
    ['https://example.com/v1/','https://example.com/v1'],['https://example.com/openai/v1/','https://example.com/openai/v1'],
    ['https://example.com/api/v3','https://example.com/api/v3'],['https://example.com/v1beta/openai','https://example.com/v1beta/openai'],
  ])assert.equal(chatRoot(input),expected);
  for(const input of ['bad','http://example.com/v1','https://key@example.com','https://example.com?key=x','https://example.com/#x',
    'https://example.com/v1/chat/completions','https://example.com/v1/models','https://example.com/v1/responses',
    'https://example.com/v1/images/generations','https://example.com/v1beta','https://example.com/v1/%63hat/completions',
  ])assert.throws(()=>chatRoot(input));
});

test('Chat model probe uses Bearer auth and bounded list shape without capability guesses or retries',async()=>{
  let calls=0;
  const adapter=new ChatCompletionsAdapter(async(url,init)=>{
    calls++;assert.equal(String(url),'https://example.com/openai/v1/models');assert.equal(init?.method,'GET');
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer probe-key');assert.equal(init?.redirect,'error');
    return Response.json({data:[{id:'vendor-model'},{id:'vision-model'},{id:'vendor-model'}]});
  });
  assert.deepEqual(await adapter.probe('https://example.com/openai/v1/','probe-key',signal()),['vendor-model','vision-model']);
  assert.equal(calls,1);
  const invalid=new ChatCompletionsAdapter(async()=>Response.json({models:[{name:'wrong-protocol'}],secret:'private upstream'}));
  await assert.rejects(invalid.probe('https://example.com','key',signal()),error=>error instanceof Error&&/请手动填写/.test(error.message)&&!error.message.includes('private upstream'));
});

test('Text-only requests omit optional settings and return only final content, numeric usage and actual request capture',async()=>{
  const c=context([blockText('第一段'),blockText('第二段')]);let calls=0,captured='';
  c.recordModelInput=async input=>{
    assert.equal(input.route,'/v1/chat/completions');assert.equal(input.adapter_id,'openai-chat-completions');
    assert.equal(input.body.encoding,'json');if(input.body.encoding==='json')captured=input.body.json;
    assert.ok(!JSON.stringify(input).includes('test-secret-key'));
  };
  const adapter=new ChatCompletionsAdapter(async(url,init)=>{
    calls++;assert.equal(String(url),'https://example.com/v1/chat/completions');
    assert.equal(init?.method,'POST');assert.equal(init?.body,captured);assert.equal(init?.redirect,'error');
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer test-secret-key');
    assert.deepEqual(JSON.parse(String(init?.body)),{model:'vendor-model',messages:[{role:'user',content:'第一段\n第二段'}],stream:false,max_completion_tokens:16384});
    return success('  保留完整结果。  ',{reasoning_content:'private internal reasoning'});
  });
  const result=await new ExecutionRegistry().register(adapter).execute(c,signal(),quiet);
  assert.equal(calls,1);assert.deepEqual(result,{images:[],text:'保留完整结果。',request_id:'request_test',usage:{prompt_tokens:5,completion_tokens:8,total_tokens:13}});
});

test('Explicit compatibility parameters are serialized once, respecting the tighter context token cap',async()=>{
  for(const field of ['max_completion_tokens','max_tokens']){
    const c=context();c.text_output_limit=4096;
    c.job.recipe_snapshot.core_parameters.extensions={'openai-chat-completions':{temperature:0,reasoning_effort:'low',max_output_tokens:20000,token_limit_field:field}};
    const adapter=new ChatCompletionsAdapter(async(_url,init)=>{
      const body=JSON.parse(String(init?.body));assert.equal(body[field],4096);
      assert.equal(body[field==='max_tokens'?'max_completion_tokens':'max_tokens'],undefined);
      assert.equal(body.temperature,0);assert.equal(body.reasoning_effort,'low');
      assert.equal(body.max_output_tokens,undefined);assert.equal(body.token_limit_field,undefined);return success();
    });
    await adapter.execute(c,signal(),quiet);
  }
  const c=context();c.text_output_limit=16384;c.job.recipe_snapshot.core_parameters.extensions={'openai-chat-completions':{max_output_tokens:128}};
  await new ChatCompletionsAdapter(async(_url,init)=>{assert.equal(JSON.parse(String(init?.body)).max_completion_tokens,128);return success();}).execute(c,signal(),quiet);
});

test('Vision requests preserve native text/image order, repeated images and actual PNG/JPEG/WebP MIME types',async()=>{
  const jpeg=await sharp(imageBytes).jpeg().toBuffer(),webp=await sharp(imageBytes).webp().toBuffer();
  const images:Record<string,Buffer>={asset_png:imageBytes,asset_jpeg:jpeg,asset_webp:webp};
  const c=context([blockText('image_1'),blockImage('asset_png'),blockText('image_2'),blockImage('asset_jpeg'),blockImage('asset_webp'),blockImage('asset_png'),blockText('保持顺序')],4),read:string[]=[];
  c.readImage=async id=>{read.push(id);return images[id];};
  c.job.recipe_snapshot.core_parameters.extensions={'openai-chat-completions':{image_detail:'high'}};
  await new ChatCompletionsAdapter(async(_url,init)=>{
    const parts=JSON.parse(String(init?.body)).messages[0].content;
    assert.deepEqual(parts.map((part:any)=>part.type==='text'?part.text:part.image_url.url.split(';')[0]),['image_1','data:image/png','image_2','data:image/jpeg','data:image/webp','data:image/png','保持顺序']);
    for(const part of parts.filter((part:any)=>part.type==='image_url'))assert.equal(part.image_url.detail,'high');
    assert.equal(parts[1].image_url.url,parts[5].image_url.url);return success();
  }).execute(c,signal(),quiet);
  assert.deepEqual(read,['asset_png','asset_jpeg','asset_webp','asset_png']);
});

test('Separated vision input preserves image order and omits image detail when unset',async()=>{
  const c=context([],3);c.job.adapted_input={kind:'separated_inputs',prompt:'image_1 与 image_2',image_asset_ids:['asset_one','asset_two','asset_one'],adjustments:[]};
  c.readImage=async()=>imageBytes;
  await new ChatCompletionsAdapter(async(_url,init)=>{
    const content=JSON.parse(String(init?.body)).messages[0].content;
    assert.equal(content[0].text,'image_1 与 image_2');assert.equal(content.length,4);
    for(const part of content.slice(1))assert.deepEqual(Object.keys(part.image_url),['url']);
    return success();
  }).execute(c,signal(),quiet);
});

test('Generation, mask, missing understanding capability and excess image inputs never reach the network',async()=>{
  let calls=0,reads=0;const adapter=new ChatCompletionsAdapter(async()=>{calls++;return success();});
  const generation=context();generation.model.purpose='generation';
  const missing=context();missing.model.capabilities.operations=[];
  const masked=context();masked.job.mask_edit={} as Job['mask_edit'];
  const excess=context([blockImage('asset_one'),blockImage('asset_one')],1);excess.readImage=async()=>{reads++;return imageBytes;};
  const textOnly=context([blockImage('asset_one')],0);
  for(const c of [generation,missing,masked,excess,textOnly])await assert.rejects(adapter.execute(c,signal(),quiet),/仅支持|上限/);
  assert.equal(calls,0);assert.equal(reads,0);
});

test('Malformed or oversized images and request bodies fail before credentials or network use',async()=>{
  let calls=0,credentials=0;const adapter=new ChatCompletionsAdapter(async()=>{calls++;return success();});
  const bad=context([blockImage('asset_one')],1);bad.resolveCredential=async()=>{credentials++;return 'key';};
  for(const bytes of [Buffer.from('not an image'),imageBytes.subarray(0,Math.floor(imageBytes.length/2)),Buffer.alloc(20*1024*1024+1)]){
    bad.readImage=async()=>bytes;
    await assert.rejects(adapter.execute(bad,signal(),quiet),/参考图/);
  }
  const oversized=context([blockText('x'.repeat(50*1024*1024+1))]);oversized.resolveCredential=bad.resolveCredential;
  await assert.rejects(adapter.execute(oversized,signal(),quiet),/50 MB/);
  // Escaping can exceed the budget even when the original text fits.
  const escaped=context([blockText('"'.repeat(26*1024*1024))]);escaped.resolveCredential=bad.resolveCredential;
  await assert.rejects(adapter.execute(escaped,signal(),quiet),/完整请求.*50 MB/);
  assert.equal(calls,0);assert.equal(credentials,0);
});

test('Rejected parameters and protocol-mismatched extensions do not trigger compatibility retries',async()=>{
  let calls=0;const adapter=new ChatCompletionsAdapter(async()=>{calls++;return success();});
  for(const values of [{temperature:3},{reasoning_effort:'extreme'},{max_output_tokens:0},{max_output_tokens:1.5},{token_limit_field:'unknown'},{unknown:true}]){
    const c=context();c.job.recipe_snapshot.core_parameters.extensions={'openai-chat-completions':values};
    await assert.rejects(adapter.execute(c,signal(),quiet));
  }
  const c=context();c.job.recipe_snapshot.core_parameters.extensions={'gemini-generate-content':{thinking_level:'high'}};
  await assert.rejects(adapter.execute(c,signal(),quiet),/其他执行协议/);assert.equal(calls,0);
});

test('Refusals, tool calls, truncation, missing finish reason and invalid text cannot become accepted suggestions',async()=>{
  const replies=[
    {finish_reason:'length',message:{content:'partial'}},{finish_reason:'content_filter',message:{content:'filtered'}},
    {message:{content:'missing finish reason'}},{finish_reason:'stop',message:{content:'',reasoning_content:'reasoning is not output'}},
    {finish_reason:'stop',message:{content:' ',refusal:'拒绝'}},{finish_reason:'stop',message:{content:'text',tool_calls:[{id:'tool'}]}},
    {finish_reason:'stop',message:{content:'text',function_call:{name:'tool'}}},{finish_reason:'stop',message:{content:'text',audio:{id:'audio'}}},
    {finish_reason:'stop',message:{content:[{type:'text',text:'wrong shape'}]}},{finish_reason:'stop',message:{content:'x'.repeat(32001)}},
  ];
  for(const reply of replies){
    let calls=0;const adapter=new ChatCompletionsAdapter(async()=>{calls++;return Response.json({choices:[reply]});});
    await assert.rejects(adapter.execute(context(),signal(),quiet));assert.equal(calls,1);
  }
});

test('HTTP failures, invalid JSON, excessive responses and fetch errors stay redacted and are never retried',async()=>{
  const requests:(()=>Promise<Response>)[]=[
    ...[400,401,403,413,429,503].map(status=>async()=>Response.json({error:'test-secret-key private details'},{status})),
    async()=>new Response('test-secret-key private details'),
    async()=>new Response('x'.repeat(2*1024*1024+1)),
    async()=>{throw new Error('test-secret-key private URL');},
  ];
  for(const request of requests){
    let calls=0;const adapter=new ChatCompletionsAdapter(async()=>{calls++;return request();});
    await assert.rejects(adapter.execute(context(),signal(),quiet),error=>error instanceof Error&&!/test-secret-key|private/.test(error.message)&&error.message.includes('未自动重试'));
    assert.equal(calls,1);
  }
});

test('Cancellation at each pre-send boundary prevents requests, and in-flight cancellation is not retried',async()=>{
  for(const stage of ['initial','image','progress','capture','credential']){
    const controller=new AbortController(),c=stage==='image'?context([blockImage('asset_one')],1):context();let calls=0;
    if(stage==='initial')controller.abort();
    c.readImage=async()=>{controller.abort();return imageBytes;};
    c.recordModelInput=async()=>{if(stage==='capture')controller.abort();};
    c.resolveCredential=async()=>{if(stage==='credential')controller.abort();return 'key';};
    const progress=async()=>{if(stage==='progress')controller.abort();};
    await assert.rejects(new ChatCompletionsAdapter(async()=>{calls++;return success();}).execute(c,controller.signal,progress),/取消.*未发送请求/);
    assert.equal(calls,0,stage);
  }
  const controller=new AbortController();let calls=0;
  const adapter=new ChatCompletionsAdapter(async(_url,init)=>{
    calls++;return new Promise<Response>((_resolve,reject)=>{
      init?.signal?.addEventListener('abort',()=>reject(new Error('secret upstream abort')),{once:true});controller.abort();
    });
  });
  await assert.rejects(adapter.execute(context(),controller.signal,quiet),/已取消.*未自动重试/);assert.equal(calls,1);
});

test('Module subject inference reaches Chat Completions with frozen image context and returns an unapplied suggestion',async()=>{
  const registry=new ModuleRegistry(),subject=registry.create('subject'),prompt=registry.create('prompt');
  subject.asset_ids=['asset_front','asset_side','asset_front'];subject.user_instruction='保留瓶身标识';prompt.user_instruction='不要发送其它模块';
  const config=model(3),recipe:Recipe={recipe_id:'recipe_chat',schema_version:1,modules:[subject,prompt],model_config_id:'model_generation',core_parameters:defaultParameters};
  const before=structuredClone(recipe),prepared=prepareModuleInference(recipe,subject.module_id,'把瓶盖改成白色',config,registry);
  const read:string[]=[];let calls=0;
  const adapter=new ChatCompletionsAdapter(async(_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));assert.equal(body.max_completion_tokens,16384);
    assert.equal(body.messages[0].content.filter((part:any)=>part.type==='image_url').length,3);
    assert.match(body.messages[0].content[0].text,/把瓶盖改成白色/);assert.ok(!JSON.stringify(body).includes('不要发送其它模块'));
    return success('白色瓶盖，保留瓶身标识。');
  });
  const suggestion=await executeModuleInference(new ExecutionRegistry().register(adapter),{model:config,job:prepared.job,readImage:async id=>{read.push(id);return imageBytes;},resolveCredential:async()=>'test-key'},prepared,signal());
  assert.equal(calls,1);assert.equal(suggestion.original_text,'把瓶盖改成白色');assert.equal(suggestion.text,'白色瓶盖，保留瓶身标识。');
  assert.equal(suggestion.images_sent,3);assert.deepEqual(read,['asset_front','asset_side','asset_front']);assert.deepEqual(recipe,before);
});
