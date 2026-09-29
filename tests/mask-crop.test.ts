import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {MaskPixels} from '../src/adapters/mask-pixels.js';
import {planMaskCrop,type MaskDraft} from '../src/core/mask.js';
import {imagesProfile} from '../src/protocols/generation-profiles.js';
import {validSize} from '../src/core/generation-contract.js';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {ProjectRepository} from '../src/adapters/project-repository.js';
import {ImagesGenerator} from '../src/adapters/images-generator.js';
import {mockDescription} from '../src/core/model-library.js';
import {modelFromPreset} from '../src/protocols/model-catalog.js';
import type {Job} from '../src/core/domain.js';
import {MB,validateImagesUpload} from '../src/core/image-limits.js';

const pixels=new MaskPixels(),limits=imagesProfile.size_limits!;
const png=(width:number,height:number,color='#123456')=>sharp({create:{width,height,channels:4,background:color}}).png().toBuffer();
const draft=(width=4096,height=4096):MaskDraft=>({source_asset_id:'asset_base',width,height,strokes:[{tool:'paint',size:100,points:[[.75,.8]]}],instruction:'只修改选区',model_config_id:'model_cloud',quality:'medium',mode:'strict',feather:0});
const rgba=(bytes:Buffer)=>sharp(bytes).ensureAlpha().raw().toBuffer();
async function directory(){await mkdir('.local/test-projects',{recursive:true});return mkdtemp(path.resolve('.local/test-projects/crop-'));}

test('4K 选区规划为合规范围，边缘和小底图补边保持原比例，过大选区明确拒绝',()=>{
  for(const point of [[.75,.8],[0,0],[1,1]] as [number,number][]){
    const d=draft();d.strokes[0].points=[point];const crop=planMaskCrop(d,limits);
    assert.ok(validSize(crop.width,crop.height,limits));assert.equal(crop.width,1024);assert.equal(crop.height,1024);
    assert.ok(crop.x<=point[0]*d.width&&crop.x+crop.width>=point[0]*d.width);
    assert.ok(crop.y<=point[1]*d.height&&crop.y+crop.height>=point[1]*d.height);
  }
  const small=planMaskCrop(draft(513,333),limits);assert.ok(small.x<0&&small.y<0);
  const d=draft();d.strokes[0].points=[[0,0],[1,1]];assert.throws(()=>planMaskCrop(d,limits),/超过/);
  assert.throws(()=>planMaskCrop({...draft(),crop:{x:0,y:0,width:256,height:256}},limits),/覆盖/);
  const wider=planMaskCrop({...draft(),crop:{x:2400,y:2800,width:1400,height:1200}},limits);
  assert.ok(validSize(wider.width,wider.height,limits));assert.ok(wider.width>=1400&&wider.height>=1200);
});

test('补边只保护原图外区域，裁切蒙版 alpha 与原坐标一致，贴回不缩放',async()=>{
  const d=draft(80,60);d.strokes=[{tool:'paint',size:12,points:[[0,0]]}];
  const crop={x:-10,y:-10,width:100,height:80},prepared=await pixels.prepare(await png(80,60),d,crop);
  const mask=await rgba(prepared.mask);assert.equal(mask[3],255);assert.equal(mask[(10*100+10)*4+3],0);
  const fullMask=await pixels.rasterize(80,60,d.strokes),generated=await png(100,80,'#fedcba');
  const strict=await rgba(await pixels.compose(prepared.source,fullMask,generated,0,crop));
  assert.deepEqual([...strict.subarray(0,4)],[254,220,186,255]);assert.deepEqual([...strict.subarray(-4)],[18,52,86,255]);
  const natural=await pixels.compose(prepared.source,fullMask,generated,0,crop,'natural');
  assert.equal((await sharp(natural).metadata()).width,80);assert.deepEqual([...(await rgba(natural)).subarray(-4)],[254,220,186,255]);
  const wrongSize=await png(50,40);await assert.rejects(()=>pixels.compose(prepared.source,fullMask,wrongSize,0,crop),/尺寸/);
});

test('4K 完整任务只发送 1024 裁片，严格/自然/补画贴回原图，记录与恢复保留范围',async()=>{
  let calls=0;
  const adapter=new ImagesGenerator(async(_url,init)=>{
    calls++;const form=init!.body as FormData;assert.equal(form.get('size'),'1024x1024');
    const source=Buffer.from(await (form.get('image[]') as File).arrayBuffer()),mask=Buffer.from(await (form.get('mask') as File).arrayBuffer());
    assert.equal((await sharp(source).metadata()).width,1024);assert.equal((await sharp(mask).metadata()).height,1024);
    const alpha=await rgba(mask);assert.equal(alpha[(512*1024+512)*4+3],0);assert.equal(alpha[3],255);
    return Response.json({data:[{b64_json:(await png(1024,1024,'#fedcba')).toString('base64')}]});
  });
  const cloud=modelFromPreset('gpt-image-2-5-sunburst','model_cloud','connection_cloud','gpt-image-2.5-sunburst');cloud.endpoint='https://test.invalid';cloud.credential_ref='credential_fake';
  const models=new ModelLibrary([...seedModels().filter(m=>m.kind==='mock'),cloud],async()=>{},{has:async()=>true,set:async()=>{},resolve:async()=>'fake'},[mockDescription,adapter.description]);
  const dir=await directory(),repo=new ProjectRepository(dir),w=new Workspace(models,adapter,undefined,pixels);await w.create(repo,'4K 裁切测试');
  const source=path.join(dir,'source.png');await writeFile(source,await png(4096,4096));await w.importFiles([source]);
  const d={...draft(),source_asset_id:w.project!.assets[0].asset_id};await w.serial(()=>w.enqueueMask(w.project!.project_id,d));
  for(let i=0;i<500;i++){if(await w.serial(async()=>['succeeded','failed'].includes(w.project!.jobs[0].status)))break;await new Promise(r=>setTimeout(r,10));}
  const p=w.project!,job=p.jobs[0],edit=job.mask_edit!;assert.equal(job.status,'succeeded',job.error);assert.equal(calls,1);assert.ok(edit.crop);assert.notEqual(edit.request_source_id,edit.source_snapshot_id);
  const record=await repo.loadModelInput(job.task_id);assert.equal(record?.body.encoding,'multipart');
  if(record?.body.encoding!=='multipart')throw new Error('expected multipart');
  const captured=record.body.fields.find(f=>f.name==='image[]')!.value;assert.equal(typeof captured,'object');
  if(typeof captured==='string')throw new Error('expected image');
  assert.equal((await sharp(Buffer.from(captured.data_base64,'base64')).metadata()).width,1024);
  const ids=[];for(const mode of ['strict','natural'] as const){
    const id=await w.reprocessMask(p.project_id,job.task_id,mode,0);ids.push(id);
    const bytes=await repo.readAsset(p.assets.find(a=>a.asset_id===id)!);assert.equal((await sharp(bytes).metadata()).width,4096);
    const data=await rgba(bytes);assert.deepEqual([...data.subarray(0,4)],[18,52,86,255]);
    const at=(x:number,y:number)=>[...data.subarray((y*4096+x)*4,(y*4096+x)*4+4)];
    assert.deepEqual(at(3072,3277),[254,220,186,255]);
    assert.deepEqual(at(edit.crop!.x+20,edit.crop!.y+20),mode==='strict'?[18,52,86,255]:[254,220,186,255]);
  }
  const added=[...d.strokes,{tool:'paint' as const,size:50,points:[[(edit.crop!.x+20)/4096,(edit.crop!.y+20)/4096] as [number,number],[0,0] as [number,number]]}];
  const preview=await w.previewMask(p.project_id,job.task_id,'strict',4,added),data=await rgba(Buffer.from(preview.split(',')[1],'base64'));
  assert.deepEqual([...data.subarray(0,4)],[18,52,86,255]);const index=((edit.crop!.y+20)*4096+edit.crop!.x+20)*4;assert.deepEqual([...data.subarray(index,index+4)],[254,220,186,255]);
  await w.saveCompositeMask(p.project_id,job.task_id,added);await w.open(repo);assert.deepEqual(w.project!.jobs[0].mask_edit!.crop,edit.crop);assert.deepEqual(w.project!.jobs[0].mask_edit!.composite_strokes,added);assert.equal(calls,1);
  const output=p.assets.find(a=>a.asset_id===ids[0])!;if(output.location.type!=='external')throw new Error('expected output');
  const restored=await new ProjectRepository(path.join(dir,'recovered')).recoverOutput(output.location.path);assert.deepEqual(restored.jobs[0].mask_edit!.crop,edit.crop);assert.ok(restored.assets.some(a=>a.asset_id===edit.request_source_id));
});

test('超过旧 20/25/32 MB 的图片可发送、完整记录并保存；较低渠道预算在网络前拒绝',async()=>{
  const bytes=await sharp(randomBytes(3072*3072*3),{raw:{width:3072,height:3072,channels:3}}).png({compressionLevel:0}).toBuffer();assert.ok(bytes.length>25*MB);
  const dir=await directory(),repo=new ProjectRepository(dir),file=path.join(dir,'large.png');await writeFile(file,bytes);
  const imported=await repo.importImage(file),internal=await repo.saveInternalImage(bytes,'snapshot.png'),output=await repo.saveOutput(bytes,'result.png','png');
  for(const asset of [imported,internal,output])assert.deepEqual(await repo.readAsset(asset),bytes);
  const model=seedModels()[3];model.images_compatibility={format_field:'output_format',image_field:'image[]',send_response_format:false,max_prompt_chars:32000,max_image_mb:40,max_request_mb:40};
  const job={task_id:'task_large',recipe_snapshot:{core_parameters:{...model.defaults,aspect_ratio:'1:1'}},adapted_input:{kind:'separated_inputs',image_asset_ids:['asset_large'],prompt:'测试',adjustments:[]}} as Job;
  let calls=0;
  const adapter=new ImagesGenerator(async(_url,init)=>{calls++;assert.deepEqual(Buffer.from(await ((init!.body as FormData).get('image[]') as File).arrayBuffer()),bytes);return Response.json({data:[{b64_json:(await png(64,64)).toString('base64')}]});});
  const context={job,model,readImage:async()=>bytes,resolveCredential:async()=>'fake',recordModelInput:async(input:Parameters<ProjectRepository['saveModelInput']>[1])=>repo.saveModelInput(job.task_id,input)};
  await adapter.execute(context,new AbortController().signal,async()=>{});assert.equal(calls,1);
  const captured=await repo.loadModelInput(job.task_id);assert.ok(JSON.stringify(captured).length>32*MB);
  assert.equal(captured?.body.encoding,'multipart');if(captured?.body.encoding==='multipart'){const value=captured.body.fields.find(f=>f.name==='image[]')!.value;assert.equal(typeof value,'object');if(typeof value!=='string')assert.deepEqual(Buffer.from(value.data_base64,'base64'),bytes);}
  model.images_compatibility.max_request_mb=20;await assert.rejects(()=>adapter.execute(context,new AbortController().signal,async()=>{}),/20 MB/);assert.equal(calls,1);
  assert.throws(()=>validateImagesUpload(50*MB,50*MB),/单文件/);
});
