import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ImagesGenerator } from '../src/adapters/images-generator.js';
import { ExecutionRegistry } from '../src/adapters/execution-registry.js';
import { planExecution } from '../src/core/execution-plan.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { seedModels } from '../src/core/models.js';
import { defaultPromptConfig } from '../src/core/prompt-config.js';
import type { Job,Recipe } from '../src/core/domain.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import type { ModelInput } from '../src/core/model-input.js';

const png=await sharp({create:{width:12,height:8,channels:3,background:'#123456'}}).png().toBuffer();
const jpeg=await sharp({create:{width:8,height:12,channels:3,background:'#eeddcc'}}).jpeg().toBuffer();
const promptText='生成正文：泳池露台，保留 3 < 5 与 A&B 标识。';
const referenceIds=['asset_one','asset_two','asset_one'];
const referenceBytes=[png,jpeg,png];

function fixture(protocol:'gemini'|'images',strategy:'interleaved'|'numbered_flat',references=true,ratio='1:1'){
  const model=seedModels()[protocol==='gemini'?2:3];
  model.endpoint=`https://${protocol}.test.invalid`;
  model.geometry_support=protocol==='gemini'?'ratio':'size';
  const registry=new ModuleRegistry(undefined,{...defaultPromptConfig,modules:{...defaultPromptConfig.modules,
    subject:{native_instruction:'NATIVE_SUBJECT {images}',numbered_instruction:'NUMBERED_SUBJECT {images}'},
    composition:{native_instruction:'NATIVE_COMPOSITION {images}',numbered_instruction:'NUMBERED_COMPOSITION {images}'},
  }});
  const subject=registry.create('subject'),composition=registry.create('composition'),prompt=registry.create('prompt');
  subject.asset_ids=referenceIds.slice(0,2);subject.user_instruction='用户主体约束：保持 A&B 标识。';
  composition.asset_ids=[referenceIds[2]];composition.user_instruction='用户构图约束：在画面左侧。';
  prompt.user_instruction=promptText;
  const recipe:Recipe={recipe_id:'recipe_xml_adapters',schema_version:1,input_strategy:strategy,
    modules:references?[subject,composition,prompt]:[prompt],model_config_id:model.model_config_id,
    core_parameters:{...model.defaults,aspect_ratio:ratio}};
  const plan=planExecution(recipe,[{asset_id:'asset_one',width:12,height:8},{asset_id:'asset_two',width:8,height:12}],model,registry);
  const job:Job={task_id:'task_xml_adapters',status:'queued',stage:'test',progress:0,created_at:'2026-10-27',
    recipe_snapshot:plan.recipe,chain_snapshot:plan.chain,adapted_input:plan.adapted,
    output_geometry:plan.geometry,execution_plan:plan.summary,
    model_snapshot:{model_config_id:model.model_config_id,title:model.title,provider:model.provider,
      model:model.model,adapter_id:model.adapter_id,kind:model.kind,revision:model.revision},output_asset_ids:[]};
  const reads:string[]=[],captures:ModelInput[]=[];
  const context:CloudExecutionContext={model,job,resolveCredential:async()=>'local-test-key',
    readImage:async id=>{reads.push(id);assert.ok(id==='asset_one'||id==='asset_two');return id==='asset_two'?jpeg:png;},
    recordModelInput:async input=>{captures.push(input);}};
  return {context,plan,reads,captures};
}

function assertCompiledInput(f:ReturnType<typeof fixture>,references=true){
  assert.equal(f.plan.chain.format_version,4);
  assert.ok(f.plan.chain.blocks.some(block=>block.type==='text'&&block.text===promptText));
  assert.equal(f.plan.chain.system_instruction,undefined);
  assert.equal(f.plan.adapted.system_instruction,undefined);
  const text=f.plan.adapted.kind==='native_blocks'
    ?f.plan.adapted.blocks!.filter(block=>block.type==='text').map(block=>block.text).join('')
    :f.plan.adapted.prompt!;
  if(f.plan.adapted.kind==='native_blocks'){
    const modules=f.plan.recipe.modules;
    assert.deepEqual([...text.matchAll(/^## (\d+)\. (.+)$/gm)].map(match=>[Number(match[1]),match[2]]),
      modules.map((module,index)=>[index+1,module.model_name??module.reference_type]));
    assert.ok(text.includes(promptText));
    assert.doesNotMatch(text,/<generation_request>|<reference_rules>|<image_ref\b|<generation_prompt>|&amp;|&lt;/);
    if(references){
      assert.match(text,/NATIVE_SUBJECT image_1, image_2/);assert.match(text,/NATIVE_COMPOSITION image_3/);assert.doesNotMatch(text,/NUMBERED_/);
      assert.deepEqual(f.plan.adapted.blocks!.filter(block=>block.type==='image').map(block=>block.asset_id),referenceIds);
      for(const [index,block] of f.plan.adapted.blocks!.entries())if(block.type==='image'){
        const previous=f.plan.adapted.blocks![index-1];
        assert.equal(previous.type,'text');
        assert.ok(previous.type==='text'&&previous.text.endsWith(`${block.image_name}:\n`));
      }
    }
    return text;
  }
  assert.match(text,/<generation_request>/);assert.match(text,/<\/generation_request>/);
  assert.equal(text.match(/<generation_prompt>([\s\S]*?)<\/generation_prompt>/)?.[1].trim(),
    '生成正文：泳池露台，保留 3 &lt; 5 与 A&amp;B 标识。');
  assert.doesNotMatch(text,/A&amp;amp;B/);
  if(references){
    assert.match(text,/<module type="subject"/);assert.match(text,/<reference_rules>/);assert.match(text,/<requirements>/);
    assert.match(text,/<image_mapping>[\s\S]*image_N[\s\S]*<\/image_mapping>/);
    assert.deepEqual([...text.matchAll(/<image_ref id="(image_\d+)"\s*\/>/g)].map(match=>match[1]),['image_1','image_2','image_3']);
    assert.match(text,/NUMBERED_SUBJECT/);assert.match(text,/NUMBERED_COMPOSITION/);assert.doesNotMatch(text,/NATIVE_/);
  }else assert.doesNotMatch(text,/<image_ref\b|<image_mapping>/);
  return text;
}

for(const strategy of ['interleaved','numbered_flat'] as const){
  test(`Gemini ${strategy} sends ${strategy==='interleaved'?'numbered Markdown':'XML'} with unchanged image bytes, order and capture`,async()=>{
    const f=fixture('gemini',strategy);assertCompiledInput(f);const before=structuredClone(f.context.job);
    let body='',url='',calls=0;
    const adapter=new GeminiGenerator(async(target,init)=>{
      calls++;url=String(target);body=String(init!.body);
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]});
    });
    const result=await new ExecutionRegistry().register(adapter).execute(f.context,new AbortController().signal,async()=>{});
    assert.equal(calls,1);assert.equal(result.images.length,1);assert.equal(url,'https://gemini.test.invalid/v1beta/models/gemini-3-pro-image:generateContent');
    assert.equal(f.captures.length,1);assert.deepEqual(f.captures[0].body,{encoding:'json',json:body});
    assert.equal(f.captures[0].route,new URL(url).pathname);
    const sent=JSON.parse(body),parts=sent.contents[0].parts;
    assert.equal(sent.contents.length,1);assert.equal(sent.contents[0].role,'user');
    assert.equal(Object.hasOwn(sent,'systemInstruction'),false);assert.equal(Object.hasOwn(sent,'system_instruction'),false);
    assert.deepEqual(parts.filter((part:any)=>part.inlineData).map((part:any)=>part.inlineData),
      referenceBytes.map((bytes,index)=>({mimeType:index===1?'image/jpeg':'image/png',data:bytes.toString('base64')})));
    if(strategy==='interleaved'){
      assert.deepEqual(parts.map((part:any)=>part.text??'image'),f.plan.adapted.blocks!.map(block=>block.type==='text'?block.text:'image'));
    }else{
      assert.deepEqual(parts.map((part:any)=>part.text??'image'),[f.plan.adapted.prompt,'image','image','image']);
      assert.deepEqual(f.plan.adapted.image_asset_ids,referenceIds);
    }
    assert.deepEqual(sent.generationConfig.imageConfig,{aspectRatio:'1:1',imageSize:'2K'});
    assert.deepEqual(f.reads,referenceIds);assert.deepEqual(f.context.job,before);
  });
}

test('Images text-to-image sends the standalone generation_prompt XML unchanged as JSON',async()=>{
  const f=fixture('images','numbered_flat',false);assertCompiledInput(f,false);const before=structuredClone(f.context.job);
  let body='',url='',calls=0;
  const adapter=new ImagesGenerator(async(target,init)=>{calls++;url=String(target);body=String(init!.body);return Response.json({data:[{b64_json:png.toString('base64')}]});});
  await new ExecutionRegistry().register(adapter).execute(f.context,new AbortController().signal,async()=>{});
  assert.equal(calls,1);assert.equal(url,'https://images.test.invalid/v1/images/generations');
  const sent=JSON.parse(body);assert.equal(sent.prompt,f.plan.adapted.prompt);assert.equal(sent.size,'1024x1024');
  assert.equal(Object.hasOwn(sent,'system_instruction'),false);assert.equal(Object.hasOwn(sent,'messages'),false);
  assert.equal(f.captures.length,1);assert.deepEqual(f.captures[0].body,{encoding:'json',json:body});
  assert.equal(f.captures[0].route,new URL(url).pathname);
  assert.deepEqual(f.reads,[]);assert.deepEqual(f.context.job,before);
});

test('Images reference edit keeps XML image_ref numbering aligned with multipart file order and capture',async()=>{
  const f=fixture('images','numbered_flat');assertCompiledInput(f);const before=structuredClone(f.context.job);
  let form:FormData|undefined,url='',calls=0;
  const adapter=new ImagesGenerator(async(target,init)=>{calls++;url=String(target);form=init!.body as FormData;return Response.json({data:[{b64_json:png.toString('base64')}]});});
  await new ExecutionRegistry().register(adapter).execute(f.context,new AbortController().signal,async()=>{});
  assert.equal(calls,1);assert.equal(url,'https://images.test.invalid/v1/images/edits');assert.ok(form);
  assert.equal(form.get('prompt'),f.plan.adapted.prompt);assert.equal(form.get('size'),'1024x1024');
  assert.equal(form.has('system_instruction'),false);assert.equal(form.has('messages'),false);assert.equal(form.has('mask'),false);
  const files=form.getAll('image[]') as File[];
  assert.deepEqual(files.map(file=>file.name),['reference-1.png','reference-2.jpeg','reference-3.png']);
  assert.deepEqual(files.map(file=>file.type),['image/png','image/jpeg','image/png']);
  assert.deepEqual(await Promise.all(files.map(async file=>Buffer.from(await file.arrayBuffer()))),referenceBytes);
  assert.equal(f.captures.length,1);const capture=f.captures[0];assert.equal(capture.body.encoding,'multipart');
  assert.equal(capture.route,new URL(url).pathname);
  if(capture.body.encoding!=='multipart')throw new Error('Expected multipart capture');
  assert.deepEqual(capture.body.fields.filter(field=>typeof field.value==='string'),
    [...form.entries()].filter((entry):entry is [string,string]=>typeof entry[1]==='string').map(([name,value])=>({name,value})));
  assert.deepEqual(capture.body.fields.filter(field=>typeof field.value!=='string'),referenceBytes.map((bytes,index)=>({name:'image[]',
    value:{filename:files[index].name,mime_type:files[index].type,data_base64:bytes.toString('base64')}})));
  assert.deepEqual(f.plan.adapted.image_asset_ids,referenceIds);assert.deepEqual(f.reads,referenceIds);assert.deepEqual(f.context.job,before);
});

test('Images counts XML wrapper characters against the prompt limit and rejects before reading or sending',async()=>{
  const f=fixture('images','numbered_flat');assertCompiledInput(f);const prompt=f.plan.adapted.prompt!;
  f.context.model.images_compatibility={format_field:'output_format',image_field:'image[]',send_response_format:false,max_prompt_chars:Array.from(prompt).length-1};
  let calls=0;const adapter=new ImagesGenerator(async()=>{calls++;return Response.json({});});
  await assert.rejects(()=>adapter.execute(f.context,new AbortController().signal,async()=>{}),/提示词.*不会自动截断/);
  assert.equal(calls,0);assert.deepEqual(f.reads,[]);assert.deepEqual(f.captures,[]);assert.equal(f.plan.adapted.prompt,prompt);
});

test('Gemini keeps an unsupported aspect-ratio hint once as Markdown text or inside the flat XML root',async()=>{
  for(const strategy of ['interleaved','numbered_flat'] as const){
    const f=fixture('gemini',strategy,true,'custom:137:90');let body='',calls=0;
    const adapter=new GeminiGenerator(async(_url,init)=>{
      calls++;body=String(init!.body);
      return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]});
    });
    await adapter.execute(f.context,new AbortController().signal,async()=>{});
    const sent=JSON.parse(body),text=sent.contents[0].parts.filter((part:any)=>typeof part.text==='string').map((part:any)=>part.text).join('');
    assert.equal(calls,1);assert.equal(sent.generationConfig.imageConfig.aspectRatio,undefined);
    assert.equal((text.match(/期望输出画面的宽高比/g)??[]).length,1);
    if(strategy==='numbered_flat')assert.match(text,/<requirements>期望输出画面的宽高比为 137:90。请尽量保持该比例。<\/requirements>\s*<\/generation_request>\s*$/);
    else {
      assert.match(text,/期望输出画面的宽高比为 137:90。请尽量保持该比例。\s*$/);
      assert.doesNotMatch(text,/<requirements>|<generation_request>/);
      assert.ok(text.includes(promptText));
    }
    assert.equal(f.captures.length,1);assert.deepEqual(f.captures[0].body,{encoding:'json',json:body});
  }
});
