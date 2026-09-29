import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { seedModels,ModelLibrary } from '../src/core/models.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { planExecution } from '../src/core/execution-plan.js';
import { InputStrategyRegistry,defaultInputStrategies,adaptChain } from '../src/core/compiler.js';
import { normalizeParameters,validateGenerationParameters,parameterFields,updateParameters } from '../src/core/generation-parameters.js';
import { generationContractSchema } from '../src/core/generation-contract.js';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ImagesGenerator } from '../src/adapters/images-generator.js';
import { openModelLibrary } from '../src/adapters/model-library-repository.js';
import { migrateModels,type AdapterDescription } from '../src/core/model-library.js';
import { ProjectRepository,projectFilename } from '../src/adapters/project-repository.js';
import type { Job,Recipe,Project } from '../src/core/domain.js';

function fixture(index=2){
  const model=seedModels()[index];model.geometry_support=index===3?'size':'ratio';
  const registry=new ModuleRegistry(),subject=registry.create('subject'),prompt=registry.create('prompt');
  subject.asset_ids=['asset_one','asset_one'];prompt.user_instruction='保持 image_1 标识，柔和光线';
  const recipe:Recipe={recipe_id:'recipe_plan',schema_version:1,input_strategy:'numbered_flat',modules:[subject,prompt],model_config_id:model.model_config_id,core_parameters:{...model.defaults}};
  const assets=[{asset_id:'asset_one',width:100,height:100}];
  return {model,registry,recipe,assets};
}
function job(plan:ReturnType<typeof planExecution>):Job{return {task_id:'task_plan',status:'queued',stage:'test',progress:0,created_at:'2026-09-21',recipe_snapshot:plan.recipe,chain_snapshot:plan.chain,adapted_input:plan.adapted,output_geometry:plan.geometry,execution_plan:plan.summary,model_snapshot:{model_config_id:'model_test',model:'test',provider:'test',adapter_id:'test',kind:'cloud',revision:1,title:'test'},output_asset_ids:[]};}

test('Nano 同一模型原生和拍平共用语义链；主动拍平不产生降级警告',()=>{
  const f=fixture(),before=structuredClone(f.recipe),flat=planExecution(f.recipe,f.assets,f.model,f.registry);
  const native=planExecution({...f.recipe,input_strategy:'interleaved'},f.assets,f.model,f.registry);
  assert.deepEqual(flat.chain,native.chain);assert.deepEqual(f.recipe,before);
  assert.deepEqual(flat.adapted.image_asset_ids,['asset_one','asset_one']);assert.equal(flat.adapted.adjustments.length,0);
  assert.equal(flat.summary.diagnostics[0].severity,'info');assert.match(flat.adapted.prompt!,/image_1/);
  assert.equal(native.adapted.kind,'native_blocks');assert.equal(flat.recipe.core_parameters.resolution?.mode,'tier');
  assert.equal(flat.recipe.core_parameters.quality,'standard');assert.equal(flat.recipe.core_parameters.version,2);
});

test('Gemini 拍平实际请求与计划文字一致，重复图保留；计划补充比例只发送一次',async()=>{
  const f=fixture();f.recipe.core_parameters.aspect_ratio='custom:137:90';
  const plan=planExecution(f.recipe,f.assets,f.model,f.registry),png=await sharp({create:{width:10,height:10,channels:3,background:'#fff'}}).png().toBuffer();
  let requestBody:any,recorded:any;const adapter=new GeminiGenerator(async(_url,init)=>{
    requestBody=JSON.parse(init!.body as string);
    return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]});
  });
  await adapter.execute({model:f.model,job:job(plan),readImage:async()=>png,resolveCredential:async()=>'test',recordModelInput:async record=>{recorded=record;}},new AbortController().signal,async()=>{});
  assert.equal(requestBody.contents[0].parts[0].text,plan.adapted.prompt);assert.equal(requestBody.contents[0].parts.length,3);
  assert.equal(requestBody.contents[0].parts.filter((p:any)=>p.inlineData).length,2);
  assert.equal((JSON.stringify(requestBody).match(/期望输出画面/g)??[]).length,1);
  assert.ok(JSON.stringify(recorded).includes('137:90'));
});

test('Images 明确混排不会偷偷拍平；auto 和显式拍平得到同样的输入',()=>{
  const f=fixture(3);assert.throws(()=>planExecution({...f.recipe,input_strategy:'interleaved'},f.assets,f.model),/显式选择/);
  assert.deepEqual(planExecution({...f.recipe,input_strategy:'auto'},f.assets,f.model).adapted,planExecution(f.recipe,f.assets,f.model).adapted);
});

test('模型库不再因 Nano 旧 separated 选择而判定协议未就绪',async()=>{
  const f=fixture(),data=migrateModels(seedModels());data.models[2].capabilities.interleaving='separated';
  const lib=new ModelLibrary(data,async()=>{},{has:async()=>true,set:async()=>{}},[new GeminiGenerator().description]);
  await lib.saveConnection(data.connections[0],'test');assert.equal((await lib.execution(f.model.model_config_id)).executable,true);
  const model=lib.resolve(f.model.model_config_id);delete f.recipe.input_strategy;
  assert.equal(planExecution(f.recipe,f.assets,model).summary.actual_strategy,'numbered_flat');
});

test('新增协议声明、新模型和模块通过既有规划入口；尺寸边界不假定 Images',()=>{
  const f=fixture(3),contract=generationContractSchema.parse({version:1,input_forms:['numbered_flat'],resolution_modes:['default','exact'],size_limits:{step:7,max_edge:700,max_ratio:5,min_pixels:49,max_pixels:490000,default_pixels:4900},fields:[{key:'lighting',title:'灯光',kind:'select',values:['soft','hard']}]});
  const adapter:AdapterDescription={...new ImagesGenerator().description,adapter_id:'third-party',generation_contract:contract};
  const model={...f.model,adapter_id:adapter.adapter_id,generation_contract:contract,capabilities:{...f.model.capabilities,features:[]}};
  f.registry.register({type:'lighting',title:'灯光',description:'灯光参考',base_instruction:'遵守灯光',accepts_images:true,editor_kind:'text'});
  const module=f.registry.create('lighting');module.user_instruction='侧光';f.recipe.modules.unshift(module);
  f.recipe.core_parameters={version:2,aspect_ratio:'auto',quality:'high',output_format:'png',count:1,resolution:{mode:'exact',width:140,height:70},extensions:{'third-party':{lighting:'soft'}}};
  const plan=planExecution(f.recipe,f.assets,model,f.registry);
  assert.equal(plan.geometry?.request_size,'140x70');assert.match(plan.adapted.prompt!,/侧光/);assert.equal(parameterFields(model)[0].title,'灯光');
  assert.throws(()=>planExecution({...f.recipe,core_parameters:{...f.recipe.core_parameters,resolution:{mode:'exact',width:141,height:70}}},f.assets,model,f.registry),/尺寸/);
  assert.throws(()=>validateGenerationParameters({...f.recipe.core_parameters,extensions:{'third-party':{lighting:'unknown'}}},model),/不支持/);
});

test('新增组合策略可以注册；不允许丢图或去重，不需要修改模块或执行器',()=>{
  const f=fixture(),strategies=new InputStrategyRegistry().register({id:'flat_preface',title:'拍平加前言',form:'numbered_flat',compile:chain=>{
    const flat=adaptChain(chain,f.model,'numbered_flat');return {...flat,prompt:'前言\n'+flat.prompt};
  }});
  const plan=planExecution({...f.recipe,input_strategy:'flat_preface'},f.assets,f.model,f.registry,undefined,strategies);
  assert.match(plan.adapted.prompt!,/^前言/);assert.equal(plan.summary.actual_strategy,'flat_preface');
  strategies.register({id:'bad',title:'丢图',form:'numbered_flat',compile:()=>({kind:'separated_inputs',prompt:'text',image_asset_ids:[],adjustments:[]})});
  assert.throws(()=>planExecution({...f.recipe,input_strategy:'bad'},f.assets,f.model,f.registry,undefined,strategies),/丢弃/);
  assert.throws(()=>defaultInputStrategies.get('missing'),/未安装/);
});

test('能力按声明收窄，未知参数拒绝，格式切换清除不适用字段',()=>{
  const f=fixture(),limited={...f.model,capabilities:{...f.model.capabilities,features:[]}};
  assert.ok(!parameterFields(limited).some(p=>p.key==='google_search'));
  assert.throws(()=>validateGenerationParameters({...normalizeParameters(f.model.defaults,limited),extensions:{[limited.adapter_id]:{google_search:true}}},limited),/未声明/);
  const images=seedModels()[3],p=normalizeParameters({...images.defaults,output_format:'jpeg',images_options:{output_compression:85}},images);
  assert.equal(updateParameters(p,{output_format:'png'},images).extensions?.[images.adapter_id].output_compression,undefined);
  assert.throws(()=>normalizeParameters({...p,image_size:'4K'},images),/新版参数/);
});

test('同协议新增模型只改能力配置，界面选项和验证同步收窄',async()=>{
  const data=migrateModels(seedModels()),adapter=new ImagesGenerator();
  const lib=new ModelLibrary(data,async()=>{},{has:async()=>true,set:async()=>{}},[adapter.description]);
  const source=data.models[3];
  await lib.saveModel({...source,model_config_id:'model_other',model:'independent-vendor',capabilities:{...source.capabilities,parameter_limits:{background:{values:['opaque']},output_compression:{maximum:50}}}});
  const model=lib.resolve('model_other');
  assert.deepEqual(parameterFields(model).find(f=>f.key==='background')!.values,['opaque']);
  const p=normalizeParameters(model.defaults,model);
  assert.throws(()=>validateGenerationParameters({...p,extensions:{[model.adapter_id]:{background:'transparent'}}},model),/不支持/);
  assert.throws(()=>validateGenerationParameters({...p,output_format:'jpeg',extensions:{[model.adapter_id]:{output_compression:60}}},model),/范围/);
});

test('新功能参考工具声明自己的状态，不要求视角字段；非法状态在存图前拒绝',()=>{
  const registry=new ModuleRegistry();registry.register({type:'layout_tool',title:'布局工具',description:'布局',base_instruction:'参考布局',accepts_images:true,editor_kind:'generated_reference',tool_fields:[{key:'columns',title:'列数',kind:'number',integer:true,minimum:1,maximum:8,required:true}]});
  assert.deepEqual(registry.validateToolState('layout_tool',{columns:3}),{columns:3});
  assert.throws(()=>registry.validateToolState('layout_tool',{yaw:30}),/未知/);
  assert.throws(()=>registry.validateToolState('layout_tool',{columns:9}),/范围/);
  assert.throws(()=>registry.validateToolState('viewpoint',{yaw:200,pitch:0,roll:0}),/范围/);
});

test('停用参考模块不发送它的逐图设置，当前配方仍保留可恢复的覆盖值',()=>{
  const f=fixture();f.recipe.core_parameters.gemini_options={reference_overrides:{asset_one:'high'}};
  f.recipe.modules[0].enabled=false;
  const plan=planExecution(f.recipe,f.assets,f.model,f.registry);
  assert.deepEqual(plan.recipe.core_parameters.extensions?.[f.model.adapter_id].reference_overrides,{});
  assert.equal(f.recipe.core_parameters.gemini_options.reference_overrides!.asset_one,'high');
  assert.ok(plan.summary.diagnostics.some(d=>d.code==='input.inactive_overrides'));
});

test('模型库迁移留存旧文件、幂等；项目新参数保存有版本和备份，历史快照不重写',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ediro-plan-migration-'));
  const legacy=migrateModels(seedModels());delete legacy.models[2].capabilities.features;
  const raw=JSON.stringify(legacy);await writeFile(path.join(dir,'model-library.v1.json'),raw);
  const modern=await openModelLibrary(dir);assert.equal(modern.schema_version,3);assert.equal(modern.models[2].defaults.version,2);
  assert.equal(await readFile(path.join(dir,'model-library.v1.json'),'utf8'),raw);
  assert.deepEqual(await openModelLibrary(dir),modern);
  const f=fixture(),project:Project={schema_version:2,project_id:'project_test',name:'test',created_at:'now',updated_at:'now',recipe:{...f.recipe,modules:[f.recipe.modules[1]]},assets:[],jobs:[],revisions:[]};
  delete project.recipe.input_strategy;
  const old=JSON.stringify(project);await writeFile(path.join(dir,projectFilename),old);
  project.recipe.core_parameters=normalizeParameters(project.recipe.core_parameters,f.model);project.recipe.input_strategy='numbered_flat';
  const repo=new ProjectRepository(dir);await repo.save(project);const reopened=await repo.load();
  assert.equal(reopened.schema_version,3);assert.equal(reopened.recipe.input_strategy,'numbered_flat');
  assert.equal(await readFile(path.join(dir,projectFilename+'.pre-generation-v3.bak'),'utf8'),old);
});
