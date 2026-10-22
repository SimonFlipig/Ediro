import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readReferenceImage,resizeReferenceImage } from '../src/adapters/reference-image.js';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ImagesGenerator } from '../src/adapters/images-generator.js';
import { ChatCompletionsAdapter } from '../src/adapters/chat-completions.js';
import { MockGenerator } from '../src/adapters/mock-generator.js';
import { seedModels } from '../src/core/models.js';
import { chatProfile } from '../src/protocols/chat-profile.js';
import type { Block,Job,ModelConfig } from '../src/core/domain.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import type { ModelInput } from '../src/core/model-input.js';

const settings={version:1 as const,composition:{max_edge:1024 as const},style:{max_edge:512 as const}};
const signal=()=>new AbortController().signal,quiet=async()=>{};
const source=await sharp({create:{width:1600,height:800,channels:4,background:{r:100,g:140,b:180,alpha:0.4}}}).png().toBuffer();
const output=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
async function dimensions(bytes:Buffer){const meta=await sharp(bytes).metadata();return [meta.width,meta.height];}
function image(reference_type:string,asset_id='asset_shared'):Block{return {type:'image',asset_id,reference_type,source_module_id:`module_${reference_type}`,reference_id:`reference_${reference_type}`};}
function context():CloudExecutionContext{
  const blocks:Block[]=['subject','composition','style','image_text'].flatMap(type=>[
    {type:'text',text:`使用 ${type} 参考`,reference_type:type,source_module_id:`module_${type}`,reference_id:`reference_${type}`} as Block,image(type),
  ]);
  const model=seedModels()[2];model.endpoint='https://example.com';
  const modules=blocks.filter(block=>block.type==='image').map(block=>({module_id:block.source_module_id,reference_type:block.reference_type,asset_ids:[block.asset_id]}));
  const job={module_settings_snapshot:structuredClone(settings),recipe_snapshot:{modules,core_parameters:structuredClone(model.defaults)},chain_snapshot:{blocks,mode:'reference_generation'},adapted_input:{kind:'native_blocks',blocks:structuredClone(blocks),adjustments:[]}} as unknown as Job;
  return {model,job,readImage:async()=>source,resolveCredential:async()=>'test-key'};
}

test('清晰缩图保持比例，支持 1K 和 512 长边、横竖图、小图与透明通道',async()=>{
  for(const edge of [1024,512] as const){
    const result=await resizeReferenceImage(source,edge);
    assert.deepEqual(await dimensions(result),[edge,edge/2]);
    assert.equal((await sharp(result).metadata()).hasAlpha,true);
    const {data,info}=await sharp(result).raw().toBuffer({resolveWithObject:true});
    assert.equal(info.channels,4);assert.equal(data[3],102);
    const portrait=await sharp(source).rotate(90).png().toBuffer();
    assert.deepEqual(await dimensions(await resizeReferenceImage(portrait,edge)),[edge/2,edge]);
    assert.strictEqual(await resizeReferenceImage(output,edge),output);
  }
});

test('缩图按 EXIF 修正方向，完整解码失败时不以缩略图或原图回退',async()=>{
  const oriented=await sharp(source).jpeg().withMetadata({orientation:6}).toBuffer();
  const resized=await resizeReferenceImage(oriented,1024);
  assert.deepEqual(await dimensions(resized),[512,1024]);
  assert.equal((await sharp(resized).metadata()).orientation,undefined);
  await assert.rejects(resizeReferenceImage(Buffer.from('broken image'),1024),/参考图无法缩图/);
  await assert.rejects(resizeReferenceImage(source.subarray(0,Math.floor(source.length/2)),512),/参考图无法缩图/);
});

test('同一素材在各模块中按引用次序处理，主体和图文保持原字节',async()=>{
  const c=context(),read:string[]=[];c.readImage=async id=>{read.push(id);return source;};
  assert.strictEqual(await readReferenceImage(c,'asset_shared',0),source);
  assert.deepEqual(await dimensions(await readReferenceImage(c,'asset_shared',1)),[1024,512]);
  assert.deepEqual(await dimensions(await readReferenceImage(c,'asset_shared',2)),[512,256]);
  assert.strictEqual(await readReferenceImage(c,'asset_shared',3),source);
  assert.deepEqual(read,Array(4).fill('asset_shared'));
  await assert.rejects(readReferenceImage(c,'asset_other',1),/顺序/);
  await assert.rejects(readReferenceImage(c,'asset_shared',4),/顺序/);
  assert.equal(read.length,4);
});

test('没有处理快照的历史任务和蒙版任务保持原字节',async()=>{
  const legacy=context();delete legacy.job.module_settings_snapshot;
  assert.strictEqual(await readReferenceImage(legacy,'asset_shared',1),source);
  const mask=context();mask.job.mask_edit={} as Job['mask_edit'];
  assert.strictEqual(await readReferenceImage(mask,'asset_shared',1),source);
});

function configure(c:CloudExecutionContext,protocol:'gemini'|'images'|'chat',separated:boolean){
  if(protocol==='images'){
    c.model=seedModels()[3];c.model.adapter_id='openai-images';c.model.endpoint='https://example.com';
    c.model.capabilities.operations=['generate','referenceEdit'];
  }else if(protocol==='chat'){
    c.model={...c.model,adapter_id:'openai-chat-completions',purpose:'understanding',generation_contract:chatProfile,
      capabilities:{interleaving:'native',max_images:4,aspect_ratios:['auto'],qualities:['standard'],formats:['png'],max_count:1,operations:['understand']},
      defaults:{version:2,aspect_ratio:'auto',quality:'standard',output_format:'png',count:1,resolution:{mode:'default'},extensions:{}}} as ModelConfig;
  }
  c.job.recipe_snapshot.core_parameters=structuredClone(c.model.defaults);
  if(separated)c.job.adapted_input={kind:'separated_inputs',prompt:'保留产品，使用构图与风格参考。',image_asset_ids:Array(4).fill('asset_shared'),adjustments:[]};
}

async function wireImages(body:string|FormData,protocol:'gemini'|'images'|'chat'):Promise<Buffer[]>{
  if(typeof body!=='string'){
    const files:Blob[]=[];body.forEach(value=>{if(typeof value!=='string')files.push(value);});
    return Promise.all(files.map(async value=>Buffer.from(await value.arrayBuffer())));
  }
  const parsed=JSON.parse(body);
  if(protocol==='gemini')return parsed.contents[0].parts.filter((part:any)=>part.inlineData).map((part:any)=>Buffer.from(part.inlineData.data,'base64'));
  return parsed.messages[0].content.filter((part:any)=>part.type==='image_url').map((part:any)=>Buffer.from(part.image_url.url.split(',')[1],'base64'));
}

test('三种真实协议的模拟请求与实际请求记录均发送各模块正确尺寸，保持图片顺序',async()=>{
  for(const [protocol,separated] of [['gemini',false],['gemini',true],['images',true],['chat',false],['chat',true]] as const){
    const c=context();configure(c,protocol,separated);let captured:ModelInput|undefined,calls=0;
    c.recordModelInput=async input=>{captured=input;};
    const request:typeof fetch=async(_url,init)=>{
      calls++;const images=await wireImages(init!.body as string|FormData,protocol);
      assert.deepEqual(await Promise.all(images.map(dimensions)),[[1600,800],[1024,512],[512,256],[1600,800]],`${protocol} ${separated}`);
      assert.deepEqual(images[0],source);assert.deepEqual(images[3],source);
      assert.ok(captured);
      const recorded=captured.body.encoding==='json'?await wireImages(captured.body.json,protocol):captured.body.encoding==='multipart'?captured.body.fields.flatMap(field=>typeof field.value==='string'?[]:[Buffer.from(field.value.data_base64,'base64')]):[];
      assert.deepEqual(recorded,images);
      return protocol==='gemini'?Response.json({candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'image/png',data:output.toString('base64')}}]}}]}):protocol==='images'?Response.json({data:[{b64_json:output.toString('base64')}] }):Response.json({choices:[{finish_reason:'stop',message:{content:'文字结果'}}]});
    };
    const adapter=protocol==='gemini'?new GeminiGenerator(request):protocol==='images'?new ImagesGenerator(request):new ChatCompletionsAdapter(request);
    await adapter.execute(c,signal(),quiet);assert.equal(calls,1);
  }
});

test('零网络模拟执行的输入捕获同样使用处理后图片',async()=>{
  for(const separated of [false,true]){
    const c=context();c.model=seedModels()[0];c.job.task_id='task_preprocessing';
    c.job.recipe_snapshot.core_parameters=structuredClone(c.model.defaults);
    if(separated)c.job.adapted_input={kind:'separated_inputs',prompt:'test',image_asset_ids:Array(4).fill('asset_shared'),adjustments:[]};
    let captured=false;
    c.recordModelInput=async input=>{
      assert.equal(input.body.encoding,'simulation');if(input.body.encoding!=='simulation')return;
      const images=input.body.blocks.flatMap((block:any)=>block.inlineData?[Buffer.from(block.inlineData.data,'base64')]:[]);
      assert.deepEqual(await Promise.all(images.map(dimensions)),[[1600,800],[1024,512],[512,256],[1600,800]]);captured=true;
    };
    const result=await new MockGenerator(0).execute(c,signal(),quiet);
    assert.equal(captured,true);assert.equal(result.images.length,1);
  }
});
