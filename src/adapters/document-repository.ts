import {mkdir,mkdtemp,readFile,writeFile,stat,rename,unlink,rm,rmdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import {ProjectRepository,projectFilename} from './project-repository.js';
import {DocumentDatabase} from './document-database.js';
import {newId,type Project,type Asset,type Job} from '../core/domain.js';
import type {ExecutionResult} from '../core/ports.js';
import type {ModelInput} from '../core/model-input.js';
import {atomicJson} from './atomic-json.js';
import {optionalRemovedResults} from '../core/project-asset-references.js';
import {outputFilename} from '../core/output-name.js';
import {inspectDocumentTarget,sameDocumentFile,type DocumentSaveTarget} from './document-save-target.js';

/** The document is authoritative; this private cache is disposable after a
 * successful commit. Failed writes keep it for recovery, never silently fall back. */
export class DocumentRepository extends ProjectRepository {
  private database:DocumentDatabase;
  private writes:Promise<unknown>=Promise.resolve();
  private dirty=false;
  private closed=false;
  private cacheable=false;
  get storageVersion(){return this.database.version;}
  get filename(){return this.documentFilename;}
  private constructor(private documentFilename:string,directory:string,readonly cacheRoot:string){
    super(directory);this.database=new DocumentDatabase(documentFilename,directory);
  }
  static async prepare(filename:string,cacheRoot:string){
    await mkdir(cacheRoot,{recursive:true});
    const directory=await mkdtemp(path.join(cacheRoot,'document-'));
    return new DocumentRepository(path.resolve(filename),directory,cacheRoot);
  }
  static async open(filename:string,cacheRoot:string){
    const repo=await this.prepare(filename,cacheRoot);
    let reused=false;
    // Atomically claim a clean cache: two open documents never share a working
    // directory. Missing/deleted caches simply take the normal verified path.
    await rmdir(repo.directory);
    try{await rename(repo.cacheSlot(),repo.directory);reused=true;}
    catch{await mkdir(repo.directory);}
    try{await repo.database.run('load');await repo.load();repo.cacheable=true;return repo;}
    catch(error){
      await repo.close();
      if(reused){const fresh=await this.prepare(filename,cacheRoot);try{await fresh.database.run('load');await fresh.load();fresh.cacheable=true;return fresh;}catch(cause){await fresh.close();throw cause;}}
      throw error;
    }
  }
  private cacheSlot(){
    return DocumentRepository.cacheSlot(this.filename,this.cacheRoot);
  }
  private static cacheSlot(filename:string,cacheRoot:string){
    const key=process.platform==='win32'?filename.toLowerCase():filename;
    return path.join(cacheRoot,'cached-'+createHash('sha256').update(key).digest('hex'));
  }
  static async discardCleanCache(filename:string,cacheRoot:string){
    const root=path.resolve(cacheRoot),target=path.resolve(this.cacheSlot(filename,cacheRoot));
    if(path.dirname(target)!==root||!/^cached-[a-f0-9]{64}$/.test(path.basename(target)))throw new Error('非法工程缓存位置。');
    await rm(target,{recursive:true,force:true}).catch(()=>{});
  }
  override async create(project:Project){
    await mkdir(path.dirname(this.filename),{recursive:true});
    await this.database.run('create');await mkdir(path.join(this.directory,'assets'));
    await this.save(project);
  }
  override async load(){
    const project=await super.load();
    if(project.assets.some(a=>a.location.type!=='managed'))throw new Error('单文件工程不能依赖外部素材。');
    const optional=optionalRemovedResults(project);
    for(const asset of project.assets){
      try{await this.resolveAssetPath(asset,false);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||!optional.has(asset.asset_id))throw error;}
    }
    return project;
  }
  private serial<T>(operation:()=>Promise<T>){
    const task=this.writes.then(operation);this.writes=task.catch(()=>{});return task;
  }
  private async markDirty(){this.dirty=true;await atomicJson(path.join(this.directory,'recovery.json'),{filename:this.filename,dirty:true});}
  private async commit(){
    await this.markDirty();
    const project:Project=JSON.parse(await readFile(path.join(this.directory,projectFilename),'utf8')),optional=optionalRemovedResults(project);
    const optionalPaths=project.assets.flatMap(asset=>optional.has(asset.asset_id)&&asset.location.type==='managed'?[asset.location.relative_path]:[]);
    await this.database.run('commit',optionalPaths);
    this.dirty=false;this.cacheable=true;await atomicJson(path.join(this.directory,'recovery.json'),{filename:this.filename,dirty:false});
  }
  override async save(project:Project){
    const snapshot=structuredClone(project);delete snapshot.storage_version;
    if(snapshot.assets.some(a=>a.location.type!=='managed'))throw new Error('请先将所有素材收入工程，再保存单文件工程。');
    return this.serial(async()=>{await this.markDirty();await super.save(snapshot);await this.commit();});
  }
  override async importImage(filename:string):Promise<Asset>{
    const imported=await super.importImage(filename),bytes=await super.readAsset(imported);
    const relative_path=`assets/${imported.asset_id}.${imported.mime_type.split('/')[1]}`;
    await writeFile(path.join(this.directory,relative_path),bytes);
    return {...imported,location:{type:'managed',relative_path}};
  }
  override async saveOutput(bytes:Buffer,name:string,format:'png'|'jpeg'|'webp'):Promise<Asset>{
    const meta=await sharp(bytes).metadata();if(meta.format!==format)throw new Error('结果格式与声明不一致。');
    const asset=await this.saveInternalImage(bytes,name);
    return {...asset,name:outputFilename(asset),kind:'output',hidden_from_results:false,hidden_from_materials:false};
  }
  override async saveOutputRecords(_project:Project,_job:Job){/* History lives in this document; exports are independent images. */}
  override async consolidateOutputs(_project:Project){/* Never externalize embedded results. */}
  override async saveModelInput(taskId:string,input:ModelInput){
    await this.serial(async()=>{await super.saveModelInput(taskId,input);await this.commit();});
  }
  override async stageResult(job:Job,result:ExecutionResult){
    await this.serial(async()=>{await this.markDirty();await super.stageResult(job,result);await this.commit();});
  }
  override async clearPendingResult(taskId:string){
    await this.serial(async()=>{await super.clearPendingResult(taskId);await this.commit();});
  }
  override async trashResult(project:Project,assetId:string,_trash:(filename:string)=>Promise<void>){
    const asset=project.assets.find(a=>a.asset_id===assetId&&a.kind==='output');
    if(!asset)throw new Error('结果不存在。');
    // Keep immutable history and its pixels usable by downstream references.
    const previous=asset.removed_result;asset.removed_result=true;
    try{await this.save(project);}catch(error){asset.removed_result=previous;throw error;}
  }
  static async saveAs(source:ProjectRepository,project:Project,filename:string,cacheRoot:string,options?:{preserveIdentity?:boolean;overwrite?:DocumentSaveTarget}){
    const target=path.resolve(filename);
    if(path.extname(target).toLowerCase()!=='.ediro')throw new Error('工程文件须使用 .ediro 扩展名。');
    if(source instanceof DocumentRepository&&await sameDocumentFile(source.filename,target)){
      await source.save(project);return source;
    }
    const expected=options?.overwrite;
    const verifyTarget=async()=>{
      const current=await inspectDocumentTarget(target);
      if(expected){if(expected.filename!==target||current?.stamp!==expected.stamp)throw new Error('目标工程在确认后发生变化，未覆盖文件，请重新另存为。');}
      else if(current)throw new Error('此工程文件已存在，请确认覆盖后重试。');
    };
    await verifyTarget();
    await mkdir(path.dirname(target),{recursive:true});
    const temporary=target+'.'+newId('save')+'.tmp';
    const repo=await this.prepare(temporary,cacheRoot);
    try{
      await source.packageProject(project,repo.directory);
      const packed=await new ProjectRepository(repo.directory).load();if(!options?.preserveIdentity)packed.project_id=newId('project');
      await repo.database.run('create');await repo.save(packed);
      // Read and validate the actual SQLite container before touching the target.
      await repo.database.run('load');await repo.load();
      await repo.database.run('relocate',[],target);repo.documentFilename=target;
      await atomicJson(path.join(repo.directory,'recovery.json'),{filename:target,dirty:true});
      await verifyTarget();
      // Replacing an existing file is a single rename, never unlink-then-write.
      // New destinations still use an exclusive reservation to reject races.
      if(!expected)await writeFile(target,Buffer.alloc(0),{flag:'wx'});
      try{await rename(temporary,target);}catch(error){if(!expected)await unlink(target).catch(()=>{});throw error;}
      repo.dirty=false;repo.cacheable=true;
      // Publication is already complete. Failure to clear this disposable hint
      // must not report a failed save or roll back a successfully replaced file.
      await atomicJson(path.join(repo.directory,'recovery.json'),{filename:target,dirty:false}).catch(()=>{});
      return repo;
    }catch(error){repo.dirty=false;repo.cacheable=false;await repo.close();await unlink(temporary).catch(()=>{});throw error;}
  }
  static async recoverable(cacheRoot:string){
    const result:{directory:string;filename:string}[]=[];
    for(const entry of await readdir(cacheRoot,{withFileTypes:true}).catch(()=>[])){
      if(!entry.isDirectory()||!/^document-[a-zA-Z0-9]+$/.test(entry.name))continue;
      const directory=path.join(cacheRoot,entry.name);
      try{
        const metadata=JSON.parse(await readFile(path.join(directory,'recovery.json'),'utf8'));
        if(metadata.dirty===true&&typeof metadata.filename==='string'){await stat(path.join(directory,projectFilename));result.push({directory,filename:metadata.filename});}
      }catch{/* An incomplete cache is not a valid recovery candidate. */}
    }
    return result;
  }
  async close(){
    if(this.closed)return;this.closed=true;
    await this.writes;
    let retain=false;
    if(!this.dirty&&this.cacheable&&path.extname(this.filename).toLowerCase()==='.ediro'){
      try{await this.database.run('cache');retain=true;}catch{/* A cache failure must not block closing a saved document. */}
    }
    await this.database.close();
    if(!this.dirty){
      const root=path.resolve(this.cacheRoot),target=path.resolve(this.directory);
      if(path.dirname(target)!==root||!path.basename(target).startsWith('document-'))throw new Error('非法工程缓存位置。');
      if(retain){try{await rename(target,this.cacheSlot());return;}catch{/* Another instance may already have left a clean cache. */}}
      await rm(target,{recursive:true,force:true}).catch(()=>{}); // Expendable cache cleanup must not invalidate a saved document.
    }
  }
}
