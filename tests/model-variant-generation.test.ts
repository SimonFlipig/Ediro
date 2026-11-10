import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ImagesGenerator } from '../src/adapters/images-generator.js';
import { modelForEnrollment } from '../src/protocols/model-catalog.js';
import { snapshotParameters } from '../src/core/model-settings.js';
import { planExecution } from '../src/core/execution-plan.js';
import { ModuleRegistry } from '../src/core/modules.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import type { ModelInput } from '../src/core/model-input.js';
import type { Job,Recipe } from '../src/core/domain.js';

const png=await sharp({create:{width:16,height:16,channels:3,background:'#c7d4c3'}}).png().toBuffer();
const gemini='gemini-generate-content',images='openai-images';
const nano21='nano-banana-2.1',sunburst='gpt-image-2-5-sunburst',flare='gpt-image-2-5-flare',gpt2='gpt-image-2';
function fixture(adapterId:typeof gemini|typeof images,variant:string,reference:boolean,quality='auto',thinking?:string):CloudExecutionContext{
  // Start with the older, narrower GPT Image 2 entry. The selected variant must
  // determine quality support even when saved capabilities predate that choice.
  const model=modelForEnrollment(adapterId===gemini?'nano':'gpt-image',adapterId,'model_variant_fixture','connection_variant_fixture',adapterId===gemini?'gemini-nano-banana-2.1':'gpt-image-2');
  model.model=adapterId===gemini?'private-gemini-image-route':'private-gpt-image-route';
  model.endpoint='https://model-variant.invalid/custom';model.executable=true;model.model_variant_override=variant;
  if(adapterId===images)model.defaults.quality=quality;
  if(thinking)model.defaults.extensions![gemini].thinking_level=thinking;
  const registry=new ModuleRegistry(),subject=registry.create('subject'),prompt=registry.create('prompt');
  prompt.user_instruction='拍摄白色杯子，保持参考结构清晰。';if(reference)subject.asset_ids=['asset_variant_reference'];
  const recipe:Recipe={recipe_id:'recipe_variant_fixture',schema_version:1,model_config_id:model.model_config_id,modules:[subject,prompt],core_parameters:snapshotParameters(model.defaults,model)};
  const plan=planExecution(recipe,reference?[{asset_id:'asset_variant_reference',width:16,height:16}]:[],model,registry);
  const job:Job={task_id:'task_variant_fixture',created_at:'now',status:'running',stage:'fixture',progress:0,recipe_snapshot:plan.recipe,chain_snapshot:plan.chain,adapted_input:plan.adapted,execution_plan:plan.summary,output_geometry:plan.geometry,model_snapshot:{model_config_id:model.model_config_id,title:model.title,provider:model.provider,model:model.model,adapter_id:model.adapter_id,revision:model.revision,kind:model.kind,model_variant_override:variant},output_asset_ids:[]};
  return {model,job,readImage:async()=>png,resolveCredential:async()=>'local-variant-fixture-key'};
}
const geminiResponse=()=>Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]},finishReason:'STOP'}]});
const imagesResponse=()=>Response.json({data:[{b64_json:png.toString('base64')}]});

test('统一 Nano 型号覆盖发送原渠道 ID 与强度，JSON 捕获与实际正文一致',async()=>{
  for(const reference of [false,true])for(const [variant,level] of [[nano21,'medium'],['nano-banana-2','minimal'],['nano-banana-pro','high']]){
    const context=fixture(gemini,variant,reference,'auto',level);let captured:ModelInput|undefined,calls=0;
    // A legacy value cannot override the newly selected generic variant.
    context.model.nano_model_override=variant===nano21?'pro':'2.1';
    context.recordModelInput=async value=>{captured=value;};
    const result=await new GeminiGenerator(async(url,init)=>{
      calls++;assert.equal(String(url),'https://model-variant.invalid/custom/v1beta/models/private-gemini-image-route:generateContent');
      assert.equal(captured?.body.encoding,'json');if(captured?.body.encoding!=='json')throw Error('missing JSON capture');
      assert.equal(captured.route,'/custom/v1beta/models/private-gemini-image-route:generateContent');assert.equal(captured.body.json,init?.body);
      const body=JSON.parse(String(init?.body));assert.deepEqual(body.generationConfig.thinkingConfig,{thinkingLevel:level.toUpperCase()});
      assert.equal(body.contents[0].parts.filter((part:{inlineData?:unknown})=>part.inlineData).length,reference?1:0);
      assert.equal(body.model_variant_override,undefined);assert.equal(body.nano_model_override,undefined);assert.ok(!JSON.stringify(captured).includes('local-variant-fixture-key'));
      return geminiResponse();
    }).execute(context,new AbortController().signal,async()=>{});
    assert.equal(calls,1);assert.equal(result.images.length,1);assert.equal(context.job.model_snapshot.model_variant_override,variant);assert.equal(context.job.model_snapshot.model,context.model.model);
  }
});

test('统一 GPT 型号覆盖驱动 JSON 与 multipart 参数，原渠道 ID 和捕获字段保持一致',async()=>{
  for(const reference of [false,true])for(const [variant,quality] of [[gpt2,'high'],[sunburst,'max'],[flare,'xhigh']]){
    const context=fixture(images,variant,reference,quality);let captured:ModelInput|undefined,calls=0;
    context.recordModelInput=async value=>{captured=value;};
    const result=await new ImagesGenerator(async(url,init)=>{
      calls++;const route=`/custom/v1/images/${reference?'edits':'generations'}`;
      assert.equal(String(url),'https://model-variant.invalid'+route);assert.equal(captured?.route,route);
      if(reference){
        assert.ok(init?.body instanceof FormData);const body=init.body;
        assert.equal(body.get('model'),'private-gpt-image-route');assert.equal(body.get('quality'),quality);assert.equal(body.get('output_format'),'png');assert.equal(body.get('n'),'1');
        assert.equal(body.get('model_variant_override'),null);assert.equal(body.get('nano_model_override'),null);
        const files=body.getAll('image[]');assert.equal(files.length,1);assert.ok(files[0] instanceof File);assert.deepEqual(Buffer.from(await files[0].arrayBuffer()),png);
        assert.equal(captured?.body.encoding,'multipart');if(captured?.body.encoding!=='multipart')throw Error('missing multipart capture');
        assert.deepEqual(captured.body.fields.filter(field=>typeof field.value==='string'),Array.from(body.entries()).filter(([,value])=>typeof value==='string').map(([name,value])=>({name,value})));
        const file=captured.body.fields.find(field=>field.name==='image[]');assert.ok(file&&typeof file.value!=='string');assert.equal(file.value.data_base64,png.toString('base64'));
      }else{
        assert.equal(captured?.body.encoding,'json');if(captured?.body.encoding!=='json')throw Error('missing JSON capture');
        assert.equal(captured.body.json,init?.body);const body=JSON.parse(String(init?.body));
        assert.equal(body.model,'private-gpt-image-route');assert.equal(body.quality,quality);assert.equal(body.output_format,'png');assert.equal(body.n,1);
        assert.equal(body.model_variant_override,undefined);assert.equal(body.nano_model_override,undefined);
      }
      assert.ok(!JSON.stringify(captured).includes('local-variant-fixture-key'));return imagesResponse();
    }).execute(context,new AbortController().signal,async()=>{});
    assert.equal(calls,1);assert.equal(result.images.length,1);assert.equal(context.job.recipe_snapshot.core_parameters.quality,quality);
    assert.equal(context.job.model_snapshot.model_variant_override,variant);assert.equal(context.job.model_snapshot.model,'private-gpt-image-route');
  }
});

test('选择 GPT Image 2 后不能通过旧 Sunburst 能力发送 max，拒绝发生在鉴权与发送之前',async()=>{
  let calls=0,credentials=0,captures=0;
  for(const reference of [false,true]){
    const context=fixture(images,gpt2,reference,'high');
    context.model.capabilities.qualities=['auto','low','medium','high','xhigh','max'];
    context.job.recipe_snapshot.core_parameters.quality='max';
    context.resolveCredential=async()=>{credentials++;return 'local-variant-fixture-key';};context.recordModelInput=async()=>{captures++;};
    await assert.rejects(()=>new ImagesGenerator(async()=>{calls++;return imagesResponse();}).execute(context,new AbortController().signal,async()=>{}),/质量|档位|quality/);
  }
  assert.equal(calls,0);assert.equal(credentials,0);assert.equal(captures,0);
});
