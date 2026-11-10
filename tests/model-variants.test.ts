import test from 'node:test';
import assert from 'node:assert/strict';
import {modelConfigSchema,type ModelConfig,type Parameters,type Recipe} from '../src/core/domain.js';
import {contractFor,effectiveCapabilitiesFor,parameterFields,validateGenerationParameters} from '../src/core/generation-parameters.js';
import {librarySchema,type AdapterDescription,type LibraryData} from '../src/core/model-library.js';
import {ModelLibrary} from '../src/core/models.js';
import {snapshotParameters,selectWorkflowModel} from '../src/core/model-settings.js';
import {modelForEnrollment,modelIdentity} from '../src/protocols/model-catalog.js';
import {modelVariantInfo,modelVariantOptions,modelVariants} from '../src/protocols/model-variants.js';
import {nanoModelInfo} from '../src/protocols/nano-models.js';
import {imagesProfile,geminiProfile} from '../src/protocols/generation-profiles.js';

const nano=(id='gemini-nano-banana-2.1')=>modelForEnrollment('nano','gemini-generate-content','model_variant_test','connection_variant_test',id);
const image=(id='gpt-image-2')=>modelForEnrollment('gpt-image','openai-images','model_variant_test','connection_variant_test',id);
const options=(model:ModelConfig,key:string)=>parameterFields(model).find(field=>field.key===key);
const extension=(model:ModelConfig,key:string,value:string|number):Parameters=>({...model.defaults,extensions:{...model.defaults.extensions,[model.adapter_id]:{...model.defaults.extensions?.[model.adapter_id],[key]:value}}});
function adapter(model:ModelConfig,qualities?:string[]):AdapterDescription {
  return {adapter_id:model.adapter_id,title:'Fixture',version:1,kind:'cloud',installed:true,purposes:['generation'],requires_credential:false,supports_probe:false,interleaving:['native','separated'],operations:['generate','referenceEdit','nativeMaskEdit','guidedMaskEdit'],parameters:qualities?[{key:'quality',title:'Quality',values:qualities}]:[],generation_contract:model.adapter_id==='openai-images'?imagesProfile:geminiProfile};
}
function library(model:ModelConfig,persist:(data:LibraryData)=>Promise<void>=async()=>{},description=adapter(model)){
  const {endpoint,executable,...entry}=model;
  const data=librarySchema.parse({schema_version:3,connections:[{connection_id:model.connection_id,title:'Fixture',endpoint:'https://fixture.invalid',revision:1,enabled:true}],models:[{...entry,origin:'user'}],assignments:{}});
  return new ModelLibrary(data,persist,{has:async()=>false,set:async()=>{}},[description]);
}

test('the registry recognizes bounded Nano and GPT Image names without changing identities',()=>{
  const cases:[ModelConfig,string][]=[
    [nano('gemini-3-pro-image-preview-2026-10-22-4k'),'nano-banana-pro'],
    [nano('nano-banana-pro-preview'),'nano-banana-pro'],
    [nano('gemini-3.1-flash-image-2k'),'nano-banana-2'],
    [nano('models/GEMINI-NANO-BANANA-2.1'),'nano-banana-2.1'],
    [image('gpt-image-2.5-sunburst-2026-09-08'),'gpt-image-2-5-sunburst'],
    [image('gpt-image-2.5-flare'),'gpt-image-2-5-flare'],
    [image('gpt-image-2-2026-04-21'),'gpt-image-2'],
  ];
  for(const [model,id] of cases){
    const before=structuredClone(model),info=modelVariantInfo(model);
    assert.equal(info.variant?.id,id);assert.equal(info.source,'automatic');
    assert.deepEqual(model,before);assert.equal(modelIdentity(model),model.model_config_id);
  }
  assert.equal(modelVariantOptions(nano()).length,3);
  assert.equal(modelVariantOptions(image()).length,3);
});

test('unknown and misleading names do not acquire a specific variant',()=>{
  for(const id of ['gemini-nano-banana-2.10','gemini-3.1-flash-lite-image','gemini-3-pro','gemini-3-pro-image-fast','gemini-nano-banana-2.1-2026-13-10'])assert.equal(modelVariantInfo({...nano(),model:id}).variant,undefined,id);
  for(const id of ['gpt-image-20','gpt-image-2.50-sunburst','gpt-image-2.5-sunburst-fast','gpt-image-2.5-flare-preview','custom-images'])assert.equal(modelVariantInfo({...image(),model:id}).variant,undefined,id);
  const unknown=image('custom-images'),before=structuredClone(unknown.capabilities);
  assert.equal(modelVariantInfo(unknown).source,'unknown');
  assert.deepEqual(effectiveCapabilitiesFor(unknown),before);
  assert.equal(options(nano('custom-nano'),'thinking_level'),undefined);
});

test('generic manual selection wins over legacy selection and can be restored to automatic',()=>{
  const model={...nano(),nano_model_override:'2' as const};
  assert.equal(modelVariantInfo(model).variant?.id,'nano-banana-2');
  const generic={...model,model_variant_override:'nano-banana-pro'};
  assert.equal(modelVariantInfo(generic).variant?.id,'nano-banana-pro');
  assert.equal(modelVariantInfo(generic).source,'manual');
  assert.equal(nanoModelInfo(generic).variant,'pro');
  assert.equal(modelVariantInfo({...generic,model_variant_override:undefined,nano_model_override:undefined}).variant?.id,'nano-banana-2.1');
  assert.equal(modelConfigSchema.parse(generic).model_variant_override,'nano-banana-pro');
  assert.equal(modelConfigSchema.parse(generic).nano_model_override,'2');
  assert.throws(()=>modelConfigSchema.parse({...generic,model_variant_override:''}));
});

test('unknown and cross-family overrides explicitly fail validation and atomic save',async()=>{
  const models=library(nano()),before=models.snapshot(),entry=before.models.find(m=>m.model_config_id==='model_variant_test')!;
  for(const override of ['not-a-variant','gpt-image-2']){
    const model={...nano(),model_variant_override:override};
    assert.match(modelVariantInfo(model).invalidOverride!,/型号覆盖/);
    assert.throws(()=>validateGenerationParameters(model.defaults,model),/型号覆盖/);
    await assert.rejects(models.saveModel({...entry,model_variant_override:override}),/型号覆盖/);
  }
  assert.deepEqual(models.snapshot(),before);
  assert.ok(modelVariantInfo({...nano(),purpose:'understanding',model_variant_override:'nano-banana-pro'}).invalidOverride);
  assert.ok(modelVariantInfo({...nano(),adapter_id:'openai-chat-completions',model_variant_override:'nano-banana-pro'}).invalidOverride);
});

test('old contracts receive common and selected-variant fields without changing saved defaults',()=>{
  const model=nano(),before=structuredClone(model.defaults);
  model.generation_contract!.fields=[{key:'channel_option',title:'Channel option',kind:'boolean'},{key:'thinking_level',title:'Stale',kind:'select',values:['low'],default:'low'}];
  const fields=parameterFields(model);
  assert.ok(fields.some(f=>f.key==='reference_precision'));
  assert.ok(fields.some(f=>f.key==='channel_option'));
  const field=options(model,'thinking_level')!;
  assert.deepEqual(field.values,['minimal','medium','high']);assert.equal(field.default,undefined);
  assert.deepEqual(field.display_scopes,['model-defaults']);assert.equal(field.default_placement,'primary');
  assert.equal(options({...model,model_variant_override:'nano-banana-pro'},'thinking_level')!.fixed,true);
  assert.equal(options({...model,model:'unknown-alias'},'thinking_level'),undefined);
  assert.equal(snapshotParameters(model.defaults,model).extensions?.[model.adapter_id]?.thinking_level,undefined);
  assert.deepEqual(model.defaults,before);
});

test('channel field restrictions are applied after the selected variant declaration',()=>{
  const model=nano();model.capabilities.parameter_limits={thinking_level:{values:['medium','high']}};
  assert.deepEqual(options(model,'thinking_level')!.values,['medium','high']);
  assert.throws(()=>validateGenerationParameters(extension(model,'thinking_level','minimal'),model),/推理强度/);
  model.capabilities.parameter_limits.thinking_level={enabled:false};
  assert.equal(options(model,'thinking_level'),undefined);
  assert.throws(()=>validateGenerationParameters(extension(model,'thinking_level','high'),model),/未声明参数能力/);
});

test('known complete quality templates follow the selected variant while custom subsets stay limited',()=>{
  const old=image(),selected={...old,model_variant_override:'gpt-image-2-5-sunburst'};
  assert.deepEqual(effectiveCapabilitiesFor(selected).qualities,['auto','low','medium','high','xhigh','max']);
  assert.equal(old.model,'gpt-image-2');assert.equal(selected.preset_id,'gpt-image-2');
  assert.doesNotThrow(()=>validateGenerationParameters({...selected.defaults,quality:'max'},selected));
  const restricted={...selected,capabilities:{...selected.capabilities,qualities:['high']}};
  assert.deepEqual(effectiveCapabilitiesFor(restricted).qualities,['high']);
  assert.throws(()=>validateGenerationParameters({...selected.defaults,quality:'max'},restricted),/质量/);
  const narrowed={...image('gpt-image-2.5-sunburst'),model_variant_override:'gpt-image-2'};
  assert.deepEqual(effectiveCapabilitiesFor(narrowed).qualities,['auto','low','medium','high']);
  assert.throws(()=>validateGenerationParameters({...narrowed.defaults,quality:'max'},narrowed),/质量/);
});

test('adapter and explicit channel quality limits survive repeated effective resolution',async()=>{
  const model={...image(),model_variant_override:'gpt-image-2-5-sunburst'},qualities=['auto','low','medium','high'];
  const withAdapter={...model,adapter_parameters:[{key:'quality',title:'Quality',values:qualities}]};
  const once=effectiveCapabilitiesFor(withAdapter),twice=effectiveCapabilitiesFor({...withAdapter,capabilities:once});
  assert.deepEqual(once.qualities,qualities);assert.deepEqual(twice,once);
  const models=library(model,async()=>{},adapter(model,qualities)),resolved=models.resolve(model.model_config_id);
  assert.deepEqual(effectiveCapabilitiesFor(resolved).qualities,qualities);
  assert.throws(()=>validateGenerationParameters({...model.defaults,quality:'max'},resolved),/质量/);
  const restricted={...model,capabilities:{...model.capabilities,parameter_limits:{quality:{values:['high']}}}};
  assert.deepEqual(effectiveCapabilitiesFor(restricted).qualities,['high']);
  const disabled=library({...model,enabled:false},async()=>{},adapter(model,qualities));
  const publicDisabled=(await disabled.list()).find(m=>m.model_config_id===model.model_config_id)!;
  assert.deepEqual(effectiveCapabilitiesFor(publicDisabled).qualities,qualities);
  const entry=models.snapshot().models.find(m=>m.model_config_id===model.model_config_id)!;
  await assert.rejects(models.saveModel({...entry,defaults:{...entry.defaults,quality:'max'}}),/质量/);
});

test('saving and reopening preserves generic overrides and independent defaults without persisting runtime limits',async()=>{
  const model={...image(),model_variant_override:'gpt-image-2-5-sunburst'};
  model.defaults={...model.defaults,quality:'max'};
  let persisted:LibraryData|undefined;
  const models=library(model,async data=>{persisted=JSON.parse(JSON.stringify(data));});
  const entry=models.snapshot().models.find(m=>m.model_config_id===model.model_config_id)!;
  await models.saveModel(entry);
  const saved=persisted!.models.find(m=>m.model_config_id===model.model_config_id)!;
  assert.equal(saved.model_variant_override,'gpt-image-2-5-sunburst');assert.equal(saved.model,'gpt-image-2');
  assert.equal(saved.independent_defaults,true);assert.equal(saved.defaults.quality,'max');
  assert.equal('adapter_parameters' in saved,false);
  const reopened=new ModelLibrary(persisted!,async()=>{},{has:async()=>false,set:async()=>{}},[adapter(model)]);
  assert.ok(reopened.resolve(saved.model_config_id).capabilities.qualities.includes('max'));
  assert.equal((await reopened.list()).find(m=>m.model_config_id===saved.model_config_id)!.model_variant_override,saved.model_variant_override);
});

test('Nano variant changes preserve declared channel limits without expanding effective options',async()=>{
  const model=nano();model.capabilities.parameter_limits={thinking_level:{values:['medium','high']}};
  const models=library(model),entry=models.snapshot().models.find(m=>m.model_config_id===model.model_config_id)!;
  await models.saveModel({...entry,model_variant_override:'nano-banana-pro'});
  const resolved=models.resolve(model.model_config_id),saved=models.snapshot().models.find(m=>m.model_config_id===model.model_config_id)!;
  assert.deepEqual(saved.capabilities.parameter_limits,model.capabilities.parameter_limits);
  assert.deepEqual(options(resolved,'thinking_level')!.values,['high']);
  assert.doesNotThrow(()=>validateGenerationParameters(extension(resolved,'thinking_level','high'),resolved));
  assert.throws(()=>validateGenerationParameters(extension(resolved,'thinking_level','medium'),resolved),/推理强度/);
  assert.throws(()=>validateGenerationParameters(extension(resolved,'thinking_level','minimal'),resolved),/推理强度/);
  const before=models.snapshot();
  await assert.rejects(models.saveModel({...saved,capabilities:{...saved.capabilities,parameter_limits:{thinking_level:{values:['low','high']}}}}),/允许值超出/);
  await assert.rejects(models.saveModel({...saved,capabilities:{...saved.capabilities,parameter_limits:{unregistered_option:{values:['high']}}}}),/未声明此参数/);
  assert.deepEqual(models.snapshot(),before);
});

test('restoring unknown automatic identity keeps valid channel limits dormant',async()=>{
  const model={...nano('relay-private-alias'),model_variant_override:'nano-banana-2.1'};
  model.capabilities.parameter_limits={thinking_level:{values:['medium','high']}};
  const models=library(model),entry=models.snapshot().models.find(m=>m.model_config_id===model.model_config_id)!;
  await models.saveModel({...entry,model_variant_override:undefined,nano_model_override:undefined});
  const resolved=models.resolve(model.model_config_id);
  assert.equal(modelVariantInfo(resolved).source,'unknown');
  assert.equal(options(resolved,'thinking_level'),undefined);
  assert.deepEqual(resolved.capabilities.parameter_limits,model.capabilities.parameter_limits);
  assert.doesNotThrow(()=>validateGenerationParameters(resolved.defaults,resolved));
  assert.throws(()=>validateGenerationParameters(extension(resolved,'thinking_level','high'),resolved),/未声明参数能力/);
});

test('GPT Image variant changes retain older quality limits and still intersect the selected model and adapter',async()=>{
  const model=image('gpt-image-2.5-sunburst');
  model.capabilities.parameter_limits={quality:{values:['auto','low','medium','high','max']}};
  const allowed=['auto','low','medium','high'],models=library(model,async()=>{},adapter(model,allowed));
  const entry=models.snapshot().models.find(m=>m.model_config_id===model.model_config_id)!;
  await models.saveModel({...entry,model_variant_override:'gpt-image-2'});
  const resolved=models.resolve(model.model_config_id),saved=models.snapshot().models.find(m=>m.model_config_id===model.model_config_id)!;
  assert.deepEqual(saved.capabilities.parameter_limits,model.capabilities.parameter_limits);
  assert.deepEqual(effectiveCapabilitiesFor(resolved).qualities,allowed);
  assert.doesNotThrow(()=>validateGenerationParameters(resolved.defaults,resolved));
  assert.throws(()=>validateGenerationParameters({...resolved.defaults,quality:'max'},resolved),/质量/);
  const before=models.snapshot();
  await assert.rejects(models.saveModel({...saved,capabilities:{...saved.capabilities,parameter_limits:{quality:{values:['auto','ultra']}}}}),/允许值超出/);
  await assert.rejects(models.saveModel({...saved,capabilities:{...saved.capabilities,parameter_limits:{thinking_level:{values:['high']}}}}),/未声明此参数/);
  assert.deepEqual(models.snapshot(),before);
});

test('adding a variant declaration supplies fields and contract differences without core branches',()=>{
  const definition={id:'fixture-variant',title:'Fixture',model_id:'fixture-variant-model',family:'gpt-image' as const,adapter_id:'openai-images',aliases:['fixture-variant-model'],suffix:'date' as const,qualities:['auto','low','medium','high'],contract:{max_images:3,fields:[{key:'fixture_option',title:'Fixture option',kind:'number' as const,minimum:1,maximum:3}]}};
  modelVariants.push(definition);
  try{
    const model=image('fixture-variant-model');
    assert.equal(modelVariantInfo(model).variant?.id,definition.id);
    assert.equal(contractFor(model).max_images,3);assert.equal(effectiveCapabilitiesFor(model).max_images,3);
    assert.ok(options(model,'background'));assert.ok(options(model,'fixture_option'));
    assert.doesNotThrow(()=>validateGenerationParameters(extension(model,'fixture_option',2),model));
    assert.throws(()=>validateGenerationParameters(extension(model,'fixture_option',4),model),/超出数值范围/);
  }finally{modelVariants.pop();}
});

test('model default updates leave existing remembered workflow parameters unchanged',()=>{
  const model=image(),old=structuredClone(model.defaults);
  model.model_variant_override='gpt-image-2-5-sunburst';model.defaults={...model.defaults,quality:'max'};
  const recipe:Recipe={recipe_id:'recipe_variants',schema_version:1,modules:[],model_config_id:'model_other',core_parameters:old,model_parameters:{[model.model_config_id]:old}};
  const before=structuredClone(recipe);
  assert.equal(selectWorkflowModel(recipe,model).core_parameters.quality,'auto');
  assert.equal(selectWorkflowModel({...recipe,model_parameters:{}},model).core_parameters.quality,'max');
  assert.deepEqual(recipe,before);
});
