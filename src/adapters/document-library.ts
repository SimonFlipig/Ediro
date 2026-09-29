import {readFile,mkdir,stat,lstat,realpath,writeFile,unlink} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {atomicJson} from './atomic-json.js';
import {DocumentRepository} from './document-repository.js';
import {projectSummary} from '../core/project-summary.js';
import type {ProjectRecord} from '../shared/api.js';
import type {Project} from '../core/domain.js';
import {MAX_STORED_IMAGE_BYTES} from '../core/image-limits.js';

const summarySchema=z.object({title:z.string(),updated_at:z.string(),cover_asset_id:z.string().optional(),result_count:z.number(),status:z.enum(['running','draft','failed','saved','empty'])});
const outputIndexSchema=z.object({stamp:z.string(),outputs:z.array(z.object({asset_id:z.string(),name:z.string(),sha256:z.string(),export_names:z.array(z.string()).optional()}))});
const recordsSchema=z.array(z.object({id:z.string().regex(/^file-[a-f0-9]{12}$/),filename:z.string(),title:z.string(),summary:summarySchema.optional(),output_index:outputIndexSchema.optional()}));
export interface DocumentOutputMatch {record_id:string;filename:string;title:string;asset_id:string;name:string;sha256:string}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function imageHash(filename:string){
  const info=await stat(filename);
  if(!info.isFile()||info.size>MAX_STORED_IMAGE_BYTES||! /\.(png|jpe?g|webp)$/i.test(filename))throw new Error('请选择有效的生成图片。');
  return hash(await readFile(filename));
}
export class DocumentLibrary {
  readonly cacheRoot:string;
  private records:z.infer<typeof recordsSchema>=[];
  private opened=new Map<string,DocumentRepository>();
  constructor(private runtime:string){this.cacheRoot=path.join(runtime,'document-cache');}
  async initialize(){
    try{this.records=recordsSchema.parse(JSON.parse(await readFile(path.join(this.runtime,'project-files.json'),'utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  private async key(filename:string){const resolved=await realpath(filename);return process.platform==='win32'?resolved.toLowerCase():resolved;}
  async register(repo:DocumentRepository,title:string,project?:Project){
    const key=await this.key(repo.filename);
    let entry=this.records.find(r=>(process.platform==='win32'?r.filename.toLowerCase():r.filename)===key);
    if(!entry){entry={id:'file-'+randomBytes(6).toString('hex'),filename:await realpath(repo.filename),title};this.records.push(entry);}else entry.title=title;
    project??=await repo.load();entry.summary=projectSummary(project);
    await this.cacheCover(entry,repo,project);
    const previous=this.opened.get(entry.id);
    if(previous&&previous!==repo)await previous.close();
    this.opened.set(entry.id,repo);await this.save();return entry.id;
  }
  async openFile(filename:string){
    const key=await this.key(filename);
    const entry=this.records.find(r=>(process.platform==='win32'?r.filename.toLowerCase():r.filename)===key);
    if(entry&&this.opened.has(entry.id))return {id:entry.id,repo:this.opened.get(entry.id)!};
    const repo=await DocumentRepository.open(filename,this.cacheRoot);
    const project=await repo.load();return {id:await this.register(repo,project.name,project),repo};
  }
  async forId(id:string){const entry=this.records.find(r=>r.id===id);if(!entry)throw new Error('工程记录不存在。');return (await this.openFile(entry.filename)).repo;}
  private async indexOutputs(entry:z.infer<typeof recordsSchema>[number]){
    const info=await stat(entry.filename),stamp=`${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    if(entry.output_index?.stamp===stamp)return;
    const opened=this.opened.get(entry.id),repo=opened??await DocumentRepository.open(entry.filename,this.cacheRoot);
    try{
      const project=await repo.load(),outputs:z.infer<typeof outputIndexSchema>['outputs']=[];
      for(const asset of project.assets.filter(a=>a.kind==='output'&&!a.removed_result&&!a.hidden_from_results&&project.jobs.some(j=>j.output_asset_ids.includes(a.asset_id)))){
        const sha256=hash(await repo.readAsset(asset));
        const previous=entry.output_index?.outputs.find(o=>o.asset_id===asset.asset_id&&o.sha256===sha256);
        outputs.push({asset_id:asset.asset_id,name:asset.name,sha256,...(previous?.export_names?{export_names:previous.export_names}:{})});
      }
      entry.output_index={stamp,outputs};
    }finally{if(!opened)await repo.close();}
  }
  async recordExport(repo:DocumentRepository,project:Project,assetId:string,filename:string){
    const id=await this.register(repo,project.name,project),entry=this.records.find(r=>r.id===id)!;
    await this.indexOutputs(entry);
    const output=entry.output_index!.outputs.find(o=>o.asset_id===assetId);if(!output)return;
    if(await imageHash(filename)!==output.sha256)throw new Error('导出图片已改变，未登记恢复来源。');
    output.export_names=[...new Set([...(output.export_names??[]),path.basename(filename)])];await this.save();
  }
  async findOutputs(filename:string,hidden=new Set<string>()):Promise<DocumentOutputMatch[]>{
    const sha256=await imageHash(filename),matches:DocumentOutputMatch[]=[],named:DocumentOutputMatch[]=[];
    for(const entry of this.records){
      if(hidden.has(entry.id))continue;
      try{await this.indexOutputs(entry);}catch{/* Missing/unreadable sources cannot restore an image; do not trust a stale index. */continue;}
      for(const output of entry.output_index!.outputs.filter(o=>o.sha256===sha256)){
        const match={record_id:entry.id,filename:entry.filename,title:entry.title,asset_id:output.asset_id,name:output.name,sha256};matches.push(match);
        if(output.name===path.basename(filename)||output.export_names?.includes(path.basename(filename)))named.push(match);
      }
    }
    await this.save();return named.length?named:matches;
  }
  async recoverOutput(match:DocumentOutputMatch,image:string,target:string){
    const source=await this.forId(match.record_id),project=await source.load();
    const asset=project.assets.find(a=>a.asset_id===match.asset_id&&a.kind==='output'&&!a.removed_result&&!a.hidden_from_results);
    const job=project.jobs.find(j=>j.output_asset_ids.includes(match.asset_id));
    if(!asset||!job||hash(await source.readAsset(asset))!==match.sha256||await imageHash(image)!==match.sha256)throw new Error('图片或来源工程已改变，请重新选择恢复。');
    project.recipe=structuredClone(job.mask_edit?.main_recipe_snapshot??job.recipe_snapshot);
    if(job.mask_edit){
      const draft=structuredClone(job.mask_edit.draft),variant=job.mask_edit.variants.find(v=>v.asset_id===asset.asset_id);
      if(variant){draft.mode=variant.mode;draft.feather=variant.feather;if(variant.composite_strokes)draft.strokes=structuredClone(variant.composite_strokes);}
      project.mask_drafts=[draft];
    }
    return DocumentRepository.saveAs(source,project,target,this.cacheRoot);
  }
  async trashTarget(id:string){
    const entry=this.records.find(r=>r.id===id);if(!entry)throw new Error('工程记录不存在。');
    const filename=entry.filename;
    if(!path.isAbsolute(filename)||path.extname(filename).toLowerCase()!=='.ediro')throw new Error('工程文件位置无效，未删除任何文件。');
    try{
      const info=await lstat(filename);
      if(!info.isFile()||info.isSymbolicLink())throw new Error('工程位置已变为目录或链接，请重新打开确认。');
      const actual=await realpath(filename),same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
      if(!same(actual,filename))throw new Error('工程位置已改变，请重新打开确认。');
      return {filename,missing:false};
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {filename,missing:true};throw error;}
  }
  async release(id:string){const repo=this.opened.get(id);if(repo){await repo.close();this.opened.delete(id);}}
  async discardDeletedCache(id:string){
    const entry=this.records.find(r=>r.id===id);if(!entry)return;
    await DocumentRepository.discardCleanCache(entry.filename,this.cacheRoot);
    await unlink(path.join(this.runtime,'document-covers',id+'.webp')).catch(()=>{});
  }
  async releaseExcept(repo:unknown){
    let changed=false;
    for(const [id,open] of this.opened)if(open!==repo){
      const entry=this.records.find(r=>r.id===id);
      // Recent titles/covers are expendable; a failed cache refresh must not
      // strand an already-saved document in a closed repository.
      try{if(entry){const project=await open.load();entry.summary=projectSummary(project);entry.title=entry.summary.title;await this.cacheCover(entry,open,project);changed=true;}}catch{/* Preserve the previous recent summary. */}
      await open.close();this.opened.delete(id);
    }
    if(changed)await this.save().catch(()=>{});
  }
  private save(){return atomicJson(path.join(this.runtime,'project-files.json'),this.records);}
  async list(hidden:Set<string>):Promise<ProjectRecord[]>{
    const records:ProjectRecord[]=[];
    for(const entry of this.records){
      if(hidden.has(entry.id))continue;
      try{
        const info=await stat(entry.filename);
        const open=this.opened.get(entry.id);
        // Unopened files retain a lightweight recent-entry title; opening validates the document.
        if(open){const summary=projectSummary(await open.load());records.push({id:entry.id,...summary,location:entry.filename});}
        else{records.push({id:entry.id,title:entry.title,updated_at:info.mtime.toISOString(),result_count:0,status:'saved',...entry.summary,location:entry.filename});}
      }catch{records.push({id:entry.id,title:entry.title,updated_at:'',result_count:0,status:'unavailable',location:entry.filename});}
    }
    return records;
  }
  private async cacheCover(entry:z.infer<typeof recordsSchema>[number],repo:DocumentRepository,project:Project){
    const assetId=entry.summary?.cover_asset_id;if(!assetId)return;
    const asset=project.assets.find(a=>a.asset_id===assetId);if(!asset)return;
    await mkdir(path.join(this.runtime,'document-covers'),{recursive:true});
    try{await writeFile(path.join(this.runtime,'document-covers',entry.id+'.webp'),await readFile(await repo.resolveAssetPath(asset,true)));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  async cover(id:string,assetId:string){
    const entry=this.records.find(r=>r.id===id);if(!entry)throw new Error('工程记录不存在。');
    const open=this.opened.get(id);
    if(open){const project=await open.load(),asset=project.assets.find(a=>a.asset_id===assetId);if(!asset)throw new Error('封面不存在。');return open.resolveAssetPath(asset,true);}
    if(entry.summary?.cover_asset_id!==assetId)throw new Error('封面不存在。');
    return path.join(this.runtime,'document-covers',entry.id+'.webp');
  }
  async rename(id:string,name:string){const repo=await this.forId(id),project=await repo.load();project.name=name;await repo.save(project);await this.register(repo,name);}
  async create(root:string){
    await mkdir(root,{recursive:true});
    return DocumentRepository.prepare(path.join(root,`未命名工程_${randomBytes(6).toString('hex')}.ediro`),this.cacheRoot);
  }
}
