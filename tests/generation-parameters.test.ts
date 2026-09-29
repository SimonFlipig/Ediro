import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { seedModels } from '../src/core/models.js';
import { parametersSchema,type Job,type Recipe } from '../src/core/domain.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { resolveOutputGeometry } from '../src/core/output-geometry.js';
import { validateGenerationParameters } from '../src/core/generation-parameters.js';
import { ImagesGenerator } from '../src/adapters/images-generator.js';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import type { CloudExecutionContext } from '../src/core/ports.js';

const png=await sharp({create:{width:16,height:16,channels:4,background:'#fff'}}).png().toBuffer();
function fixture(index:number):CloudExecutionContext{
  const model=seedModels()[index],registry=new ModuleRegistry(),module=registry.create('subject');module.asset_ids=['asset_ref'];
  const recipe:Recipe={recipe_id:'recipe_options',schema_version:1,model_config_id:model.model_config_id,modules:[module,registry.create('prompt')],core_parameters:{...model.defaults,aspect_ratio:'auto'}};
  const job={recipe_snapshot:recipe,adapted_input:index===3?{kind:'separated_inputs',prompt:'test',image_asset_ids:['asset_ref'],adjustments:[]}:{kind:'native_blocks',blocks:[{type:'image',asset_id:'asset_ref',source_module_id:module.module_id,reference_type:'subject',reference_id:module.reference_id}],adjustments:[]}} as unknown as Job;
  return {model,job,readImage:async()=>png,resolveCredential:async()=>'test-key'};
}
test('旧参数无须迁移；新增精度和输出参数可完整往返，不静默移除',()=>{
  const p={...seedModels()[2].defaults,image_size:'4K',gemini_options:{reference_precision:'high',reference_overrides:{asset_ref:'ultra_high'},google_search:true,response_mode:'image'}};
  assert.deepEqual(parametersSchema.parse(p),p);assert.deepEqual(parametersSchema.parse(seedModels()[2].defaults),seedModels()[2].defaults);
});
test('自动参考图比例可独立选择分辨率；自定义宽高为最终尺寸，非法尺寸阻止执行',()=>{
  const c=fixture(3);c.model.geometry_support='size';const recipe=c.job.recipe_snapshot;
  recipe.core_parameters.output_resolution='4MP';let g=resolveOutputGeometry(recipe,[{asset_id:'asset_ref',width:3000,height:3000}],c.model);assert.equal(g.request_size,'2048x2048');assert.equal(recipe.core_parameters.aspect_ratio,'auto');
  recipe.core_parameters.output_resolution='8MP';assert.equal(resolveOutputGeometry(recipe,[{asset_id:'asset_ref',width:3000,height:3000}],c.model).request_size,'2880x2880');
  recipe.core_parameters.output_resolution='custom';recipe.core_parameters.output_width=3840;recipe.core_parameters.output_height=2160;g=resolveOutputGeometry(recipe,[],c.model);assert.equal(g.request_size,'3840x2160');assert.equal(g.ratio,'16:9');
  recipe.core_parameters.output_width=4096;assert.throws(()=>resolveOutputGeometry(recipe,[],c.model),/自定义尺寸/);
});
test('Images 文生图与参考编辑发送背景、压缩和审核参数；尺寸完整记录',async()=>{
  for(const edit of [false,true]){
    const c=fixture(3);if(!edit)c.job.adapted_input.image_asset_ids=[];
    c.job.recipe_snapshot.core_parameters.output_format='webp';c.job.recipe_snapshot.core_parameters.images_options={background:'transparent',output_compression:80,moderation:'low'};
    c.job.output_geometry={selection:'custom',basis:'user',target:'size',request_size:'2048x2048',adjustments:[]};let captured=false;c.recordModelInput=async input=>{captured=true;assert.ok(JSON.stringify(input).includes('2048x2048'));};
    const adapter=new ImagesGenerator(async(_url,init)=>{assert.equal(captured,true);const body=init!.body,fields:Record<string,unknown>=typeof body==='string'?JSON.parse(body):{};if(typeof body!=='string')(body as FormData).forEach((value,key)=>{fields[key]=value;});for(const [key,value] of Object.entries({background:'transparent',output_compression:80,moderation:'low',size:'2048x2048'}))assert.equal(String(fields[key]),String(value));return Response.json({data:[{b64_json:png.toString('base64')}]});});
    await adapter.execute(c,new AbortController().signal,async()=>{});
  }
});
test('Google 全局精度与逐图精度独立发送，保持重复图片顺序与输出档位',async()=>{
  const c=fixture(2),p=c.job.recipe_snapshot.core_parameters;p.image_size='4K';p.gemini_options={reference_precision:'medium',reference_overrides:{asset_ref:'ultra_high'},google_search:true,response_mode:'image'};
  c.job.adapted_input.blocks!.push(structuredClone(c.job.adapted_input.blocks![0]));
  const adapter=new GeminiGenerator(async(_url,init)=>{const body=JSON.parse(init!.body as string);assert.equal(body.generationConfig.mediaResolution,'MEDIA_RESOLUTION_MEDIUM');assert.equal(body.generationConfig.imageConfig.imageSize,'4K');assert.deepEqual(body.generationConfig.responseModalities,['IMAGE']);assert.deepEqual(body.tools,[{googleSearch:{}}]);assert.equal(body.contents[0].parts.length,2);for(const part of body.contents[0].parts)assert.equal(part.mediaResolution.level,'MEDIA_RESOLUTION_ULTRA_HIGH');return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]});});
  await adapter.execute(c,new AbortController().signal,async()=>{});
});
test('不支持的参数和格式组合在发送前明确拒绝',()=>{
  const images=seedModels()[3],google=seedModels()[2];
  assert.throws(()=>validateGenerationParameters({...images.defaults,output_format:'jpeg',images_options:{background:'transparent'}},images),/透明背景/);
  assert.throws(()=>validateGenerationParameters({...images.defaults,images_options:{output_compression:80}},images),/压缩率/);
  assert.throws(()=>validateGenerationParameters({...images.defaults,quality:'max'},images),/质量/);
  assert.throws(()=>validateGenerationParameters({...google.defaults,output_resolution:'4MP'},google),/分辨率/);
  assert.throws(()=>validateGenerationParameters({...images.defaults,gemini_options:{reference_precision:'high'}},images),/Google/);
});
