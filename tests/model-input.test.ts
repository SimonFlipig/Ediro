import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import { mkdir,mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ImagesGenerator } from '../src/adapters/images-generator.js';
import { ProjectRepository } from '../src/adapters/project-repository.js';
import { seedModels } from '../src/core/models.js';
import { modelInputSchema,type ModelInput } from '../src/core/model-input.js';
import type { Job } from '../src/core/domain.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import {MB} from '../src/core/image-limits.js';
import {modelFromPreset} from '../src/protocols/model-catalog.js';
const png=await sharp({create:{width:10,height:12,channels:3,background:'#abc'}}).png().toBuffer();
async function repository(){const root=path.join(process.cwd(),'.local','test-inputs');await mkdir(root,{recursive:true});return new ProjectRepository(await mkdtemp(path.join(root,'case-')));}
test('Google 捕获实际 JSON 包括最终比例提示和原始图片，失败后仍可读取且不含凭据',async()=>{
  const repo=await repository(),model=seedModels()[2];let sent='';
  const job={recipe_snapshot:{core_parameters:{...model.defaults,aspect_ratio:'auto'}},output_geometry:{target:'auto',ratio:'137:90'},adapted_input:{kind:'native_blocks',blocks:[{type:'text',text:'原始要求'},{type:'image',asset_id:'asset_one'}]}} as unknown as Job;
  const c:CloudExecutionContext={model,job,readImage:async()=>png,resolveCredential:async()=>'test-key',recordModelInput:input=>repo.saveModelInput('task_one',input)};
  const adapter=new GeminiGenerator(async(_url,init)=>{sent=init!.body as string;assert.ok(await repo.loadModelInput('task_one'));return Response.json({},{status:429});});
  await assert.rejects(()=>adapter.execute(c,new AbortController().signal,async()=>{}),/受限/);
  const recorded=(await repo.loadModelInput('task_one'))!;assert.equal(recorded.body.encoding,'json');if(recorded.body.encoding!=='json')throw new Error('encoding');
  assert.equal(recorded.body.json,sent);const body=JSON.parse(sent);assert.equal(body.contents[0].parts[1].inlineData.data,png.toString('base64'));assert.match(body.contents[0].parts.at(-1).text,/137:90/);assert.ok(!JSON.stringify(recorded).includes('test-key'));
});
test('Images 捕获实际 multipart 字段、重复图片、文件名与字节，保存失败阻止发送',async()=>{
  const model=seedModels()[3];model.adapter_id='openai-images';model.capabilities.operations=['referenceEdit'];let capture:ModelInput|undefined;
  const job={recipe_snapshot:{core_parameters:model.defaults},adapted_input:{kind:'separated_inputs',prompt:'保持第 1、2 输入图片中主体。',image_asset_ids:['asset_one','asset_one']}} as unknown as Job;
  const c:CloudExecutionContext={model,job,readImage:async()=>png,resolveCredential:async()=>'test-key',recordModelInput:async input=>{capture=input;}};
  let calls=0;const adapter=new ImagesGenerator(async(_url,init)=>{calls++;assert.ok(capture);if(capture!.body.encoding!=='multipart')throw new Error('encoding');const expected=await Promise.all(Array.from((init!.body as FormData).entries()).map(async([name,value])=>({name,value:typeof value==='string'?value:{filename:value.name,mime_type:value.type,data_base64:Buffer.from(await value.arrayBuffer()).toString('base64')}})));assert.deepEqual(capture!.body.fields,expected);return Response.json({data:[{b64_json:png.toString('base64')}]});});
  await adapter.execute(c,new AbortController().signal,async()=>{});assert.equal(calls,1);assert.ok(!JSON.stringify(capture).includes('test-key'));
  c.recordModelInput=async()=>{throw new Error('存储失败');};await assert.rejects(()=>adapter.execute(c,new AbortController().signal,async()=>{}),/存储失败/);assert.equal(calls,1);
});
test('输入记录不允许鉴权头及带查询的路由；读取缺失记录不重建，非法任务路径被拒绝',async()=>{
  const base={version:1,adapter_id:'test',captured_at:'now',route:'/images/edits',body:{encoding:'json',json:'{}'}};
  assert.equal(modelInputSchema.safeParse({...base,headers:{Authorization:'secret'}}).success,false);
  assert.equal(modelInputSchema.safeParse({...base,route:'/images?key=secret'}).success,false);
  const repo=await repository();assert.equal(await repo.loadModelInput('task_missing'),null);await assert.rejects(()=>repo.loadModelInput('../escape'));
});

test('Banana 大裁片双图超过旧 20 MB 和 3000 万字符限制仍原样发送，记录可重读；渠道预算按编码后计算',async()=>{
  const width=3072,height=3072;
  const source=await sharp(randomBytes(width*height*3),{raw:{width,height,channels:3}}).png({compressionLevel:0}).toBuffer();
  const guide=await sharp({create:{width,height,channels:3,background:'#fff'}}).png().toBuffer();
  assert.ok(source.length+guide.length<30*MB);
  const repo=await repository(),model=modelFromPreset('nano-banana-pro','model_large','channel_large','relay-banana');
  model.endpoint='https://test.invalid';
  const job={task_id:'task_large_banana',recipe_snapshot:{core_parameters:model.defaults},
    mask_edit:{method:'guided',request_source_id:'asset_source',guide_asset_id:'asset_guide',crop:{x:0,y:0,width,height}},
    adapted_input:{kind:'native_blocks',blocks:[{type:'image',asset_id:'asset_source'},{type:'image',asset_id:'asset_guide'},{type:'text',text:'仅编辑白色区域'}]}} as Job;
  let calls=0,captures=0,credentials=0;
  const c:CloudExecutionContext={model,job,readImage:async id=>id==='asset_source'?source:guide,resolveCredential:async()=>{credentials++;return 'test-key';},recordModelInput:async input=>{captures++;await repo.saveModelInput(job.task_id,input);}};
  const adapter=new GeminiGenerator(async(_url,init)=>{
    calls++;const body=String(init!.body);assert.ok(Buffer.byteLength(body)>30*MB);assert.ok(body.length>30_000_000);
    const captured=await repo.loadModelInput(job.task_id);assert.equal(captured?.body.encoding,'json');
    if(captured?.body.encoding!=='json')throw new Error('encoding');assert.equal(captured.body.json,body);
    assert.ok(!body.includes('test-key'));assert.ok(!body.includes('gemini_compatibility'));
    const parts=JSON.parse(body).contents[0].parts;assert.equal(parts.length,3);
    assert.deepEqual(Buffer.from(parts[0].inlineData.data,'base64'),source);assert.deepEqual(Buffer.from(parts[1].inlineData.data,'base64'),guide);
    return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]});
  });
  await adapter.execute(c,new AbortController().signal,async()=>{});assert.equal(calls,1);
  model.gemini_compatibility={max_request_mb:30};
  await assert.rejects(()=>adapter.execute(c,new AbortController().signal,async()=>{}),/当前渠道的 30 MB.*未发送请求/);
  assert.equal(calls,1);assert.equal(captures,1);assert.equal(credentials,1);
});
