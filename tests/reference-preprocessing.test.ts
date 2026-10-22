import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {defaultModuleSettings,type ReferenceSettings} from '../src/core/module-settings.js';
import {readReferenceImage,resizeReferenceImage} from '../src/adapters/reference-image.js';
import {blurReferenceImage} from '../src/adapters/blur-preprocessor.js';
import {ReferencePreprocessor} from '../src/adapters/reference-preprocessor.js';
import {ExecutionRegistry} from '../src/adapters/execution-registry.js';
import {MockGenerator} from '../src/adapters/mock-generator.js';
import {seedModels} from '../src/core/models.js';
import type {CloudExecutionContext} from '../src/core/ports.js';
import type {Block,Job} from '../src/core/domain.js';

const source=await sharp({create:{width:1200,height:600,channels:4,background:'#fff'}}).composite([
  {input:await sharp({create:{width:600,height:600,channels:4,background:'#111'}}).png().toBuffer(),left:0,top:0},
]).png().toBuffer();
const clear=await resizeReferenceImage(source,512);
const settings:ReferenceSettings={max_edge:512,preprocess:'blur',blur_strength:'medium'};
function context():CloudExecutionContext{
  const blocks:Block[]=['subject','composition','style','image_text'].map(reference_type=>({type:'image',asset_id:'asset_shared',reference_type,source_module_id:`module_${reference_type}`,reference_id:`reference_${reference_type}`}));
  const model=seedModels()[0];
  const modules=blocks.filter(block=>block.type==='image').map(block=>({module_id:block.source_module_id,reference_type:block.reference_type,asset_ids:[block.asset_id]}));
  const job={module_settings_snapshot:{...defaultModuleSettings,composition:settings,style:settings},chain_snapshot:{blocks},recipe_snapshot:{modules,core_parameters:model.defaults},adapted_input:{kind:'native_blocks',blocks}} as unknown as Job;
  return {job,model,readImage:async()=>source,resolveCredential:async()=>''};
}

test('生成只处理构图风格，同一素材用于主体时保留原图；理解仍使用清晰缩图',async()=>{
  const c=context(),blur=await blurReferenceImage(clear,'medium');
  assert.deepEqual(await readReferenceImage(c,'asset_shared',0),source);
  assert.deepEqual(await readReferenceImage(c,'asset_shared',1),blur);
  assert.deepEqual(await readReferenceImage(c,'asset_shared',2),blur);
  assert.deepEqual(await readReferenceImage(c,'asset_shared',3),source);
  c.model={...c.model,purpose:'understanding'};
  c.preprocessReferenceImage=async()=>{throw new Error('理解路径不能运行预处理');};
  for(const method of ['blur','depth','segment'] as const){
    c.job.module_settings_snapshot!.composition={...settings,preprocess:method};
    assert.deepEqual(await readReferenceImage(c,'asset_shared',1),clear);
  }
  c.job.mask_edit={} as never;
  assert.deepEqual(await readReferenceImage(c,'asset_shared',1),source);
  delete c.job.mask_edit;delete c.job.module_settings_snapshot;
  assert.deepEqual(await readReferenceImage(c,'asset_shared',1),source);
});

test('同一素材在两个同类模块中使用各自快照参数，理解和历史任务仍保持原有分流',async()=>{
  const c=context(),first=c.job.recipe_snapshot.modules.find(module=>module.reference_type==='composition')!;
  first.reference_settings={max_edge:512,preprocess:'blur',blur_strength:'weak'};
  const second={...structuredClone(first),module_id:'module_composition_second',reference_settings:{max_edge:1024 as const,preprocess:'none' as const,blur_strength:'strong' as const}};
  c.job.recipe_snapshot.modules.push(second);
  c.job.chain_snapshot.blocks.push({type:'image',asset_id:'asset_shared',reference_type:'composition',source_module_id:second.module_id,reference_id:'reference_composition_second'});
  c.job.module_settings_snapshot!.composition={max_edge:1024,preprocess:'segment',blur_strength:'medium'};
  let calls=0;c.preprocessReferenceImage=async(bytes,options)=>{calls++;assert.equal(options.blur_strength,'weak');return blurReferenceImage(bytes,options.blur_strength);};
  assert.deepEqual(await readReferenceImage(c,'asset_shared',1),await blurReferenceImage(clear,'weak'));
  const clearLarge=await resizeReferenceImage(source,1024);
  assert.deepEqual(await readReferenceImage(c,'asset_shared',4),clearLarge);assert.equal(calls,1);
  c.model={...c.model,purpose:'understanding'};
  assert.deepEqual(await readReferenceImage(c,'asset_shared',1),clear);
  assert.deepEqual(await readReferenceImage(c,'asset_shared',4),clearLarge);assert.equal(calls,1);
  first.reference_type='style';await assert.rejects(readReferenceImage(c,'asset_shared',1),/所属模块/);first.reference_type='composition';
  delete c.job.module_settings_snapshot;
  assert.strictEqual(await readReferenceImage(c,'asset_shared',1),source);
  assert.strictEqual(await readReferenceImage(c,'asset_shared',4),source);
});

test('模糊保留比例、透明通道且强度递增，512和1K使用等比例半径',async()=>{
  const spreads=[];
  for(const strength of ['weak','medium','strong'] as const){
    const blurred=await blurReferenceImage(clear,strength),meta=await sharp(blurred).metadata();
    assert.deepEqual([meta.width,meta.height,meta.hasAlpha],[512,256,true]);
    const {data,info}=await sharp(blurred).removeAlpha().raw().toBuffer({resolveWithObject:true});
    let transition=0;
    for(let x=0;x<info.width;x++){const value=data[(128*info.width+x)*3];if(value>32&&value<240)transition++;}
    spreads.push(transition);
  }
  assert.ok(spreads[0]<spreads[1]&&spreads[1]<spreads[2]);
  const transparent=await sharp({create:{width:80,height:40,channels:4,background:{r:100,g:20,b:30,alpha:0.4}}}).png().toBuffer();
  const alpha=(await sharp(await blurReferenceImage(transparent,'medium')).stats()).channels[3];
  assert.ok(alpha.min>=99&&alpha.max<=105,'Gaussian filtering may round alpha by a few levels, but must retain transparency');
  const large=await blurReferenceImage(await resizeReferenceImage(source,1024),'medium');
  const {data,info}=await sharp(large).removeAlpha().raw().toBuffer({resolveWithObject:true});
  let largeTransition=0;
  for(let x=0;x<info.width;x++){const value=data[(256*info.width+x)*3];if(value>32&&value<240)largeTransition++;}
  assert.ok(Math.abs(largeTransition/2-spreads[1])<=3);
});

test('深度和分割复用清晰缩图入口，处理不可用时明确失败，不静默发原图',async()=>{
  const c=context();
  for(const method of ['depth','segment'] as const){
    c.job.module_settings_snapshot!.composition={...settings,preprocess:method};
    await assert.rejects(readReferenceImage(c,'asset_shared',1),/预处理未初始化/);
    let called=0;c.preprocessReferenceImage=async(bytes,options)=>{called++;assert.deepEqual(bytes,clear);assert.equal(options.preprocess,method);return Buffer.from('processed-output');};
    assert.equal((await readReferenceImage(c,'asset_shared',1)).toString(),'processed-output');assert.equal(called,1);
    delete c.preprocessReferenceImage;
  }
});

test('预览与执行共用处理字节，缺模型/取消后仍可直接重试其它处理',async()=>{
  const base=path.join(process.cwd(),'.local','test-reference-preprocessing');await mkdir(base,{recursive:true});
  const processor=new ReferencePreprocessor(await mkdtemp(path.join(base,'case-')));
  try{
    const preview=await processor.process(clear,settings);
    assert.strictEqual(await processor.process(clear,{...settings}),preview);
    const c=context();c.preprocessReferenceImage=(bytes,options)=>processor.process(bytes,options);
    assert.deepEqual(await readReferenceImage(c,'asset_shared',1),preview);
    await assert.rejects(processor.process(clear,{...settings,preprocess:'depth'}),/资源未准备/);
    const cancellation=new AbortController();cancellation.abort();
    await assert.rejects(processor.process(clear,settings,cancellation.signal),/已取消/);
    assert.deepEqual(await processor.process(clear,settings),preview);
    const strong=await processor.process(clear,{...settings,blur_strength:'strong'});assert.notDeepEqual(strong,preview);
  }finally{await processor.close();}
  await assert.rejects(processor.process(clear,settings),/已取消/);
});

test('执行注册表绑定本地处理与生成取消信号，不改变适配器的请求结构',async()=>{
  const c=context(),signal=new AbortController().signal;
  let processed=0;
  const registry=new ExecutionRegistry(async(bytes,options,received)=>{processed++;assert.strictEqual(received,signal);assert.deepEqual(bytes,clear);return blurReferenceImage(bytes,options.blur_strength);});
  registry.register({description:new MockGenerator().description,execute:async(ctx)=>{
    const image=await readReferenceImage(ctx,'asset_shared',1);assert.deepEqual(image,await blurReferenceImage(clear,'medium'));return {images:[]};
  }});
  await registry.execute(c,signal,async()=>{});assert.equal(processed,1);
});
