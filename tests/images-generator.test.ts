import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ImagesGenerator,imagesRoot } from '../src/adapters/images-generator.js';
import { seedModels,ModelLibrary } from '../src/core/models.js';
import { migrateModels,mockDescription } from '../src/core/model-library.js';
import { adaptChain } from '../src/core/compiler.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import type { Job } from '../src/core/domain.js';
import { resolveOutputGeometry } from '../src/core/output-geometry.js';
import { ModuleRegistry } from '../src/core/modules.js';
const png=await sharp({create:{width:12,height:8,channels:3,background:'#fff'}}).png().toBuffer();
const jpeg=await sharp(png).jpeg().toBuffer();
function context(ids:string[]=[]):CloudExecutionContext{
  const model=seedModels()[3];model.adapter_id='openai-images';model.model='gpt-image-2.5-sunburst';model.endpoint='https://images.example';model.capabilities.operations=['generate','referenceEdit'];model.images_compatibility={format_field:'format',image_field:'image',send_response_format:true,max_prompt_chars:1000};
  const job={recipe_snapshot:{core_parameters:model.defaults},adapted_input:{kind:'separated_inputs',prompt:'白色商品，保持参考图片顺序',image_asset_ids:ids,adjustments:[]}} as unknown as Job;
  return {model,job,resolveCredential:async()=>'test-key',readImage:async()=>png};
}
test('兼容文生图使用 format、Base64 与尺寸映射；实际 JPEG 如实保存',async()=>{
  const c=context();c.job.recipe_snapshot.core_parameters.aspect_ratio='3:2';let calls=0;
  const adapter=new ImagesGenerator(async(url,init)=>{calls++;assert.equal(String(url),'https://images.example/v1/images/generations');assert.equal((init!.headers as any).Authorization,'Bearer test-key');const body=JSON.parse(init!.body as string);assert.deepEqual(body,{model:'gpt-image-2.5-sunburst',prompt:c.job.adapted_input.prompt,size:'1536x1024',quality:'high',format:'png',n:1,response_format:'b64_json'});return Response.json({data:[{b64_json:jpeg.toString('base64')}],usage:{total_tokens:4,secret:'test-key'}});});
  const result=await adapter.execute(c,new AbortController().signal,async()=>{});assert.equal(calls,1);assert.equal(result.images[0].format,'jpeg');assert.equal(result.images[0].width,12);assert.deepEqual(result.usage,{total_tokens:4});
});
test('多图编辑按编译结果重复 image 字段，不去重，不发送路径',async()=>{
  const c=context(['asset_one','asset_two','asset_one']);const read:string[]=[];c.readImage=async id=>{read.push(id);return id==='asset_two'?jpeg:png;};
  c.job.adapted_input=adaptChain({mode:'reference_generation',blocks:[{type:'text',text:'主体',source_module_id:'mod_one',reference_type:'subject',reference_id:'ref_one'},...['asset_one','asset_two','asset_one'].map(asset_id=>({type:'image' as const,asset_id,source_module_id:'mod_one',reference_type:'subject',reference_id:'ref_one'})),{type:'text',text:'保持细节',source_module_id:'mod_two',reference_type:'prompt',reference_id:'ref_two'}]},c.model);
  const adapter=new ImagesGenerator(async(url,init)=>{assert.ok(String(url).endsWith('/images/edits'));assert.equal((init!.headers as any)['Content-Type'],undefined);const body=init!.body as FormData;assert.equal(body.get('response_format'),'b64_json');assert.match(String(body.get('prompt')),/第 3 输入图片/);const files=body.getAll('image') as File[];assert.deepEqual(files.map(f=>f.type),['image/png','image/jpeg','image/png']);assert.deepEqual(files.map(f=>f.name),['reference-1.png','reference-2.jpeg','reference-3.png']);assert.ok(!String(body.get('prompt')).includes('asset_one'));return Response.json({data:[{b64_json:png.toString('base64')}]});});
  await adapter.execute(c,new AbortController().signal,async()=>{});assert.deepEqual(read,['asset_one','asset_two','asset_one']);
});
test('非法输入执行前拒绝；不截断提示词、不静默丢图',async()=>{
  let calls=0;const adapter=new ImagesGenerator(async()=>{calls++;return Response.json({});});const c=context();c.job.adapted_input.prompt='字'.repeat(1001);await assert.rejects(()=>adapter.execute(c,new AbortController().signal,async()=>{}),/1000/);
  c.job.adapted_input.prompt='画图';c.job.adapted_input.image_asset_ids=Array(17).fill('asset_one');await assert.rejects(()=>adapter.execute(c,new AbortController().signal,async()=>{}),/16/);c.job.adapted_input.image_asset_ids=[];c.job.recipe_snapshot.core_parameters.aspect_ratio='16:9';await assert.rejects(()=>adapter.execute(c,new AbortController().signal,async()=>{}),/参数/);assert.equal(calls,0);
});
test('错误不回显凭据、不重试；URL、坏图与部分结果拒绝保存',async()=>{
  let calls=0;const failed=new ImagesGenerator(async()=>{calls++;return Response.json({error:{message:'test-key'}},{status:429});});await assert.rejects(()=>failed.execute(context(),new AbortController().signal,async()=>{}),e=>e instanceof Error&&e.message.includes('受限')&&!e.message.includes('test-key'));assert.equal(calls,1);
  for(const data of [[{url:'https://example.com/image'}],[{b64_json:Buffer.from('invalid').toString('base64')}],[]]){const adapter=new ImagesGenerator(async()=>Response.json({data}));await assert.rejects(()=>adapter.execute(context(),new AbortController().signal,async()=>{}));}
});
test('根地址及模型列表发现；新适配器复用模型库能力过滤',async()=>{
  assert.equal(imagesRoot('https://images.example/v1/'),'https://images.example/v1');assert.throws(()=>imagesRoot('https://images.example/v1beta'));assert.throws(()=>imagesRoot('https://user:pass@api.kuai.host'));
  const adapter=new ImagesGenerator(async url=>{assert.equal(String(url),'https://images.example/v1/models');return Response.json({data:[{id:'gpt-image-2.5-sunburst'},{id:'chat-model'},{id:'chat-model'}]});});assert.deepEqual(await adapter.probe('https://images.example','key',new AbortController().signal),['gpt-image-2.5-sunburst','chat-model']);
  const data=migrateModels(seedModels());const model=data.models[3];model.adapter_id='openai-images';model.capabilities.operations=['generate','referenceEdit'];model.capabilities.aspect_ratios.push('16:9');
  const library=new ModelLibrary(data,async()=>{},{has:async()=>true,set:async()=>{}},[mockDescription,adapter.description]);assert.ok(library.resolve(model.model_config_id).capabilities.aspect_ratios.includes('16:9'));assert.ok(library.resolve(model.model_config_id).capabilities.aspect_ratios.includes('1:1'));
});
test('模型蒙版声明与已接入的执行器能力共同决定可用操作',async()=>{
  const data=migrateModels(seedModels()),model=data.models[3];model.adapter_id='openai-images';data.connections[1].credential_ref='credential_test';
  const library=new ModelLibrary(data,async()=>{},{has:async()=>true,set:async()=>{}},[mockDescription,new ImagesGenerator().description]);
  await library.saveModel(model);
  const after=(await library.list()).find(m=>m.model_config_id===model.model_config_id)!;assert.equal(after.executable,true);assert.equal(after.readiness_error,undefined);assert.deepEqual(after.capabilities.operations,['generate','referenceEdit','nativeMaskEdit']);assert.ok(after.declared_capabilities!.operations.includes('nativeMaskEdit'));assert.deepEqual(after.unavailable_operations,[]);assert.ok(library.snapshot().models[3].capabilities.operations.includes('nativeMaskEdit'));
});
test('官方 Images 默认字段与兼容配置独立，地址不决定请求协议',async()=>{
  for(const endpoint of ['https://official.example','https://relay.example/custom']){
    const c=context(['asset_one']);delete c.model.images_compatibility;c.model.endpoint=endpoint;
    const adapter=new ImagesGenerator(async(url,init)=>{assert.equal(String(url),`${endpoint}/v1/images/edits`);const form=init!.body as FormData;assert.equal(form.get('output_format'),'png');assert.equal(form.get('format'),null);assert.equal(form.get('response_format'),null);assert.equal(form.getAll('image[]').length,1);assert.equal(form.getAll('image').length,0);return Response.json({data:[{b64_json:png.toString('base64')}]});});
    await adapter.execute(c,new AbortController().signal,async()=>{});
  }
  const c=context();delete c.model.images_compatibility;const adapter=new ImagesGenerator(async(_url,init)=>{const body=JSON.parse(init!.body as string);assert.equal(body.output_format,'png');assert.equal(body.format,undefined);assert.equal(body.response_format,undefined);return Response.json({data:[{b64_json:png.toString('base64')}]});});await adapter.execute(c,new AbortController().signal,async()=>{});
});
test('自动及自定义尺寸传入 Images 请求，原配方比例保持不变',async()=>{
  for(const size of ['auto','2192x1440']){const c=context();c.job.recipe_snapshot.core_parameters.aspect_ratio='auto';c.job.output_geometry={selection:'auto',basis:size==='auto'?'model':'composition',target:size==='auto'?'auto':'size',...(size==='auto'?{}:{request_size:size,ratio:'137:90'}),adjustments:[]};const adapter=new ImagesGenerator(async(_url,init)=>{assert.equal(JSON.parse(init!.body as string).size,size);return Response.json({data:[{b64_json:png.toString('base64')}]});});await adapter.execute(c,new AbortController().signal,async()=>{});assert.equal(c.job.recipe_snapshot.core_parameters.aspect_ratio,'auto');}
});

test('自动比例从参考图解析为标准比例后，文生图与编辑均发送明确 size',async()=>{
  for(const ids of [[],['asset_reference']])for(const [width,height,size] of [[1024,1024,'1024x1024'],[1536,1024,'1536x1024'],[1024,1536,'1024x1536']] as const){
    const c=context(ids),module=new ModuleRegistry().create('composition');module.asset_ids=['asset_reference'];
    c.model.geometry_support='size';c.job.recipe_snapshot.modules=[module];c.job.recipe_snapshot.core_parameters.aspect_ratio='auto';
    c.job.output_geometry=resolveOutputGeometry(c.job.recipe_snapshot,[{asset_id:'asset_reference',width,height}],c.model);
    assert.equal(c.job.output_geometry.target,'ratio');
    const adapter=new ImagesGenerator(async(_url,init)=>{const body=init!.body;assert.equal(typeof body==='string'?JSON.parse(body).size:(body as FormData).get('size'),size);return Response.json({data:[{b64_json:png.toString('base64')}]});});
    await adapter.execute(c,new AbortController().signal,async()=>{});assert.equal(c.job.recipe_snapshot.core_parameters.aspect_ratio,'auto');
  }
});

test('等待超时与用户取消分别报告，不自动重试',async()=>{
  for(const timeout of [true,false]){
    const controller=new AbortController();let calls=0;
    const adapter=new ImagesGenerator(async()=>{calls++;controller.abort(new DOMException('aborted',timeout?'TimeoutError':'AbortError'));throw controller.signal.reason;});
    await assert.rejects(()=>adapter.execute(context(),controller.signal,async()=>{}),timeout?/超过 10 分钟/:/请求已取消/);
    assert.equal(calls,1);
  }
});
