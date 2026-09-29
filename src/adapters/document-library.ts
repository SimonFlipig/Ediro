import {readFile,mkdir,stat,lstat,realpath,writeFile,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {atomicJson} from './atomic-json.js';
import {DocumentRepository} from './document-repository.js';
import {projectSummary} from '../core/project-summary.js';
import type {ProjectRecord} from '../shared/api.js';
import type {Project} from '../core/domain.js';

const summarySchema=z.object({title:z.string(),updated_at:z.string(),cover_asset_id:z.string().optional(),result_count:z.number(),status:z.enum(['running','draft','failed','saved','empty'])});
const recordsSchema=z.array(z.object({id:z.string().regex(/^file-[a-f0-9]{12}$/),filename:z.string(),title:z.string(),summary:summarySchema.optional()}));
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
