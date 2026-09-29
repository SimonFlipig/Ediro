import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {MaskPixels} from '../src/adapters/mask-pixels.js';
import {maskDraftSchema,currentMaskFeather,MASK_FEATHER_VERSION,type MaskDraft} from '../src/core/mask.js';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {ProjectRepository} from '../src/adapters/project-repository.js';
import {ImagesGenerator} from '../src/adapters/images-generator.js';
import {MockGenerator} from '../src/adapters/mock-generator.js';
import type {CloudExecutionPort,CloudExecutionContext} from '../src/core/ports.js';
import type {Job} from '../src/core/domain.js';
import {commandSchema} from '../src/shared/commands.js';
import {mockDescription} from '../src/core/model-library.js';
import {modelFromPreset} from '../src/protocols/model-catalog.js';
import {defaultMaskModel,maskEditorEntry} from '../src/ui/mask-editor-state.js';

const pixels=new MaskPixels();
const png=(width=64,height=64,color='#193551')=>sharp({create:{width,height,channels:4,background:color}}).png().toBuffer();
const draft=(id='asset_base',width=64,height=64):MaskDraft=>({source_asset_id:id,width,height,strokes:[{tool:'paint',size:24,points:[[.3,.5],[.7,.5]]}],instruction:'将所选区域改为暖色',model_config_id:'model_mock_native',quality:'standard',mode:'strict',feather:0});
const rgba=(bytes:Buffer)=>sharp(bytes).ensureAlpha().raw().toBuffer();

test('mask alpha 方向、减选与空蒙版校验',async()=>{
  const d=draft(),base=await png(),p=await pixels.prepare(base,d),m=await rgba(p.mask);
  assert.equal(m[(32*64+32)*4+3],0);assert.equal(m[3],255);
  d.strokes.push({tool:'erase',size:8,points:[[.5,.5]]});
  const erased=await rgba((await pixels.prepare(base,d)).mask);assert.equal(erased[(32*64+32)*4+3],255);
  await assert.rejects(()=>pixels.prepare(base,{...d,strokes:[]}),/涂出/);
  await assert.rejects(()=>pixels.prepare(base,{...d,width:63}),/尺寸/);
  assert.equal(maskDraftSchema.safeParse({...d,strokes:[{tool:'paint',size:24,points:[[2,0]]}]}).success,false);
  assert.equal(commandSchema.safeParse({type:'mask:reprocess',project_id:'project_one',task_id:'task_one',mode:'strict',feather:-1}).success,false);
});

test('严格合成与向内羽化对选区外 RGBA 逐字节不变',async()=>{
  const bytes=Buffer.alloc(64*64*4);for(let i=0;i<bytes.length;i++)bytes[i]=(i*37)%256;
  const base=await sharp(bytes,{raw:{width:64,height:64,channels:4}}).png().toBuffer(),generated=await png(64,64,'#efab67');
  const p=await pixels.prepare(base,draft()),before=await rgba(p.source),mask=await rgba(p.mask);
  for(const feather of [0,8,64]){
    const out=await rgba(await pixels.compose(p.source,p.mask,generated,feather));let changed=0,protectedCount=0;
    for(let i=0;i<64*64;i++)if(mask[i*4+3]===255){protectedCount++;assert.deepEqual(out.subarray(i*4,i*4+4),before.subarray(i*4,i*4+4));}else if(!out.subarray(i*4,i*4+4).equals(before.subarray(i*4,i*4+4)))changed++;
    assert.ok(protectedCount>1000);assert.ok(changed>0);
  }
  await assert.rejects(()=>pixels.compose(p.source,p.mask,Buffer.from('invalid'),0));
});


async function fixture(executor?:CloudExecutionPort){
  const root=path.resolve('.local/test-projects');await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'mask-'));
  let calls=0;const engine=executor??new MockGenerator(1);
  const workspace=new Workspace(new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}}),{execute:async(...args)=>{calls++;return engine.execute(...args);}},undefined,pixels);
  const repo=new ProjectRepository(directory);await workspace.create(repo,'蒙版测试');
  const filename=path.join(directory,'source.png');await writeFile(filename,await png());await workspace.importFiles([filename]);
  const d=draft(workspace.project!.assets[0].asset_id);return {workspace,repo,d,calls:()=>calls};
}
async function settle(workspace:Workspace){for(let i=0;i<300;i++){if(await workspace.serial(async()=>workspace.project!.jobs.every(j=>['succeeded','failed','cancelled'].includes(j.status))))return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');}

test('局部编辑重试使用原蒙版与输入快照，不覆盖后来修改的草稿',async()=>{
  let attempts=0;const engine=new MockGenerator(1);
  const {workspace:w,d}=await fixture({execute:async(...args)=>{if(++attempts===1)throw new Error('模拟请求失败');return engine.execute(...args);}});
  await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);
  const old=structuredClone(w.project!.jobs[0]);assert.equal(old.status,'failed');
  const changed={...d,instruction:'后来修改的局部指令',strokes:[]};await w.saveMaskDraft(w.project!.project_id,changed);
  const assetCount=w.project!.assets.length;
  await w.serial(()=>w.retry(w.project!.project_id,old.task_id));await settle(w);
  assert.equal(attempts,2);assert.equal(w.project!.jobs[1].status,'succeeded');
  assert.deepEqual(w.project!.jobs[0],old);assert.deepEqual(w.project!.mask_drafts![0],changed);
  assert.deepEqual(w.project!.jobs[1].mask_edit!.draft,old.mask_edit!.draft);
  assert.equal(w.project!.jobs[1].mask_edit!.mask_asset_id,old.mask_edit!.mask_asset_id);
  assert.equal(w.project!.assets.length,assetCount+1);await w.shutdown();
});

test('局部编辑优先可用 Nano，未配置或停用时回退，恢复草稿仍保留原模型',()=>{
  const banana={...modelFromPreset('nano-banana-pro','model_banana','connection_banana','gemini-3-pro-image'),executable:true};
  const image={...modelFromPreset('gpt-image-2-5-sunburst','model_image','connection_image','gpt-image-2.5-sunburst'),executable:true};
  const mocks=seedModels().filter(m=>m.kind==='mock').map(m=>({...m,purpose:'generation' as const,has_credential:false,executable:true}));
  assert.equal(defaultMaskModel([image,...mocks,banana])?.model_config_id,banana.model_config_id);
  assert.equal(defaultMaskModel([image,...mocks,banana],'model_mock_native')?.model_config_id,'model_mock_native');
  assert.equal(defaultMaskModel([{...banana,enabled:false},image,...mocks])?.model_config_id,image.model_config_id);
  assert.equal(defaultMaskModel([{...banana,executable:false},image,...mocks])?.model_config_id,image.model_config_id);
});

test('合成版本重开恢复原任务的绘制和补画蒙版；旧版本、新一轮编辑与新任务分开',async()=>{
  const {workspace:w,repo,d,calls}=await fixture();
  await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);
  const job=w.project!.jobs[0],p=w.project!;
  const old=await w.reprocessMask(p.project_id,job.task_id,'strict',0);
  const strokes=[...d.strokes,{tool:'erase' as const,size:7,points:[[.5,.5] as [number,number]]}];
  await w.saveCompositeMask(p.project_id,job.task_id,strokes);
  const edited=await w.reprocessMask(p.project_id,job.task_id,'strict',3,strokes);
  await w.saveMaskDraft(p.project_id,{...d,source_asset_id:edited,strokes:[]}); // old UI treated output as a new source
  await w.open(repo);
  const entry=maskEditorEntry(w.project!,edited);
  assert.equal(entry.taskId,job.task_id);assert.equal(entry.sourceId,d.source_asset_id);assert.equal(entry.snapshotId,job.mask_edit!.source_snapshot_id);
  assert.equal(entry.display,'result');assert.deepEqual(entry.draft!.strokes,d.strokes);assert.deepEqual(entry.strokes,strokes);assert.equal(entry.draft!.feather,3);
  assert.equal(entry.draft!.model_config_id,d.model_config_id);
  assert.deepEqual(maskEditorEntry(w.project!,old).strokes,d.strokes);
  const fresh=maskEditorEntry(w.project!,edited,{fresh:true});assert.equal(fresh.sourceId,edited);assert.equal(fresh.taskId,undefined);assert.deepEqual(fresh.draft!.strokes,[]);assert.equal(fresh.display,'mask');
  const beforeCalls=calls();
  assert.equal(await w.reprocessMask(p.project_id,entry.taskId!,entry.draft!.mode,entry.draft!.feather,entry.strokes),edited);assert.equal(calls(),beforeCalls);
  const unfinished=[...strokes,{tool:'paint' as const,size:5,points:[[.6,.5] as [number,number]]}];
  await w.saveCompositeMask(p.project_id,job.task_id,unfinished);await w.open(repo);
  assert.deepEqual(maskEditorEntry(w.project!,edited).strokes,unfinished);
  // Explicit version selection resumes exactly the saved variant, even if the
  // latest result has an unfinished composition draft.
  assert.deepEqual(maskEditorEntry(w.project!,edited,{taskId:job.task_id}).strokes,strokes);
  assert.deepEqual(maskEditorEntry(w.project!,old).strokes,d.strokes);
  const changed=structuredClone(w.project!.recipe);changed.modules.reverse();changed.modules[0].user_instruction='后续工作草稿';
  await w.saveRecipe(changed);
  const history=structuredClone(w.project!.jobs),savedDrafts=structuredClone(w.project!.mask_drafts);
  await w.restoreResult(p.project_id,edited);
  assert.deepEqual(w.project!.recipe,w.registry.resolveRecipe(job.mask_edit!.main_recipe_snapshot));
  assert.deepEqual(w.project!.jobs,history);assert.deepEqual(w.project!.mask_drafts,savedDrafts);assert.equal(calls(),beforeCalls);
  await w.serial(()=>w.enqueueMask(p.project_id,{...d,instruction:'第二次修改'}));await settle(w);
  assert.equal(maskEditorEntry(w.project!,edited).taskId,job.task_id); // must not choose the newest task for this source
  assert.equal(maskEditorEntry(w.project!,d.source_asset_id,{taskId:job.task_id}).taskId,job.task_id);
});

test('编辑快照、草稿重开、主配方隔离、双模式本地处理与父版本关系',async()=>{
  const {workspace:w,repo,d,calls}=await fixture(),recipe=structuredClone(w.project!.recipe);
  await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);
  const p=w.project!,job=p.jobs[0];assert.equal(job.status,'succeeded',job.error);assert.deepEqual(p.recipe,recipe);assert.equal(calls(),1);
  const input=await repo.loadModelInput(job.task_id);assert.ok(input);assert.equal(job.mask_edit!.raw_asset_ids.length,1);
  assert.notEqual(job.mask_edit!.source_snapshot_id,d.source_asset_id);
  const raw=p.assets.find(a=>a.asset_id===job.mask_edit!.raw_asset_ids[0])!;assert.equal(raw.kind,'generated');assert.equal(raw.hidden_from_results,true);
  assert.equal(job.output_asset_ids.length,0);assert.equal(job.mask_edit!.variants.length,0);
  const before=JSON.stringify(p),preview=await w.previewMask(p.project_id,job.task_id,'strict',0);
  assert.equal(JSON.stringify(p),before);assert.equal(calls(),1);
  const strict=await w.serial(()=>w.reprocessMask(p.project_id,job.task_id,'strict',0));
  assert.deepEqual(Buffer.from(preview.split(',')[1],'base64'),await repo.readAsset(p.assets.find(a=>a.asset_id===strict)!));
  const natural=await w.serial(()=>w.reprocessMask(p.project_id,job.task_id,'natural',12));assert.notEqual(strict,natural);assert.equal(calls(),1);
  assert.equal(await w.serial(()=>w.reprocessMask(p.project_id,job.task_id,'strict',0)),strict);assert.equal(job.output_asset_ids.length,2);
  await w.open(repo);assert.deepEqual(w.project!.mask_drafts![0],d);assert.deepEqual(w.project!.recipe,recipe);
  const second={...draft(strict),strokes:[{tool:'paint' as const,size:10,points:[[.5,.5] as [number,number]]}]};
  await w.serial(()=>w.enqueueMask(w.project!.project_id,second));await settle(w);
  const child=w.project!.jobs[1];assert.equal(child.status,'succeeded',child.error);
  await w.serial(()=>w.reprocessMask(w.project!.project_id,child.task_id,'strict',0));
  const rev=w.project!.revisions.find(r=>r.asset_id===child.output_asset_ids[0])!;
  assert.equal(rev.parent_revision_id,w.project!.revisions.find(r=>r.asset_id===strict)!.revision_id);
  await w.restore(job.task_id);assert.deepEqual(w.project!.recipe,recipe);
});

test('旧羽化版本保留原文件，重开后预览与确认使用新算法，仍复用同一次模型返回',async()=>{
  const {workspace:w,repo,d,calls}=await fixture();
  d.strokes=[{tool:'paint',size:100,points:[[.5,.5]]}];
  await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);
  const taskId=w.project!.jobs[0].task_id,projectId=w.project!.project_id;
  const oldId=await w.reprocessMask(projectId,taskId,'strict',8);
  const oldAsset=w.project!.assets.find(a=>a.asset_id===oldId)!,oldBytes=await repo.readAsset(oldAsset);
  const legacy=w.project!.jobs[0].mask_edit!.variants[0];delete legacy.feather_version; // Pre-fix saved record.
  assert.equal(currentMaskFeather(legacy),false);await w.persist();await w.open(repo);
  const preview=Buffer.from((await w.previewMask(projectId,taskId,'strict',8)).split(',')[1],'base64');
  const nextId=await w.reprocessMask(projectId,taskId,'strict',8);assert.notEqual(nextId,oldId);
  const next=w.project!.jobs[0].mask_edit!.variants.find(v=>v.asset_id===nextId)!;
  assert.equal(next.feather_version,MASK_FEATHER_VERSION);assert.equal(currentMaskFeather(next),true);
  assert.deepEqual(await repo.readAsset(oldAsset),oldBytes);
  assert.deepEqual(await repo.readAsset(w.project!.assets.find(a=>a.asset_id===nextId)!),preview);
  await w.open(repo);assert.equal(await w.reprocessMask(projectId,taskId,'strict',8),nextId);assert.equal(calls(),1);
  assert.equal(currentMaskFeather({mode:'strict',feather:0}),true);assert.equal(currentMaskFeather({mode:'natural',feather:0}),true);
});

test('空选区与错误模型在发送前拒绝，失败后草稿保留',async()=>{
  const {workspace:w,d,calls}=await fixture();
  await assert.rejects(()=>w.serial(()=>w.enqueueMask(w.project!.project_id,{...d,strokes:[]})),/涂出/);
  assert.equal(w.project!.jobs.length,0);assert.equal(calls(),0);
  await assert.rejects(()=>w.serial(()=>w.enqueueMask(w.project!.project_id,{...d,model_config_id:'model_nano_pro'})),/就绪/);assert.equal(calls(),0);
  const bad=await fixture({execute:async()=>{throw new Error('模拟网络失败');}});
  await bad.workspace.serial(()=>bad.workspace.enqueueMask(bad.workspace.project!.project_id,bad.d));await settle(bad.workspace);
  assert.equal(bad.workspace.project!.jobs[0].status,'failed');assert.deepEqual((await bad.repo.load()).mask_drafts![0],bad.d);assert.equal(bad.calls(),1);
});

test('补画合成蒙版只采用返回像素；减选、清空、版本隔离与重开恢复不修改生成请求',async()=>{
  const {workspace:w,repo,d,calls}=await fixture();
  await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);
  const p=w.project!,job=p.jobs[0],edit=job.mask_edit!,frozen=structuredClone(edit.draft),request=await repo.loadModelInput(job.task_id);
  const originalMask=await repo.readAsset(p.assets.find(a=>a.asset_id===edit.mask_asset_id)!);
  const base=await rgba(await repo.readAsset(p.assets.find(a=>a.asset_id===edit.source_snapshot_id)!));
  const raw=await rgba(await repo.readAsset(p.assets.find(a=>a.asset_id===edit.raw_asset_ids[0])!));
  const oldId=await w.reprocessMask(p.project_id,job.task_id,'strict',0),oldBytes=await repo.readAsset(p.assets.find(a=>a.asset_id===oldId)!);
  const added=[...d.strokes,{tool:'paint' as const,size:10,points:[[.5,.08] as [number,number]]}];
  await w.saveCompositeMask(p.project_id,job.task_id,added);
  const beforePreview=JSON.stringify(p),preview=await w.previewMask(p.project_id,job.task_id,'strict',0,added);
  assert.equal(JSON.stringify(p),beforePreview);
  const bytes=Buffer.from(preview.split(',')[1],'base64'),data=await rgba(bytes),addedIndex=(5*64+32)*4;
  assert.deepEqual(data.subarray(addedIndex,addedIndex+4),raw.subarray(addedIndex,addedIndex+4));
  assert.deepEqual((await rgba(oldBytes)).subarray(addedIndex,addedIndex+4),base.subarray(addedIndex,addedIndex+4));
  const newId=await w.reprocessMask(p.project_id,job.task_id,'strict',0,added);assert.notEqual(newId,oldId);
  assert.deepEqual(await repo.readAsset(p.assets.find(a=>a.asset_id===newId)!),bytes);
  assert.deepEqual(await repo.readAsset(p.assets.find(a=>a.asset_id===oldId)!),oldBytes);
  const erased=[...added,{tool:'erase' as const,size:10,points:[[.5,.08] as [number,number]]}];
  const erasedBytes=await rgba(Buffer.from((await w.previewMask(p.project_id,job.task_id,'strict',0,erased)).split(',')[1],'base64'));
  assert.deepEqual(erasedBytes.subarray(addedIndex,addedIndex+4),base.subarray(addedIndex,addedIndex+4));
  const cleared=await rgba(Buffer.from((await w.previewMask(p.project_id,job.task_id,'strict',12,[])).split(',')[1],'base64'));assert.deepEqual(cleared,base);
  assert.equal(await w.reprocessMask(p.project_id,job.task_id,'strict',0,frozen.strokes),oldId);
  assert.deepEqual(edit.draft,frozen);assert.deepEqual(await repo.loadModelInput(job.task_id),request);
  assert.deepEqual(await repo.readAsset(p.assets.find(a=>a.asset_id===edit.mask_asset_id)!),originalMask);assert.equal(calls(),1);
  await w.saveCompositeMask(p.project_id,job.task_id,erased);await w.open(repo);
  assert.deepEqual(w.project!.jobs[0].mask_edit!.composite_strokes,erased);
  assert.deepEqual(w.project!.jobs[0].mask_edit!.variants.find(v=>v.asset_id===newId)!.composite_strokes,added);
  const output=p.assets.find(a=>a.asset_id===newId)!;if(output.location.type!=='external')throw new Error('expected external');
  const recovered=await new ProjectRepository(path.join(repo.directory,'recovered-composite')).recoverOutput(output.location.path);
  assert.deepEqual(recovered.jobs[0].mask_edit!.variants.find(v=>v.asset_id===newId)!.composite_strokes,added);
  assert.deepEqual(recovered.jobs[0].mask_edit!.composite_strokes,added);
});

test('返回尺寸异常时保留原始图，仍可本地自然融合，不重发请求',async()=>{
  const {workspace:w,d,calls}=await fixture({execute:async()=>({images:[{bytes:await png(32,32),width:32,height:32,format:'png'}]})});
  await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);const job=w.project!.jobs[0];
  assert.equal(job.status,'succeeded');assert.equal(job.mask_edit!.raw_asset_ids.length,1);assert.equal(job.output_asset_ids.length,0);
  await assert.rejects(()=>w.previewMask(w.project!.project_id,job.task_id,'strict',0),/尺寸/);
  assert.equal(job.status,'succeeded');
  const id=await w.serial(()=>w.reprocessMask(w.project!.project_id,job.task_id,'natural',0));assert.ok(id);assert.equal(calls(),1);
});

test('Images 蒙版请求字段与记录一致，独立 mask 不混入参考图，缺失能力禁止发送',async()=>{
  const prepared=await pixels.prepare(await png(),draft());let calls=0,capture:unknown;
  const model=seedModels()[3];model.capabilities.operations.push('nativeMaskEdit');
  const job={task_id:'task_mask',recipe_snapshot:{core_parameters:{...model.defaults,aspect_ratio:'1:1'}},adapted_input:{kind:'separated_inputs',image_asset_ids:['asset_base'],prompt:'修改选区',adjustments:[]},mask_edit:{source_snapshot_id:'asset_base',mask_asset_id:'asset_mask'}} as Job;
  const c:CloudExecutionContext={job,model,readImage:async id=>id==='asset_mask'?prepared.mask:prepared.source,resolveCredential:async()=>'secret',recordModelInput:async input=>{capture=input;}};
  const adapter=new ImagesGenerator(async(url,init)=>{calls++;assert.match(String(url),/images\/edits$/);const form=init!.body as FormData;
    assert.equal(form.getAll('image[]').length,1);assert.equal(form.getAll('mask').length,1);
    assert.deepEqual(Buffer.from(await (form.get('mask') as File).arrayBuffer()),prepared.mask);
    assert.ok(capture);assert.equal(JSON.stringify(capture).includes('secret'),false);
    return Response.json({data:[{b64_json:prepared.source.toString('base64')}]});});
  await adapter.execute(c,new AbortController().signal,async()=>{});assert.equal(calls,1);
  model.capabilities.operations=['generate','referenceEdit'];await assert.rejects(()=>adapter.execute(c,new AbortController().signal,async()=>{}),/能力/);assert.equal(calls,1);
});

test('image-2.5 完整编辑任务发送固定底图、尺寸、质量和 mask，不读取主配方',async()=>{
  let calls=0;
  const generated=await png(1024,1024,'#eeaa66');
  const adapter=new ImagesGenerator(async(url,init)=>{
    calls++;assert.equal(String(url),'https://mask-test.example/v1/images/edits');const form=init!.body as FormData;
    assert.equal(form.get('model'),'gpt-image-2.5-sunburst');assert.equal(form.get('size'),'1024x1024');assert.equal(form.get('quality'),'xhigh');assert.equal(form.get('n'),'1');assert.equal(form.get('prompt'),'只修改选区');
    assert.equal(form.getAll('image[]').length,1);const mask=await sharp(Buffer.from(await (form.get('mask') as File).arrayBuffer())).metadata();assert.equal(mask.width,1024);assert.equal(mask.hasAlpha,true);
    return Response.json({data:[{b64_json:generated.toString('base64')}]});
  });
  const cloud=modelFromPreset('gpt-image-2-5-sunburst','model_cloud','connection_cloud','gpt-image-2.5-sunburst');cloud.endpoint='https://mask-test.example';cloud.credential_ref='credential_fake';
  const library=new ModelLibrary([...seedModels().filter(m=>m.kind==='mock'),cloud],async()=>{},{has:async()=>true,set:async()=>{},resolve:async()=>'fake-test-secret'},[mockDescription,adapter.description]);
  const root=path.resolve('.local/test-projects');await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'mask-cloud-'));
  const w=new Workspace(library,adapter,undefined,pixels),repo=new ProjectRepository(directory);await w.create(repo,'协议联测');
  const source=path.join(directory,'source.png');await writeFile(source,await png(1024,1024));await w.importFiles([source]);const p=w.project!,recipe=structuredClone(p.recipe);
  const d={...draft(p.assets[0].asset_id,1024,1024),model_config_id:'model_cloud',quality:'xhigh',instruction:'只修改选区'};
  await w.serial(()=>w.enqueueMask(p.project_id,d));await writeFile(source,await png(1024,1024,'#ffffff'));await settle(w);
  assert.equal(p.jobs[0].status,'succeeded',p.jobs[0].error);assert.equal(calls,1);assert.deepEqual(p.recipe,recipe);
  assert.equal(p.jobs[0].execution_plan!.operation,'nativeMaskEdit');assert.equal((await repo.loadModelInput(p.jobs[0].task_id))!.body.encoding,'multipart');
});

test('编辑输出保存失败可恢复；打包及产出恢复保留蒙版、原始返回和本地变体',async()=>{
  const {workspace:w,repo,d,calls}=await fixture();const mainRecipe=structuredClone(w.project!.recipe);const save=repo.saveOutput.bind(repo);let fail=true;
  repo.saveOutput=async(...args)=>{if(fail)throw new Error('模拟磁盘故障');return save(...args);};
  await w.serial(()=>w.enqueueMask(w.project!.project_id,d));await settle(w);const job=w.project!.jobs[0];
  assert.equal(job.status,'succeeded');assert.equal(job.output_asset_ids.length,0);
  await assert.rejects(()=>w.serial(()=>w.reprocessMask(w.project!.project_id,job.task_id,'strict',0)),/磁盘/);
  assert.equal(job.status,'failed');assert.equal((await repo.load()).jobs[0].mask_edit!.raw_asset_ids.length,1);
  fail=false;await w.serial(()=>w.reprocessMask(w.project!.project_id,job.task_id,'strict',0));assert.equal(job.status,'succeeded');assert.equal(calls(),1);
  const natural=await w.serial(()=>w.reprocessMask(w.project!.project_id,job.task_id,'natural',0));
  const out=w.project!.assets.find(a=>a.asset_id===natural)!;assert.equal(out.location.type,'external');if(out.location.type!=='external')throw new Error('expected external');
  const recoveredRepo=new ProjectRepository(path.join(repo.directory,'recovered'));const recovered=await recoveredRepo.recoverOutput(out.location.path);
  assert.equal(recovered.jobs[0].mask_edit!.raw_asset_ids.length,1);assert.equal(recovered.jobs[0].mask_edit!.variants.length,2);assert.deepEqual(recovered.mask_drafts![0],{...d,mode:'natural',feather:0});assert.deepEqual(recovered.recipe,mainRecipe);await recoveredRepo.load();
  await repo.packageProject(w.project!,path.join(repo.directory,'package'));const packed=await new ProjectRepository(path.join(repo.directory,'package')).load();assert.ok(packed.jobs[0].mask_edit);assert.ok(packed.assets.every(a=>a.location.type==='managed'));
});
