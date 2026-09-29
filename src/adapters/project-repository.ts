import {MAX_STORED_IMAGE_BYTES,MAX_MODEL_INPUT_BYTES} from '../core/image-limits.js';
import { createHash } from 'node:crypto';
import {constants} from 'node:fs';
import { readFile, writeFile, mkdir, stat, copyFile, realpath, readdir, cp } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { idSchema, recipeSchema, modelConfigSchema, newId, type Asset, type Project, type Job } from '../core/domain.js';
import type { ExecutionResult } from '../core/ports.js';
import { planSummarySchema } from '../core/generation-contract.js';
import { outputGeometrySchema } from '../core/output-geometry.js';
import { modelInputSchema,type ModelInput } from '../core/model-input.js';
import { promptConfigSchema } from '../core/prompt-config.js';
import { maskDraftSchema, maskEditSchema } from '../core/mask.js';
import {atomicJson} from './atomic-json.js';
import {OutputRecords,type OutputRecord} from './output-records.js';
import {optionalRemovedResults} from '../core/project-asset-references.js';
export {atomicJson} from './atomic-json.js';

export const projectFilename = 'ediro.project.json';
const assetSchema = z.object({
  asset_id: idSchema, name: z.string().max(200), thumbnail_path: z.string(),
  location: z.discriminatedUnion('type', [
    z.object({ type: z.literal('managed'), relative_path: z.string().regex(/^(assets|input|internal)\/[a-zA-Z0-9_-]+\.(png|jpeg|jpg|webp)$/) }),
    z.object({ type: z.literal('external'), path: z.string().max(32768).refine(value=>path.isAbsolute(value)&&/\.(png|jpe?g|webp)$/i.test(value),'外部素材路径非法。'), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(MAX_STORED_IMAGE_BYTES), modified_at: z.number() }),
  ]),
  width: z.number().int().positive(), height: z.number().int().positive(), mime_type: z.string(),
  created_at: z.string(), kind: z.enum(['import', 'output', 'generated']),
  hidden_from_materials: z.boolean().optional(), removed_result: z.boolean().optional(), hidden_from_results: z.boolean().optional(),
});
const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(64000), numbered_text:z.string().max(64000).optional(),text_role:z.enum(['instruction','header','user','image_label']).optional(),model_name:z.string().optional(), source_module_id: idSchema, reference_type: z.string(), reference_id: idSchema }),
  z.object({ type: z.literal('image'), asset_id: idSchema,image_name:z.string().optional(),model_name:z.string().optional(), source_module_id: idSchema, reference_type: z.string(), reference_id: idSchema }),
]);
const projectSchema = z.object({
  storage_version:z.literal(1).optional(),
  mask_drafts:z.array(maskDraftSchema).max(20).optional(),
  schema_version: z.union([z.literal(2),z.literal(3)]), project_id: idSchema, name: z.string().min(1).max(100), created_at: z.string(), updated_at: z.string(), recipe: recipeSchema,
  assets: z.array(assetSchema).max(5000),
  jobs: z.array(z.object({
    mask_edit:maskEditSchema.optional(),
    task_id: idSchema, status: z.enum(['queued','preparing','running','post_processing','succeeded','failed','cancelled']),
    stage: z.string(), progress: z.number().min(0).max(100), created_at: z.string(), finished_at: z.string().optional(), error: z.string().optional(),
    recipe_snapshot: recipeSchema,
    chain_snapshot: z.object({format_version:z.literal(2).optional(),prompt_config:promptConfigSchema.optional(), blocks: z.array(blockSchema), mode: z.enum(['text_to_image','reference_generation']) }),
    execution_plan:planSummarySchema.optional(),
    output_geometry:outputGeometrySchema.optional(),
    model_snapshot: z.object({ model_config_id: idSchema, title: z.string(), provider: z.string(), model: z.string(), adapter_id: z.string(), revision: z.number(), kind: z.enum(['mock','local','cloud']),images_compatibility:modelConfigSchema.shape.images_compatibility,gemini_compatibility:modelConfigSchema.shape.gemini_compatibility }),
    adapted_input: z.object({ kind: z.enum(['native_blocks','separated_inputs']), blocks: z.array(blockSchema).optional(), prompt: z.string().optional(), image_asset_ids: z.array(idSchema).optional(), adjustments: z.array(z.string()) }),
    output_asset_ids: z.array(idSchema),
    recoverable_result:z.boolean().optional(),
    execution_summary:z.object({adapter_version:z.number(),capabilities:modelConfigSchema.shape.capabilities,text:z.string().max(64000).optional(),request_id:z.string().max(200).optional(),usage:z.record(z.string(),z.number()).optional(),fee:z.literal('unknown'),actual_formats:z.array(z.enum(['png','jpeg','webp']))}).optional(),
  })).max(5000),
  revisions: z.array(z.object({ revision_id: idSchema, asset_id: idSchema, parent_revision_id: idSchema.optional(), task_id: idSchema, created_at: z.string() })).max(10000),
});

export const outputRecordSchema=z.object({format:z.literal('ediro-output'),version:z.literal(1),output_asset_id:idSchema,project:projectSchema});
export interface ProjectStorage {inputDirectory:string;records:OutputRecords}

export class ProjectRepository {
  constructor(readonly directory: string, readonly outputDirectory=path.join(directory,'output'),readonly storage?:ProjectStorage) {}
  private thumbnail(id:string){return `${this.storage?'internal':'assets'}/${id}_thumb.webp`;}
  ownedPath(relative:string){
    if(!/^(assets|input|internal)\/[a-zA-Z0-9_-]+\.(png|jpeg|jpg|webp)$/.test(relative))throw new Error('项目素材路径非法。');
    return relative.startsWith('input/')&&this.storage?path.join(this.storage.inputDirectory,path.basename(relative)):path.join(this.directory,relative);
  }
  async saveInternalImage(bytes:Buffer,name:string,role:'input'|'internal'='input'):Promise<Asset>{
    if(bytes.length>MAX_STORED_IMAGE_BYTES)throw new Error('编辑素材超过 192 MB 存储限制。');
    const meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();
    if(!['png','jpeg','webp'].includes(meta.format??'')||!meta.width||!meta.height)throw new Error('编辑素材格式无效。');
    await sharp(bytes,{limitInputPixels:40_000_000}).stats();
    const asset_id=newId('asset'),relative_path=`${this.storage?role:'assets'}/${asset_id}.${meta.format}`,thumbnail_path=this.thumbnail(asset_id);
    await mkdir(path.dirname(this.ownedPath(relative_path)),{recursive:true});await mkdir(path.dirname(this.ownedPath(thumbnail_path)),{recursive:true});
    await writeFile(this.ownedPath(relative_path),bytes,{flag:'wx'});
    await sharp(bytes).resize(420,420,{fit:'inside'}).webp({quality:82}).toFile(this.ownedPath(thumbnail_path));
    return {asset_id,name,location:{type:'managed',relative_path},thumbnail_path,width:meta.width,height:meta.height,mime_type:`image/${meta.format}`,created_at:new Date().toISOString(),kind:'generated',hidden_from_results:true,hidden_from_materials:true};
  }
  private modelInputPath(taskId:string){return path.join(this.directory,'model-inputs',`${idSchema.parse(taskId)}.json`);}
  async saveModelInput(taskId:string,input:ModelInput){const parsed=modelInputSchema.parse(input);if(Buffer.byteLength(JSON.stringify(parsed))>MAX_MODEL_INPUT_BYTES)throw new Error('模型输入记录超过 144 MB 限制，未发送请求。');await atomicJson(this.modelInputPath(taskId),parsed);}
  async loadModelInput(taskId:string):Promise<ModelInput|null>{
    const file=this.modelInputPath(taskId);try{if((await stat(file)).size>MAX_MODEL_INPUT_BYTES)throw new Error('模型输入记录超过读取限制。');return modelInputSchema.parse(JSON.parse(await readFile(file,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  }
  async create(project: Project) {
    await mkdir(this.directory, { recursive: true });
    // Refuse to overwrite an existing project or unrelated folder contents.
    const entries = await readdir(this.directory);
    if (entries.length) throw new Error('请选择空文件夹，现有内容不会被覆盖。');
    await mkdir(path.join(this.directory, this.storage?'internal':'assets'), { recursive: true });
    await this.save(project);
  }
  async save(project: Project) {
    const filename=path.join(this.directory,projectFilename);
    const modern=project.recipe.input_strategy!==undefined||project.recipe.core_parameters.version===2||project.jobs.some(j=>j.execution_plan);
    const parsed=projectSchema.parse({...project,...(this.storage?{storage_version:1}:{}),schema_version:modern?3:project.schema_version});
    if(Buffer.byteLength(JSON.stringify(parsed,null,2))>20*1024*1024)throw new Error('工作记录超过 20 MB 存储限制，请新建工作后继续。');
    if(modern){
      try{
        const old=JSON.parse(await readFile(filename,'utf8'));
        if(old.schema_version<3)await copyFile(filename,filename+'.pre-generation-v3.bak',constants.COPYFILE_EXCL).catch(e=>{if(e.code!=='EEXIST')throw e;});
      }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    }
    await atomicJson(filename,parsed);
  }
  async load(): Promise<Project> {
    const file = path.join(this.directory, projectFilename);
    if ((await stat(file)).size > 20 * 1024 * 1024) throw new Error('项目文件过大，无法安全打开。');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    // Explicit v1 -> v2 read migration. Existing owned originals remain owned;
    // no rewriting/deleting originals or guessing their old source locations.
    if (raw.schema_version === 1 && Array.isArray(raw.assets)) {
      raw.schema_version = 2;
      raw.assets = raw.assets.map((a: Record<string, unknown>) => ({ ...a, location: { type: 'managed', relative_path: a.relative_path } }));
    }
    const p = projectSchema.parse(raw);
    const assets = new Set(p.assets.map(a => a.asset_id));
    if (assets.size !== p.assets.length) throw new Error('项目包含重复素材 ID。');
    const checkRecipe = (r: Project['recipe']) => {
      for (const m of r.modules) for (const id of m.asset_ids) if (!assets.has(id)) throw new Error(`项目缺少引用素材 ${id}。`);
    };
    checkRecipe(p.recipe);
    p.jobs.forEach(j => { checkRecipe(j.recipe_snapshot); j.output_asset_ids.forEach(id => { if (!assets.has(id)) throw new Error('历史任务缺少结果素材。'); });
      if(j.mask_edit)for(const id of [j.mask_edit.draft.source_asset_id,j.mask_edit.source_snapshot_id,j.mask_edit.mask_asset_id,...(j.mask_edit.request_source_id?[j.mask_edit.request_source_id]:[]),...(j.mask_edit.guide_asset_id?[j.mask_edit.guide_asset_id]:[]),...j.mask_edit.raw_asset_ids,...j.mask_edit.variants.map(v=>v.asset_id)])if(!assets.has(id))throw new Error('局部编辑任务缺少素材。');
    });
    for (const revision of p.revisions) if (!assets.has(revision.asset_id)) throw new Error('编辑版本缺少素材。');
    for (const asset of p.assets) {
      if (asset.location.type === 'managed') {try{await this.resolveAssetPath(asset,false);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
      // Missing external originals and expendable thumbnails must not prevent
      // opening the input chain/history. Execution reads validate originals.
    }
    return p;
  }
  async resolveAssetPath(asset: Asset, thumbnail: boolean) {
    if (!thumbnail && asset.location.type === 'external') {
      const filename = asset.location.path;
      if (!path.isAbsolute(filename) || !/\.(png|jpe?g|webp)$/i.test(filename)) throw new Error('外部素材路径非法。');
      await this.readExternal(asset); return realpath(filename);
    }
    const relative = thumbnail ? asset.thumbnail_path : asset.location.type === 'managed' ? asset.location.relative_path : '';
    const filename=this.ownedPath(relative);
    const root = await realpath(relative.startsWith('input/')&&this.storage?this.storage.inputDirectory:this.directory);
    const target = await realpath(filename);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('素材不能指向项目目录外部。');
    return target;
  }
  private async readExternal(asset: Asset) {
    if (asset.location.type !== 'external') throw new Error('素材不是外部引用。');
    if (!path.isAbsolute(asset.location.path) || !/\.(png|jpe?g|webp)$/i.test(asset.location.path)) throw new Error('外部素材路径非法。');
    try {
      const info = await stat(asset.location.path);
      if (info.size > MAX_STORED_IMAGE_BYTES) throw new Error('源文件超过导入边界。');
      const bytes = await readFile(asset.location.path);
      if (createHash('sha256').update(bytes).digest('hex') !== asset.location.sha256) throw new Error(`素材「${asset.name}」内容已改变，请重新导入；历史引用不会被替换。`);
      return bytes;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`素材「${asset.name}」已移动或删除，请重新定位。`);
      throw e;
    }
  }
  async sourceStatus(asset: Asset): Promise<'available' | 'missing' | 'changed'> {
    if (asset.location.type === 'managed') {try{await this.resolveAssetPath(asset,false);return 'available';}catch{return 'missing';}}
    try { const info = await stat(asset.location.path); return info.size === asset.location.size && info.mtimeMs === asset.location.modified_at ? 'available' : 'changed'; }
    catch { return 'missing'; }
  }
  async readAsset(asset: Asset) { return asset.location.type === 'external' ? this.readExternal(asset) : readFile(await this.resolveAssetPath(asset, false)); }
  async findOutputRecord(filename:string):Promise<string|undefined>{
    const central=await this.storage?.records.find(filename);if(central)return central;
    const legacy=filename.replace(/\.[^.]+$/,'.json');
    try{if((await stat(legacy)).size>20*1024*1024)throw new Error('产出记录过大。');const record=JSON.parse(await readFile(legacy,'utf8'));return record.format==='ediro-output'?legacy:undefined;}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  }
  async copyAuxiliary(directory:string){
    for(const name of ['model-inputs','pending-results']){
      try{await cp(path.join(this.directory,name),path.join(directory,name),{recursive:true,errorOnExist:false,force:false});}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    }
  }
  // Copy first, verify bytes, then let the caller publish the new manifest.
  // IDs and immutable edit/version snapshots remain unchanged.
  async adoptAssets(project:Project,source:ProjectRepository,ownsExternal:(filename:string)=>boolean=()=>false){
    if(!this.storage)throw new Error('目标没有配置项目存储目录。');
    const moved=new Map<string,string>(),rawIds=new Set(project.jobs.flatMap(j=>j.mask_edit?.raw_asset_ids??[]));
    for(const asset of project.assets){
      const original=structuredClone(asset),oldPath=original.location.type==='managed'?source.ownedPath(original.location.relative_path):original.location.path;
      const owned=original.location.type==='managed'||asset.kind==='generated'||ownsExternal(oldPath);
      let bytes:Buffer|undefined;
      if(owned)try{await stat(oldPath);bytes=await source.readAsset(original);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      if(owned&&bytes){
        if(asset.kind==='output'){
          if(asset.location.type==='managed'){
            const saved=await this.saveOutput(bytes,asset.name,asset.mime_type.split('/')[1] as 'png'|'jpeg'|'webp');asset.location=saved.location;asset.name=saved.name;
          }
        }else{
          const ext=(await sharp(bytes).metadata()).format;
          if(!['png','jpeg','webp'].includes(ext??''))throw new Error('迁移素材格式无效。');
          const relative=`${rawIds.has(asset.asset_id)?'internal':'input'}/${asset.asset_id}.${ext}`,target=this.ownedPath(relative);
          await mkdir(path.dirname(target),{recursive:true});
          try{await writeFile(target,bytes,{flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
          if(!bytes.equals(await readFile(target)))throw new Error('迁移目标已存在不同内容，原记录未切换。');
          asset.location={type:'managed',relative_path:relative};moved.set(oldPath,target);
        }
      }else if(original.location.type==='managed'){
        asset.location={type:'external',path:oldPath,sha256:'0'.repeat(64),size:0,modified_at:0};
      }
      asset.thumbnail_path=this.thumbnail(asset.asset_id);
      await mkdir(path.dirname(this.ownedPath(asset.thumbnail_path)),{recursive:true});
      if(bytes)await sharp(bytes).rotate().resize(420,420,{fit:'inside'}).webp({quality:82}).toFile(this.ownedPath(asset.thumbnail_path));
      else try{const thumbnail=await source.resolveAssetPath(original,true),destination=this.ownedPath(asset.thumbnail_path);if(path.resolve(thumbnail)!==path.resolve(destination))await copyFile(thumbnail,destination);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    }
    project.storage_version=1;return moved;
  }
  async importImage(filename: string): Promise<Asset> {
    filename = await realpath(filename);
    if (!/\.(png|jpe?g|webp)$/i.test(filename)) throw new Error('只接受 PNG、JPEG、WebP 图片文件。');
    const info = await stat(filename);
    if (!info.isFile() || info.size > MAX_STORED_IMAGE_BYTES) throw new Error(`${path.basename(filename)} 超过本地 192 MB 导入限制。`);
    const bytes = await readFile(filename);
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!['png','jpeg','webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height) throw new Error('第一阶段只导入 PNG、JPEG、WebP 图片。');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const asset_id = `asset_${createHash('sha256').update(filename).update(sha256).digest('hex').slice(0, 24)}`;
    const ext = metadata.format === 'jpeg' ? 'jpeg' : metadata.format;
    const thumbnail_path = this.thumbnail(asset_id);
    await mkdir(path.dirname(this.ownedPath(thumbnail_path)), { recursive: true });
    await sharp(bytes).rotate().resize(420, 420, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(this.ownedPath(thumbnail_path));
    return { asset_id, name: path.basename(filename).slice(0, 200), location: { type: 'external', path: filename, sha256, size: info.size, modified_at: info.mtimeMs }, thumbnail_path, width: metadata.width, height: metadata.height,
      mime_type: `image/${ext}`, created_at: new Date().toISOString(), kind: 'import' };
  }
  async saveOutput(bytes: Buffer, name: string, format: 'png' | 'jpeg' | 'webp'): Promise<Asset> {
    const asset_id = newId('asset');
    const thumbnail_path = this.thumbnail(asset_id);
    if(bytes.length>MAX_STORED_IMAGE_BYTES)throw new Error('输出图片超过当前 192 MB 存储边界。');
    const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!['png','jpeg','webp'].includes(meta.format ?? '') || meta.format !== format || !meta.width || !meta.height) throw new Error('输出图片格式与声明不一致。');
    await mkdir(path.dirname(this.ownedPath(thumbnail_path)), { recursive: true });
    const now=new Date(),pad=(v:number)=>String(v).padStart(2,'0');
    name=`Ediro_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${asset_id.slice(-8)}.${format}`;
    await mkdir(this.outputDirectory,{recursive:true});
    const filename=path.resolve(this.outputDirectory,name);
    await writeFile(filename,bytes,{flag:'wx'});
    const info=await stat(filename);
    await sharp(bytes).resize(420,420,{fit:'inside'}).webp({quality:82}).toFile(path.join(this.directory, thumbnail_path));
    return { asset_id, name, location: { type: 'external', path: filename, sha256:createHash('sha256').update(bytes).digest('hex'),size:info.size,modified_at:info.mtimeMs }, thumbnail_path, width: meta.width!, height: meta.height!, mime_type: `image/${format}`, created_at: new Date().toISOString(), kind: 'output' };
  }
  private pendingDirectory(id:string){return path.join(this.directory,'pending-results',idSchema.parse(id));}
  async stageResult(job:Job,result:ExecutionResult){
    const directory=this.pendingDirectory(job.task_id);await mkdir(directory,{recursive:true});
    const images=[];
    for(let i=0;i<result.images.length;i++){const image=result.images[i],file=`${i}.${image.format}`;await writeFile(path.join(directory,file),image.bytes);images.push({file,format:image.format,width:image.width,height:image.height});}
    await atomicJson(path.join(directory,'result.json'),{images,text:result.text,request_id:result.request_id,usage:result.usage});
  }
  async pendingResult(id:string):Promise<ExecutionResult>{
    const directory=this.pendingDirectory(id),data=z.object({images:z.array(z.object({file:z.string().regex(/^\d+\.(png|jpeg|webp)$/),format:z.enum(['png','jpeg','webp']),width:z.number().int().positive(),height:z.number().int().positive()})).min(1).max(10),text:z.string().max(64000).optional(),request_id:z.string().max(200).optional(),usage:z.record(z.string(),z.number()).optional()}).parse(JSON.parse(await readFile(path.join(directory,'result.json'),'utf8')));
    const images=[];for(const image of data.images){const bytes=await readFile(path.join(directory,image.file)),meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();if(meta.format!==image.format||meta.width!==image.width||meta.height!==image.height)throw new Error('待恢复产物校验失败。');images.push({...image,bytes});}return {...data,images};
  }
  async clearPendingResult(id:string){
    const {unlink,rmdir}=await import('node:fs/promises'),directory=this.pendingDirectory(id);
    for(const name of await readdir(directory)){if(name==='result.json'||/^\d+\.(png|jpeg|webp)$/.test(name))await unlink(path.join(directory,name));}
    await rmdir(directory);
  }
  async saveOutputRecords(project: Project,job: Job) {
    const snapshot=structuredClone(project);snapshot.recipe=structuredClone(job.mask_edit?.main_recipe_snapshot??job.recipe_snapshot);
    // Externalize owned tool/legacy references so sidecars do not depend on the
    // internal work-record directory. Missing originals retain a tombstone path.
    for(const asset of snapshot.assets)if(asset.location.type==='managed'){
      const filename=this.ownedPath(asset.location.relative_path);
      let bytes:Buffer|undefined,info;
      try{bytes=await this.readAsset(asset);info=await stat(filename);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      asset.location={type:'external',path:filename,sha256:bytes?createHash('sha256').update(bytes).digest('hex'):'0'.repeat(64),size:info?.size??0,modified_at:info?.mtimeMs??0};
    }
    for(const id of job.output_asset_ids){
      const asset=snapshot.assets.find(a=>a.asset_id===id)!;
      if(asset.removed_result||asset.location.type!=='external')continue;
      const filename=asset.location.path;
      const record:OutputRecord={format:'ediro-output',version:1,output_asset_id:id,project:projectSchema.parse({...snapshot,schema_version:job.execution_plan?3:snapshot.schema_version})};
      if(this.storage)await this.storage.records.save(record);else await atomicJson(filename.replace(/\.[^.]+$/,'.json'),record);
    }
  }
  async consolidateOutputs(project: Project) {
    const next=structuredClone(project);let changed=false;
    for(const asset of next.assets)if(asset.kind==='output'&&asset.location.type==='managed'&&!asset.removed_result){
      let bytes;try{bytes=await this.readAsset(asset);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
      const format=asset.mime_type.split('/')[1];if(!['png','jpeg','webp'].includes(format))throw new Error('旧结果格式不支持。');
      const saved=await this.saveOutput(bytes,asset.name,format as 'png'|'jpeg'|'webp');
      asset.location=saved.location;asset.name=saved.name;changed=true;
    }
    if(changed){await this.save(next);Object.assign(project,next);for(const job of project.jobs)if(job.status==='succeeded')await this.saveOutputRecords(project,job);}
    // Migration copies only: originals stay untouched for safe rollback.
  }
  async recoverOutput(filename: string): Promise<Project> {
    await mkdir(this.directory,{recursive:true});if((await readdir(this.directory)).length)throw new Error('恢复产出需要空的工作目录，不会覆盖已有记录。');
    if(!path.isAbsolute(filename)||!/\.(png|jpe?g|webp)$/i.test(filename))throw new Error('请选择生成图片。');
    const jsonFile=await this.findOutputRecord(filename);
    if(!jsonFile)throw new Error('没有找到这张图片的恢复记录，请保留 Project 目录或打开项目包。');
    if((await stat(jsonFile)).size>20*1024*1024)throw new Error('产出记录过大。');
    const record=outputRecordSchema.parse(JSON.parse(await readFile(jsonFile,'utf8')));
    const project=record.project;
    const output=project.assets.find(a=>a.asset_id===record.output_asset_id&&a.kind==='output');
    if(!output||output.location.type!=='external')throw new Error('图片与产出记录不匹配。');
    // Never overwrite an unrelated image under an old recorded path.
    if((await stat(filename)).size>MAX_STORED_IMAGE_BYTES)throw new Error('产出图片超过当前 192 MB 边界。');
    const bytes=await readFile(filename);
    if(createHash('sha256').update(bytes).digest('hex')!==output.location.sha256)throw new Error('图片内容与产出记录不一致。');
    const info=await stat(filename);output.location.path=path.resolve(filename);output.location.modified_at=info.mtimeMs;
    const ids=new Set(project.assets.map(a=>a.asset_id));
    if(ids.size!==project.assets.length)throw new Error('产出记录包含重复素材身份。');
    for(const recipe of [project.recipe,...project.jobs.map(j=>j.recipe_snapshot)])for(const m of recipe.modules)for(const id of m.asset_ids)if(!ids.has(id))throw new Error('产出记录缺少素材身份。');
    const job=project.jobs.find(j=>j.output_asset_ids.includes(output.asset_id));
    if(!job)throw new Error('产出记录缺少当前结果的生成任务。');
    project.recipe=structuredClone(job.mask_edit?.main_recipe_snapshot??job.recipe_snapshot);
    const needed=new Set([output.asset_id,...project.recipe.modules.flatMap(m=>m.asset_ids),...job.chain_snapshot.blocks.filter(b=>b.type==='image').map(b=>b.asset_id),...(job.adapted_input.blocks??[]).filter(b=>b.type==='image').map(b=>b.asset_id),...(job.adapted_input.image_asset_ids??[])]);
    if(job.mask_edit)for(const id of [job.mask_edit.draft.source_asset_id,job.mask_edit.source_snapshot_id,job.mask_edit.mask_asset_id,...(job.mask_edit.request_source_id?[job.mask_edit.request_source_id]:[]),...(job.mask_edit.guide_asset_id?[job.mask_edit.guide_asset_id]:[]),...job.mask_edit.raw_asset_ids,...job.mask_edit.variants.map(v=>v.asset_id)])needed.add(id);
    project.mask_drafts=job.mask_edit?[structuredClone(job.mask_edit.draft)]:[];
    if(job.mask_edit){
      const variant=job.mask_edit.variants.find(v=>v.asset_id===output.asset_id);
      if(variant){
        project.mask_drafts[0].mode=variant.mode;project.mask_drafts[0].feather=variant.feather;
        if(variant.mode==='strict')job.mask_edit.composite_strokes=structuredClone(variant.composite_strokes??job.mask_edit.draft.strokes);
      }
    }
    project.assets=project.assets.filter(a=>needed.has(a.asset_id));
    for(const asset of project.assets)if(asset.kind==='output')asset.hidden_from_results=asset.asset_id!==output.asset_id;
    job.output_asset_ids=[output.asset_id];project.jobs=[job];
    project.revisions=project.revisions.filter(r=>job.mask_edit?needed.has(r.asset_id):r.asset_id===output.asset_id&&r.task_id===job.task_id);
    const revisionIds=new Set(project.revisions.map(r=>r.revision_id));
    for(const revision of project.revisions)if(revision.parent_revision_id&&!revisionIds.has(revision.parent_revision_id))delete revision.parent_revision_id;
    if(job.mask_edit?.parent_revision_id&&!revisionIds.has(job.mask_edit.parent_revision_id))delete job.mask_edit.parent_revision_id;
    project.project_id=newId('project');project.updated_at=new Date().toISOString();
    await mkdir(path.join(this.directory,this.storage?'internal':'assets'),{recursive:true});
    for(const asset of project.assets){
      if(asset.location.type!=='external')throw new Error('产出记录不能包含内部相对素材。');
      asset.thumbnail_path=this.thumbnail(asset.asset_id);
      try{await sharp(await this.readAsset(asset)).rotate().resize(420,420,{fit:'inside'}).webp({quality:82}).toFile(path.join(this.directory,asset.thumbnail_path));}catch{ /* Structure remains recoverable; originals are revalidated before generation. */ }
    }
    if(this.storage)await this.adoptAssets(project,new ProjectRepository(this.directory));
    await this.save(project);return project;
  }
  async trashResult(project: Project,assetId: string,trash: (filename:string)=>Promise<void>) {
    const asset=project.assets.find(a=>a.asset_id===assetId&&a.kind==='output');
    if(!asset)throw new Error('生成结果不存在。');
    const filename=asset.location.type==='external'?asset.location.path:path.resolve(this.directory,asset.location.relative_path);
    const root=await realpath(asset.location.type==='external'?this.outputDirectory:path.join(this.directory,'assets'));
    if(asset.location.type==='external'&&!/^Ediro_\d{8}_\d{6}_[a-zA-Z0-9]+\.(png|jpeg|webp)$/.test(path.basename(filename)))throw new Error('不是 Ediro 管理的产出文件。');
    const targets=[filename,filename.replace(/\.[^.]+$/,'.json')];
    const validated:string[]=[];
    for(const target of targets){try{const resolved=await realpath(target);if(!resolved.startsWith(`${root}${path.sep}`))throw new Error('不能删除产出目录以外的文件。');if(target===filename)await this.readAsset(asset);validated.push(resolved);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
    if(this.storage){try{validated.push(await this.storage.records.validatedPath(asset.asset_id,filename));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
    for(const target of validated){
      try{await trash(target);}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error(`回收站操作未完成：${e instanceof Error?e.message:'失败'}。不会永久删除；部分文件可能已在回收站。`);}
    }
    if(this.storage)await this.storage.records.forget(asset.asset_id,filename);
    const previous=asset.removed_result;asset.removed_result=true;
    try{await this.save(project);}catch(e){asset.removed_result=previous;throw e;}
  }
  async relinkImage(asset: Asset, filename: string): Promise<Asset> {
    if (asset.location.type !== 'external') throw new Error('只有外部素材引用需要重新定位。');
    const replacement = await this.importImage(filename);
    if (replacement.location.type !== 'external' || replacement.location.sha256 !== asset.location.sha256) throw new Error('请选择同一份原图；内容不同请作为新素材导入，避免改写历史。');
    return { ...asset, ...replacement, asset_id: asset.asset_id, name: asset.name, created_at: asset.created_at, kind:asset.kind };
  }
  async packageInto(project:Project,parent:string):Promise<string>{
    await mkdir(parent,{recursive:true});
    const root=await realpath(parent);
    // Auxiliary folders are copied recursively; never put their destination inside them.
    for(const folder of ['model-inputs','pending-results']){
      const source=await realpath(path.join(this.directory,folder)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return undefined;});
      if(source&&(root===source||root.startsWith(`${source}${path.sep}`)))throw new Error('请选择实际请求与待恢复数据目录以外的打包位置。');
    }
    const name=project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,60).replace(/[. ]+$/,'')||'项目';
    const date=new Date(),pad=(n:number)=>String(n).padStart(2,'0');
    const stamp=`${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    for(let version=1;version<=1000;version++){
      const directory=path.join(root,`${name}_${stamp}${version===1?'':`_${version}`}`);
      try{await mkdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')continue;throw error;}
      await this.packageProject(project,directory);
      return directory;
    }
    throw new Error('此位置已有过多同名项目包，请换一个文件夹。');
  }
  async packageProject(project: Project, directory: string) {
    await mkdir(directory, { recursive: true });
    if ((await readdir(directory)).length) throw new Error('打包另存请选择空文件夹；不会覆盖已有内容。');
    const packed = structuredClone(project);delete packed.storage_version;
    const optional=optionalRemovedResults(project);
    await mkdir(path.join(directory, 'assets'));
    for (const asset of packed.assets) {
      if(optional.has(asset.asset_id)){
        const filename=asset.location.type==='external'?asset.location.path:this.ownedPath(asset.location.relative_path);
        let missing=false;
        try{await stat(filename);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing=true;}
        if(missing){
          const original=structuredClone(asset),format=asset.mime_type.split('/')[1];
          if(!['png','jpeg','webp'].includes(format))throw new Error('已删除结果的格式不支持。');
          // Keep the deleted asset's identity, task and revision as a tombstone.
          // Never substitute its thumbnail for the missing original pixels.
          asset.location={type:'managed',relative_path:`assets/${asset.asset_id}.${format}`};
          asset.thumbnail_path=`assets/${asset.asset_id}_thumb.webp`;
          try{await copyFile(await this.resolveAssetPath(original,true),path.join(directory,asset.thumbnail_path));}
          catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
          continue;
        }
      }
      const bytes = await this.readAsset(asset), format = (await sharp(bytes).metadata()).format;
      if (!['png','jpeg','webp'].includes(format ?? '')) throw new Error('打包素材格式不支持。');
      const relative_path = `assets/${asset.asset_id}.${format}`;
      asset.location = { type: 'managed', relative_path };
      asset.thumbnail_path = `assets/${asset.asset_id}_thumb.webp`;
      await writeFile(path.join(directory, relative_path), bytes, { flag: 'wx' });
      await sharp(bytes).rotate().resize(420,420,{fit:'inside'}).webp({quality:82}).toFile(path.join(directory,asset.thumbnail_path));
    }
    // Publish the manifest last; the current workspace stays unchanged.
    await this.copyAuxiliary(directory);
    await new ProjectRepository(directory).save(packed);
  }
  async forkWorkspace(project: Project, directory: string, target?:ProjectRepository) {
    await mkdir(directory,{recursive:true});
    if((await readdir(directory)).length)throw new Error('恢复工作记录需要空的内部目录。');
    await mkdir(path.join(directory,'assets'));
    const fork=structuredClone(project);fork.project_id=newId('project');
    const optional=optionalRemovedResults(project);
    for(const asset of fork.assets){
      asset.thumbnail_path=`assets/${asset.asset_id}_thumb.webp`;
      if(optional.has(asset.asset_id)){
        const filename=asset.location.type==='external'?asset.location.path:this.ownedPath(asset.location.relative_path);
        let missing=false;try{await stat(filename);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing=true;}
        if(missing){
          const original=project.assets.find(a=>a.asset_id===asset.asset_id)!;
          const format=asset.mime_type.split('/')[1];if(!['png','jpeg','webp'].includes(format))throw new Error('已删除结果的格式不支持。');
          asset.location={type:'managed',relative_path:`assets/${asset.asset_id}.${format}`};
          try{await copyFile(await this.resolveAssetPath(original,true),path.join(directory,asset.thumbnail_path));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
          continue;
        }
      }
      if(asset.kind==='import'){
        if(asset.location.type==='managed'){
          const filename=await this.resolveAssetPath(asset,false),bytes=await this.readAsset(asset),info=await stat(filename);
          asset.location={type:'external',path:filename,sha256:createHash('sha256').update(bytes).digest('hex'),size:info.size,modified_at:info.mtimeMs};
          await sharp(bytes).rotate().resize(420,420,{fit:'inside'}).webp({quality:82}).toFile(path.join(directory,asset.thumbnail_path));
        }else{
          const original=project.assets.find(a=>a.asset_id===asset.asset_id)!;
          try { await copyFile(await this.resolveAssetPath(original,true),path.join(directory,asset.thumbnail_path)); }
          catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        }
      }else{
        const bytes=await this.readAsset(asset),format=(await sharp(bytes).metadata()).format;
        if(!['png','jpeg','webp'].includes(format??''))throw new Error('工作结果格式不支持。');
        const relative_path=`assets/${asset.asset_id}.${format}`;asset.location={type:'managed',relative_path};
        await writeFile(path.join(directory,relative_path),bytes,{flag:'wx'});
        await sharp(bytes).resize(420,420,{fit:'inside'}).webp({quality:82}).toFile(path.join(directory,asset.thumbnail_path));
      }
    }
    await this.copyAuxiliary(directory);
    if(target?.storage)await target.adoptAssets(fork,new ProjectRepository(directory));
    await (target??new ProjectRepository(directory)).save(fork);
    if(target?.storage)for(const job of fork.jobs)if(job.status==='succeeded'&&job.output_asset_ids.length)await target.saveOutputRecords(fork,job);
  }
  async export(asset: Asset, filename: string) {
    const source = await this.resolveAssetPath(asset, false);
    const parent = await realpath(path.dirname(path.resolve(filename)));
    let destination = path.join(parent, path.basename(filename));
    try { destination = await realpath(destination); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const root = await realpath(this.directory);
    const inputRoot=this.storage?await realpath(this.storage.inputDirectory).catch(()=>path.resolve(this.storage!.inputDirectory)):undefined;
    if (destination === root || destination.startsWith(`${root}${path.sep}`)||inputRoot&&(destination===inputRoot||destination.startsWith(`${inputRoot}${path.sep}`))) throw new Error('导出不能覆盖项目原始素材或工程数据。');
    await copyFile(source, filename);
  }
}
