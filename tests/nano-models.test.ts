import test from 'node:test';
import assert from 'node:assert/strict';
import {modelConfigSchema,type ModelConfig,type Recipe} from '../src/core/domain.js';
import {contractFor,parameterFields,validateGenerationParameters} from '../src/core/generation-parameters.js';
import {librarySchema,type AdapterDescription,type LibraryData} from '../src/core/model-library.js';
import {ModelLibrary} from '../src/core/models.js';
import {selectWorkflowModel,snapshotParameters} from '../src/core/model-settings.js';
import {modelForEnrollment,modelFromPreset,modelIdentity} from '../src/protocols/model-catalog.js';
import {nanoModelInfo,type NanoModelVariant} from '../src/protocols/nano-models.js';
import {geminiProfile} from '../src/protocols/generation-profiles.js';

function nano(id='gemini-nano-banana-2.1'):ModelConfig {
  return modelForEnrollment('nano','gemini-generate-content','model_nano_test','connection_nano_test',id);
}
const thinking=(model:ModelConfig)=>parameterFields(model).find(f=>f.key==='thinking_level');
function withLevel(model:ModelConfig,level:string){
  const parameters=structuredClone(model.defaults);
  parameters.extensions={...parameters.extensions,[model.adapter_id]:{...parameters.extensions?.[model.adapter_id],thinking_level:level}};
  return parameters;
}
const description:AdapterDescription={adapter_id:'gemini-generate-content',version:1,title:'Fixture',kind:'cloud',installed:true,purposes:['generation'],requires_credential:false,supports_probe:false,interleaving:['native'],operations:['generate','referenceEdit','guidedMaskEdit'],parameters:[],generation_contract:geminiProfile};
function library(model:ModelConfig,persist:(data:LibraryData)=>Promise<void>=async()=>{}){
  const {endpoint,executable,revision,...entry}=model;
  const data=librarySchema.parse({schema_version:3,connections:[{connection_id:model.connection_id,title:'Fixture',endpoint:'https://fixture.invalid',enabled:true,revision:1}],models:[{...entry,revision:1,origin:'user'}],assignments:{}});
  return new ModelLibrary(data,persist,{has:async()=>false,set:async()=>{}},[description]);
}

test('known Nano IDs and bounded suffixes identify the exact variant without changing identity',()=>{
  const cases:[string,NanoModelVariant][]=[
    ['gemini-nano-banana-2.1','2.1'],
    ['models/GEMINI-NANO-BANANA-2.1-preview-2026-10-22-2K','2.1'],
    ['gemini-3.1-flash-image','2'],
    ['gemini-3.1-flash-image-preview','2'],
    ['gemini-3.1-flash-image-2026-10-22-1k','2'],
    ['gemini-3-pro-image','pro'],
    ['gemini-3-pro-image-preview-4k','pro'],
    ['nano-banana-pro-preview','pro'],
  ];
  for(const [id,variant] of cases){
    const model=nano(id),before=structuredClone(model);
    assert.equal(nanoModelInfo(model).variant,variant,id);
    assert.equal(nanoModelInfo(model).source,'automatic',id);
    assert.deepEqual(model,before);
    assert.equal(model.model,id);
    assert.equal(modelIdentity(model),model.model_config_id);
  }
});

test('ambiguous versions, ordinary reasoning models and unconfirmed suffixes stay unknown',()=>{
  for(const id of ['gemini-nano-banana-2.10','gemini-nano-banana-2.1-fast','gemini-nano-banana-2.1preview','gemini-nano-banana-2.1-2026-13-10','gemini-3.1-flash-lite-image','gemini-3.1-flash-image-fast','gemini-3.1-flash-image-8k','gemini-3.1-flash-image-preview-next','gemini-3.1-pro','gemini-3-pro','prefix-gemini-3-pro-image','gemini-3-pro-image-new','relay-alias']){
    assert.deepEqual(nanoModelInfo({...nano(),model:id}),{source:'unknown',title:'未识别型号',thinkingLevels:[]},id);
  }
});

test('manual correction is scoped to Gemini image generation and never rewrites the remote ID',()=>{
  const model={...nano('relay-custom'),nano_model_override:'2.1' as const};
  assert.deepEqual(nanoModelInfo(model),{variant:'2.1',source:'manual',title:'Nano Banana 2.1',thinkingLevels:['minimal','medium','high']});
  assert.equal(model.model,'relay-custom');
  assert.equal(model.preset_id,undefined);
  for(const patch of [{purpose:'understanding' as const},{adapter_id:'openai-images'},{family:'reasoning' as const},{family:'gpt-image' as const}])assert.equal(nanoModelInfo({...model,...patch}).source,'unknown');
  assert.equal(nanoModelInfo({...model,nano_model_override:undefined}).source,'unknown');
  assert.equal(nanoModelInfo({...nano(),nano_model_override:'pro'}).variant,'pro');
});

test('the optional override schema preserves valid values and rejects unknown variants',()=>{
  const model=nano();
  for(const variant of ['pro','2','2.1'] as const)assert.equal(modelConfigSchema.parse({...model,nano_model_override:variant}).nano_model_override,variant);
  assert.equal(modelConfigSchema.parse(model).nano_model_override,undefined);
  assert.throws(()=>modelConfigSchema.parse({...model,nano_model_override:'2.10'}));
});

test('old persisted contracts gain only the exact optional thinking field',()=>{
  for(const [id,levels] of [['gemini-3-pro-image',['high']],['gemini-3.1-flash-image',['minimal','high']],['gemini-nano-banana-2.1',['minimal','medium','high']]] as const){
    const model=nano(id),before=structuredClone(model);
    assert.equal(model.generation_contract!.fields.some(f=>f.key==='thinking_level'),false);
    const contract=contractFor(model),field=thinking(model)!;
    assert.equal(field.title,'推理强度');
    assert.deepEqual(field.values,[...levels]);
    assert.equal(field.default,undefined);
    assert.deepEqual(contract.fields.filter(f=>f.key!=='thinking_level'),before.generation_contract!.fields);
    assert.deepEqual(model,before);
    for(const level of levels)assert.doesNotThrow(()=>validateGenerationParameters(withLevel(model,level),model));
    assert.throws(()=>validateGenerationParameters(withLevel(model,'low'),model),/推理强度/);
  }
});

test('the managed field replaces stale defaults and rejects thinking for unknown Nano IDs',()=>{
  const model=nano();
  model.generation_contract!.fields.push({key:'thinking_level',title:'Old',kind:'select',values:['low','high'],default:'high'});
  assert.deepEqual(thinking(model)!.values,['minimal','medium','high']);
  assert.equal(thinking(model)!.default,undefined);
  assert.equal(contractFor(model).fields.filter(f=>f.key==='thinking_level').length,1);
  const unknown={...model,model:'relay-unidentified'};
  assert.equal(thinking(unknown),undefined);
  assert.throws(()=>validateGenerationParameters(withLevel(unknown,'high'),unknown),/未声明参数能力/);
});

test('channel restrictions still narrow or disable the dynamic field',()=>{
  const model=nano();
  model.capabilities.parameter_limits={thinking_level:{values:['medium','high']},reference_precision:{values:['default','high']}};
  assert.deepEqual(thinking(model)!.values,['medium','high']);
  assert.deepEqual(parameterFields(model).find(f=>f.key==='reference_precision')!.values,['default','high']);
  assert.throws(()=>validateGenerationParameters(withLevel(model,'minimal'),model),/推理强度/);
  assert.doesNotThrow(()=>validateGenerationParameters(withLevel(model,'medium'),model));
  model.capabilities.parameter_limits.thinking_level={enabled:false};
  assert.equal(thinking(model),undefined);
  assert.throws(()=>validateGenerationParameters(withLevel(model,'high'),model),/未声明参数能力/);
});

test('understanding-model thinking controls are unchanged',()=>{
  const model=modelFromPreset('gemini-3-1-pro','model_reasoning','connection_reasoning','gemini-3.1-pro-preview');
  assert.deepEqual(thinking(model)!.values,['low','medium','high']);
  assert.equal(thinking(model)!.default,'high');
  assert.equal(nanoModelInfo({...model,nano_model_override:'2.1'}).source,'unknown');
});

test('an omitted intensity stays omitted in defaults and snapshots',()=>{
  const model=nano(),before=structuredClone(model.defaults);
  assert.equal(snapshotParameters(model.defaults,model).extensions?.[model.adapter_id]?.thinking_level,undefined);
  assert.equal(snapshotParameters(withLevel(model,'medium'),model).extensions?.[model.adapter_id]?.thinking_level,'medium');
  assert.deepEqual(model.defaults,before);
});

test('saving and reopening an old contract preserves override, per-model defaults and public metadata',async()=>{
  const model={...nano('relay-unidentified'),nano_model_override:'2.1' as const};
  model.defaults=withLevel(model,'medium');
  model.capabilities.parameter_limits={thinking_level:{values:['medium','high']}};
  let persisted:LibraryData|undefined;
  const models=library(model,async data=>{persisted=JSON.parse(JSON.stringify(data));});
  const entry=models.snapshot().models.find(m=>m.model_config_id===model.model_config_id)!;
  await models.saveModel(entry);
  assert.equal(persisted!.models.find(m=>m.model_config_id===model.model_config_id)!.nano_model_override,'2.1');
  const reopened=new ModelLibrary(persisted!,async()=>{},{has:async()=>false,set:async()=>{}},[description]);
  const resolved=reopened.resolve(model.model_config_id);
  assert.equal(resolved.model,'relay-unidentified');
  assert.equal(resolved.preset_id,undefined);
  assert.equal(resolved.independent_defaults,true);
  assert.equal(resolved.defaults.extensions?.[model.adapter_id]?.thinking_level,'medium');
  assert.deepEqual(thinking(resolved)!.values,['medium','high']);
  assert.equal((await reopened.list()).find(m=>m.model_config_id===model.model_config_id)!.nano_model_override,'2.1');
});

test('saving invalid per-model intensity or restrictions is atomic and never falls back',async()=>{
  const models=library(nano()),before=models.snapshot(),entry=before.models.find(m=>m.model_config_id==='model_nano_test')!;
  await assert.rejects(models.saveModel({...entry,nano_model_override:'pro',defaults:withLevel(nano(),'medium')}),/推理强度/);
  await assert.rejects(models.saveModel({...entry,nano_model_override:'pro',capabilities:{...entry.capabilities,parameter_limits:{thinking_level:{values:['low','high']}}}}),/允许值超出/);
  assert.deepEqual(models.snapshot(),before);
  await models.saveModel({...entry,capabilities:{...entry.capabilities,parameter_limits:{thinking_level:{enabled:false}}}});
  assert.equal(thinking(models.resolve(entry.model_config_id)),undefined);
});

test('new defaults do not replace a workflow own remembered parameters',()=>{
  const model=nano();
  const oldParameters=structuredClone(model.defaults);
  model.defaults=withLevel(model,'high');
  const recipe:Recipe={recipe_id:'recipe_nano_test',schema_version:1,modules:[],model_config_id:'model_other',core_parameters:oldParameters,model_parameters:{[model.model_config_id]:structuredClone(oldParameters)}};
  const before=structuredClone(recipe);
  const selected=selectWorkflowModel(recipe,model);
  assert.equal(selected.core_parameters.extensions?.[model.adapter_id]?.thinking_level,undefined);
  const fresh=selectWorkflowModel({...recipe,model_parameters:{}},model);
  assert.equal(fresh.core_parameters.extensions?.[model.adapter_id]?.thinking_level,'high');
  assert.deepEqual(recipe,before);
});
