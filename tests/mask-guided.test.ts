import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {MaskPixels} from '../src/adapters/mask-pixels.js';
import {maskDraftSchema,type MaskDraft} from '../src/core/mask.js';
import {maskEditMethod,maskGuidance,maskResolutionForCrop,planMaskRequest} from '../src/core/mask-request.js';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {ProjectRepository} from '../src/adapters/project-repository.js';
import {GeminiGenerator} from '../src/adapters/gemini-generator.js';
import {mockDescription} from '../src/core/model-library.js';
import {modelFromPreset} from '../src/protocols/model-catalog.js';
import type {ModelConfig} from '../src/core/domain.js';
import type {CloudExecutionContext} from '../src/core/ports.js';

const pixels=new MaskPixels(),png=(width:number,height:number,color='#123456')=>sharp({create:{width,height,channels:4,background:color}}).png().toBuffer();
const rgba=(bytes:Buffer)=>sharp(bytes).ensureAlpha().raw().toBuffer();
const draft=():MaskDraft=>({source_asset_id:'asset_base',width:800,height:600,strokes:[{tool:'paint',size:30,points:[[.55,.55],[.68,.55]]}],context_padding:64,instruction:'在白色区域对应的位置添加一只猫',model_config_id:'model_banana',quality:'standard',resolution:{mode:'tier',value:'2K'},mode:'strict',feather:0});
const model=()=>{const m=modelFromPreset('nano-banana-pro','model_banana','connection_banana','gemini-3-pro-image');m.endpoint='https://banana.test.invalid';m.credential_ref='credential_fake';return m;};
async function settle(w:Workspace){for(let i=0;i<500;i++){if(await w.serial(async()=>w.project!.jobs.every(j=>['succeeded','failed','cancelled'].includes(j.status))))return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}

async function fixture(options:{wrongRatio?:boolean;flat?:boolean;fail?:boolean;defaultTier?:string}={}){
  await mkdir('.local/test-projects',{recursive:true});const directory=await mkdtemp(path.resolve('.local/test-projects/guided-'));
  const repo=new ProjectRepository(directory),requests:string[]=[];let calls=0;
  const adapter=new GeminiGenerator(async(_url,init)=>{
    calls++;const body=init!.body as string;requests.push(body);const request=JSON.parse(body),parts=request.contents[0].parts;
    const input=await repo.loadModelInput(w.project!.jobs.at(-1)!.task_id);assert.equal(input?.body.encoding,'json');if(input?.body.encoding==='json')assert.equal(input.body.json,body);
    assert.equal(body.includes('credential_fake'),false);assert.equal(body.includes('fake-secret'),false);
    if(options.fail)return Response.json({error:'do not expose fake-secret'},{status:429});
    const imageParts=parts.filter((p:{inlineData?:unknown})=>p.inlineData);assert.equal(imageParts.length,2);
    const source=await sharp(Buffer.from(imageParts[0].inlineData.data,'base64')).metadata(),guide=Buffer.from(imageParts[1].inlineData.data,'base64'),meta=await sharp(guide).metadata();
    assert.equal(meta.hasAlpha,false);assert.equal(meta.width,source.width);assert.equal(meta.height,source.height);
    const sourcePixels=await rgba(Buffer.from(imageParts[0].inlineData.data,'base64'));
    for(let i=0;i<sourcePixels.length;i+=4)assert.deepEqual([...sourcePixels.subarray(i,i+4)],[18,52,86,255]);
    const output=await png(source.width!*2,source.height!*(options.wrongRatio?3:2),'#eeaa66');
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{mimeType:'image/png',data:output.toString('base64')}}]}}]});
  });
  const banana=model(),secrets={has:async()=>true,set:async()=>{},resolve:async()=>'fake-secret'};
  banana.gemini_compatibility={max_request_mb:60};
  if(options.defaultTier)banana.defaults.resolution={mode:'tier',value:options.defaultTier};
  let library=new ModelLibrary([...seedModels().filter(m=>m.kind==='mock'),banana],async()=>{},secrets,[mockDescription,adapter.description]);
  if(options.flat){const data=library.snapshot();data.models.find(m=>m.model_config_id===banana.model_config_id)!.capabilities.input_forms=['numbered_flat'];library=new ModelLibrary(data,async()=>{},secrets,[mockDescription,adapter.description]);}
  const w=new Workspace(library,adapter,undefined,pixels);await w.create(repo,'黑白区域图测试');
  const source=path.join(directory,'source.png');await writeFile(source,await png(800,600));await w.importFiles([source]);
  const d={...draft(),source_asset_id:w.project!.assets[0].asset_id};
  return {w,repo,d,requests,calls:()=>calls,adapter,library};
}

test('区域图由 alpha 反向导出，白色编辑、黑色保留，减选有效且不含透明通道',async()=>{
  const d=draft();d.strokes=[{tool:'paint',size:80,points:[[.5,.5]]},{tool:'erase',size:12,points:[[.5,.5]]}];
  const alpha=await pixels.rasterize(d.width,d.height,d.strokes),guide=await pixels.guidance(alpha),meta=await sharp(guide).metadata(),data=await rgba(guide);
  assert.equal(meta.format,'png');assert.equal(meta.hasAlpha,false);
  const at=(x:number,y:number)=>[...data.subarray((y*d.width+x)*4,(y*d.width+x)*4+4)];
  assert.deepEqual(at(400,300),[0,0,0,255]);assert.deepEqual(at(420,300),[255,255,255,255]);assert.deepEqual(at(0,0),[0,0,0,255]);
});

test('引导编辑按能力规划画幅与档位，Image 保持原生蒙版，不把理解模型当编辑模型',()=>{
  const banana=model(),d=draft();assert.equal(maskEditMethod(banana),'guided');
  for(const tier of ['1K','2K','4K']){const p=planMaskRequest({...d,resolution:{mode:'tier',value:tier}},banana);assert.equal(p.method,'guided');assert.deepEqual(p.parameters.resolution,{mode:'tier',value:tier});assert.equal(p.strategy,'interleaved');assert.ok(banana.capabilities.aspect_ratios.includes(p.geometry.request_ratio!));assert.equal(p.crop.width/p.crop.height,Number(p.geometry.request_ratio!.split(':')[0])/Number(p.geometry.request_ratio!.split(':')[1]));}
  const flat=planMaskRequest(d,{...banana,capabilities:{...banana.capabilities,input_forms:['numbered_flat']}});assert.equal(flat.strategy,'numbered_flat');
  assert.throws(()=>planMaskRequest(d,{...banana,capabilities:{...banana.capabilities,max_images:1}}),/两张/);
  assert.throws(()=>planMaskRequest({...d,resolution:{mode:'tier',value:'8K'}},banana),/分辨率/);
  assert.equal(maskEditMethod({...banana,purpose:'understanding'}),undefined);
  assert.equal(maskEditMethod({...banana,capabilities:{...banana.capabilities,operations:['referenceEdit']}}),undefined);
  const image=modelFromPreset('gpt-image-2-5-sunburst','model_image','connection_image','gpt-image-2.5-sunburst');assert.equal(maskEditMethod(image),'native');
  assert.equal(planMaskRequest({...d,quality:'auto'},image).method,'native');
  assert.equal(maskDraftSchema.safeParse({...d,resolution:{mode:'tier',value:'2K'}}).success,true);
});

test('旧 Banana 预设补齐引导能力，手动渠道设置不影响补齐，明确关闭才排除编辑',async()=>{
  const adapter=new GeminiGenerator(),banana=model();banana.capabilities.operations=['generate','referenceEdit'];
  const library=new ModelLibrary([seedModels()[0],banana],async()=>{},{has:async()=>true,set:async()=>{}},[mockDescription,adapter.description]);
  assert.equal(maskEditMethod(library.resolve(banana.model_config_id)),'guided');
  const data=library.snapshot(),entry=data.models.find(m=>m.model_config_id===banana.model_config_id)!;entry.capabilities.operations=['generate','referenceEdit'];
  const upgraded=new ModelLibrary(data,async()=>{},{has:async()=>true,set:async()=>{}},[mockDescription,adapter.description]);assert.equal(maskEditMethod(upgraded.resolve(banana.model_config_id)),'guided');assert.deepEqual(upgraded.snapshot().models.find(m=>m.model_config_id===banana.model_config_id)!.capabilities.operations,['generate','referenceEdit']);
  entry.capability_source='user';
  const manual=new ModelLibrary(data,async()=>{},{has:async()=>true,set:async()=>{}},[mockDescription,adapter.description]);assert.equal(maskEditMethod(manual.resolve(banana.model_config_id)),'guided');
  entry.capabilities.disabled_operations=['guidedMaskEdit'];
  const disabled=new ModelLibrary(data,async()=>{},{has:async()=>true,set:async()=>{}},[mockDescription,adapter.description]);assert.equal(maskEditMethod(disabled.resolve(banana.model_config_id)),undefined);
});

test('Banana 双图实际请求、档位、局部贴回、补画和版本恢复共享同一冻结任务',async()=>{
  const {w,repo,d,requests,calls}=await fixture(),p=w.project!,recipe=structuredClone(p.recipe);
  await w.serial(()=>w.enqueueMask(p.project_id,d));await settle(w);const job=p.jobs[0],edit=job.mask_edit!;
  assert.equal(job.status,'succeeded',job.error);assert.equal(job.execution_plan!.operation,'guidedMaskEdit');assert.equal(edit.method,'guided');assert.ok(edit.crop&&edit.guide_asset_id);assert.equal(calls(),1);assert.deepEqual(p.recipe,recipe);
  assert.equal(job.model_snapshot.gemini_compatibility?.max_request_mb,60);
  const request=JSON.parse(requests[0]),parts=request.contents[0].parts;
  assert.deepEqual(parts.map((part:{text?:string})=>part.text?'text':'image'),['image','image','text']);
  assert.equal(parts[2].text,`图1是待编辑原图，图2是与图1逐像素对齐的区域指示图。仅在图2白色区域对应的位置${d.instruction}，黑色区域对应的内容保持不变。图2只用于指示编辑位置，不要把黑白图案画进结果。保持图1的构图、视角和画面比例，只返回编辑后的图1。`);
  assert.equal(request.generationConfig.imageConfig.imageSize,'2K');assert.equal(request.generationConfig.imageConfig.aspectRatio,job.output_geometry!.request_ratio);
  assert.equal(request.mask,undefined);assert.ok(!requests[0].includes('mask_asset_id'));assert.equal(job.output_asset_ids.length,0);
  const generatedBytes=await repo.readAsset(p.assets.find(a=>a.asset_id===edit.raw_asset_ids[0])!);assert.equal((await sharp(generatedBytes).metadata()).width,edit.crop!.width*2);
  const ids=[];for(const mode of ['strict','natural'] as const){
    const id=await w.reprocessMask(p.project_id,job.task_id,mode,0);ids.push(id);
    const bytes=await repo.readAsset(p.assets.find(a=>a.asset_id===id)!);assert.equal((await sharp(bytes).metadata()).width,800);
    const data=await rgba(bytes);assert.deepEqual([...data.subarray(0,4)],[18,52,86,255]);const selected=(330*800+480)*4;assert.deepEqual([...data.subarray(selected,selected+4)],[238,170,102,255]);
    const corner=((edit.crop!.y+10)*800+edit.crop!.x+10)*4;assert.deepEqual([...data.subarray(corner,corner+4)],mode==='strict'?[18,52,86,255]:[238,170,102,255]);
  }
  const added=[...d.strokes,{tool:'paint' as const,size:30,points:[[(edit.crop!.x+10)/800,(edit.crop!.y+10)/600] as [number,number]]}];
  await w.saveCompositeMask(p.project_id,job.task_id,added);
  const preview=await w.previewMask(p.project_id,job.task_id,'strict',4,added),id=await w.reprocessMask(p.project_id,job.task_id,'strict',4,added);assert.ok(!ids.includes(id));
  assert.deepEqual(Buffer.from(preview.split(',')[1],'base64'),await repo.readAsset(p.assets.find(a=>a.asset_id===id)!));
  assert.equal(calls(),1);assert.deepEqual(edit.draft,d);assert.deepEqual(await repo.readAsset(p.assets.find(a=>a.asset_id===edit.raw_asset_ids[0])!),generatedBytes);
  await w.open(repo);assert.equal(w.project!.jobs[0].mask_edit!.guide_asset_id,edit.guide_asset_id);assert.deepEqual(w.project!.jobs[0].mask_edit!.composite_strokes,added);
  assert.equal(w.project!.jobs[0].model_snapshot.gemini_compatibility?.max_request_mb,60);
  const output=p.assets.find(a=>a.asset_id===id)!;if(output.location.type!=='external')throw Error('expected output');
  const recovered=await new ProjectRepository(path.join(repo.directory,'recovered')).recoverOutput(output.location.path);assert.equal(recovered.jobs[0].mask_edit!.method,'guided');assert.ok(recovered.assets.some(a=>a.asset_id===edit.guide_asset_id));assert.deepEqual(recovered.jobs[0].mask_edit!.composite_strokes,added);
  assert.equal(recovered.jobs[0].model_snapshot.gemini_compatibility?.max_request_mb,60);
  await repo.packageProject(w.project!,path.join(repo.directory,'package'));const packed=await new ProjectRepository(path.join(repo.directory,'package')).load();assert.equal(packed.jobs[0].mask_edit!.guide_asset_id,edit.guide_asset_id);assert.ok(packed.assets.every(a=>a.location.type==='managed'));
});

test('声明仅支持拍平的 Banana 接入仍保留双图顺序和完整语义',async()=>{
  const {w,d,requests}=await fixture({flat:true});await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);
  assert.equal(w.project!.jobs[0].status,'succeeded');const parts=JSON.parse(requests[0]).contents[0].parts;assert.deepEqual(parts.map((p:{text?:string})=>p.text?'text':'image'),['text','image','image']);assert.equal(parts[0].text,maskGuidance.instruction(d.instruction));
});

test('更改编辑档位会改变实际 imageSize，不被送入图片尺寸覆盖',async()=>{
  const {w,d,requests}=await fixture();
  for(const value of ['1K','4K']){
    await w.serial(()=>w.enqueueMask(w.project!.project_id,{...d,resolution:{mode:'tier',value}}));await settle(w);
    assert.equal(w.project!.jobs.at(-1)!.status,'succeeded');
    const request=JSON.parse(requests.at(-1)!);assert.equal(request.generationConfig.imageConfig.imageSize,value);
    const source=await sharp(Buffer.from(request.contents[0].parts[0].inlineData.data,'base64')).metadata();
    const crop=w.project!.jobs.at(-1)!.mask_edit!.crop!;assert.equal(source.width,crop.width);assert.equal(source.height,crop.height);
  }
  assert.equal(requests.length,2);
});

test('自动档位按裁片总像素计，容差边界、长条裁片和缺失档位不会误升档',()=>{
  const tiers=['1K','2K','4K'];
  for(const [width,height,tier] of [[1034,1034,'1K'],[2048,512,'1K'],[1800,1800,'2K'],[3000,1800,'4K'],[6000,6000,'4K']] as const){
    assert.deepEqual(maskResolutionForCrop({width,height},tiers),{mode:'tier',value:tier});
  }
  for(const [limit,below,above] of [[Math.floor(1024**2*1.1),'1K','2K'],[Math.floor(2048**2*1.1),'2K','4K']] as const){
    assert.deepEqual(maskResolutionForCrop({width:limit,height:1},tiers),{mode:'tier',value:below});
    assert.deepEqual(maskResolutionForCrop({width:limit+1,height:1},tiers),{mode:'tier',value:above});
  }
  assert.throws(()=>maskResolutionForCrop({width:1000,height:1000},['2K','4K']),/不支持.*1K/);
  const d={...draft(),width:4096,height:4096,resolution:undefined,strokes:[{tool:'paint' as const,size:10,points:[[.5,.5] as [number,number]]}]};
  const small=planMaskRequest({...d,context_padding:128},model()),large=planMaskRequest({...d,crop:{x:1000,y:1200,width:2200,height:1800}},model());
  assert.deepEqual(small.parameters.resolution,{mode:'tier',value:'1K'});
  assert.deepEqual(large.parameters.resolution,{mode:'tier',value:'2K'});
  assert.ok(large.crop.width*large.crop.height>2200*1800);
  assert.deepEqual(planMaskRequest({...d,crop:{x:0,y:0,width:3000,height:3000}},model()).parameters.resolution,{mode:'tier',value:'4K'});
});

test('后台默认 4K 时，局部编辑根据裁片自动发送档位，且不修改全局默认',async()=>{
  const {w,d,requests,library}=await fixture({defaultTier:'4K'});
  assert.deepEqual(library.resolve(d.model_config_id).defaults.resolution,{mode:'tier',value:'4K'});
  for(const resolution of [undefined,{mode:'default' as const}]){
    await w.serial(()=>w.enqueueMask(w.project!.project_id,{...d,resolution}));await settle(w);
    const job=w.project!.jobs.at(-1)!;assert.equal(job.status,'succeeded',job.error);
    const imageConfig=JSON.parse(requests.at(-1)!).generationConfig.imageConfig;
    assert.deepEqual(imageConfig,{aspectRatio:job.output_geometry!.request_ratio,imageSize:'1K'});
    assert.deepEqual(job.recipe_snapshot.core_parameters.resolution,{mode:'tier',value:'1K'});
  }
  assert.deepEqual(library.resolve(d.model_config_id).defaults.resolution,{mode:'tier',value:'4K'});
  const banana=model();banana.generation_contract!.tiers=['4K'];
  assert.throws(()=>planMaskRequest({...d,resolution:undefined},banana),/不支持.*1K/);
});

test('明显比例漂移保留原始返回，不拉伸合成；HTTP 失败不重试',async()=>{
  const {w,repo,d,calls}=await fixture({wrongRatio:true});await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);const p=w.project!,job=p.jobs[0];
  assert.equal(job.status,'succeeded');assert.equal(job.mask_edit!.raw_asset_ids.length,1);
  for(const mode of ['strict','natural'] as const)await assert.rejects(()=>w.previewMask(p.project_id,job.task_id,mode,0),/比例/);
  assert.equal(job.output_asset_ids.length,0);assert.equal(calls(),1);assert.ok((await repo.load()).jobs[0].mask_edit!.raw_asset_ids.length);
  const bad=await fixture({fail:true});await bad.w.serial(()=>bad.w.enqueueMask(bad.w.project!.project_id,bad.d));await settle(bad.w);assert.equal(bad.w.project!.jobs[0].status,'failed');assert.equal(bad.calls(),1);assert.equal(bad.w.project!.jobs[0].error!.includes('fake-secret'),false);
});

test('错误图序、透明区域图、缺失能力和记录失败均在发送前阻止',async()=>{
  const {w,repo,d,adapter,calls,library}=await fixture();await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);
  const p=w.project!,job=structuredClone(p.jobs[0]),banana=library.resolve(d.model_config_id),readImage=async(id:string)=>repo.readAsset(p.assets.find(a=>a.asset_id===id)!);
  const context:CloudExecutionContext={job,model:banana,readImage,resolveCredential:async()=>'fake'};
  const imageBlocks=job.adapted_input.blocks!.filter(b=>b.type==='image');[imageBlocks[0].asset_id,imageBlocks[1].asset_id]=[imageBlocks[1].asset_id,imageBlocks[0].asset_id];
  await assert.rejects(()=>adapter.execute(context,new AbortController().signal,async()=>{}),/顺序/);
  context.job=structuredClone(p.jobs[0]);context.readImage=id=>readImage(id===context.job.mask_edit!.guide_asset_id?context.job.mask_edit!.mask_asset_id:id);await assert.rejects(()=>adapter.execute(context,new AbortController().signal,async()=>{}),/无透明通道/);
  context.readImage=readImage;context.model={...banana,capabilities:{...banana.capabilities,operations:['generate','referenceEdit']}};await assert.rejects(()=>adapter.execute(context,new AbortController().signal,async()=>{}),/能力/);
  context.model=banana;context.recordModelInput=async()=>{throw Error('记录失败');};await assert.rejects(()=>adapter.execute(context,new AbortController().signal,async()=>{}),/记录失败/);assert.equal(calls(),1);
});
