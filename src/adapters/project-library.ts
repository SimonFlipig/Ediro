import {readFile,readdir,mkdir,mkdtemp,stat,lstat,copyFile,unlink,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {ProjectRepository,projectFilename,outputRecordSchema} from './project-repository.js';
import {OutputRecords} from './output-records.js';
import {atomicJson} from './atomic-json.js';
import {projectSummary} from '../core/project-summary.js';
import type {Project} from '../core/domain.js';

const workId=z.string().regex(/^work-[a-zA-Z0-9]{6}$/);
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';

export class ProjectLibrary {
  readonly directory:string;
  readonly outputDirectory:string;
  readonly records:OutputRecords;
  private summaries=new Map<string,{stamp:string;value:ReturnType<typeof projectSummary>}>();
  constructor(readonly root:string,readonly runtimeDirectory=path.join(root,'.local','runtime')){
    this.directory=path.join(root,'Project');this.outputDirectory=path.join(root,'output');
    this.records=new OutputRecords(path.join(this.directory,'recovery'));
  }
  repository(directory:string){return new ProjectRepository(directory,this.outputDirectory,{inputDirectory:path.join(this.root,'input',path.basename(directory)),records:this.records});}
  forId(id:string){return this.repository(path.join(this.directory,workId.parse(id)));}
  async createDirectory(){await mkdir(this.directory,{recursive:true});return mkdtemp(path.join(this.directory,'work-'));}
  async trashTarget(id:string){
    const filename=this.forId(id).directory;
    try{
      const info=await lstat(filename);
      if(!info.isDirectory()||info.isSymbolicLink())throw new Error('旧工程位置已变为文件或链接，未删除。');
      const root=await realpath(this.directory),actual=await realpath(filename);
      if(path.dirname(actual)!==root||path.basename(actual)!==id)throw new Error('不能删除项目目录以外的文件夹。');
      // Legacy folders can be sources for another project's external assets.
      // Check even hidden projects: removing a recent entry did not delete them.
      for(const entry of await readdir(this.directory,{withFileTypes:true})){
        if(!entry.isDirectory()||entry.name===id||!workId.safeParse(entry.name).success)continue;
        let raw;
        try{raw=JSON.parse(await readFile(path.join(this.directory,entry.name,projectFilename),'utf8'));}
        catch(error){if(missing(error))continue;throw new Error('其他旧工程记录无法读取，暂时不能确认素材依赖。');}
        if(!raw||!Array.isArray(raw.assets))throw new Error('其他旧工程素材记录无效，暂时不能确认素材依赖。');
        for(const asset of raw.assets){
          if(asset.location?.type!=='external'||typeof asset.location.path!=='string')continue;
          const resolved=await realpath(asset.location.path).catch(()=>path.resolve(asset.location.path));
          const relative=path.relative(actual,resolved);
          if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error(`旧工程「${raw.name??entry.name}」仍引用此文件夹中的素材，暂不能删除，请先处理这处引用。`);
        }
      }
      return {filename,missing:false};
    }catch(error){if(missing(error))return {filename,missing:true};throw error;}
  }
  async list(hidden=new Set<string>()){
    const entries=await readdir(this.directory,{withFileTypes:true}).catch(e=>{if(missing(e))return [];throw e;});
    const result=[];
    for(const entry of entries){
      if(!entry.isDirectory()||!workId.safeParse(entry.name).success||hidden.has(entry.name))continue;
      const filename=path.join(this.directory,entry.name,projectFilename);
      try{
        const info=await stat(filename),stamp=`${info.mtimeMs}:${info.size}`;
        let cached=this.summaries.get(entry.name);
        if(cached?.stamp!==stamp){const project=await this.forId(entry.name).load();cached={stamp,value:projectSummary(project)};this.summaries.set(entry.name,cached);}
        result.push({id:entry.name,...cached.value});
      }catch(e){result.push({id:entry.name,title:entry.name,updated_at:'',status:'unavailable' as const,result_count:0,cover_asset_id:undefined});}
    }
    return result.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
  }
  async rename(id:string,name:string){
    const repository=this.forId(id),project=await repository.load();
    project.name=z.string().trim().min(1).max(100).parse(name);await repository.save(project);
  }
  async cover(id:string,assetId:string){
    const repository=this.forId(id),project=await repository.load();
    const asset=project.assets.find(a=>a.asset_id===assetId);if(!asset)throw new Error('项目封面不存在。');
    return repository.resolveAssetPath(asset,true);
  }
  // Run before opening the active project. Old workspaces remain untouched;
  // only validated Ediro sidecars leave output, with byte-for-byte backups.
  async migrate(active?:string,excluded=new Set<string>()){
    await mkdir(this.directory,{recursive:true});
    const legacyRoot=path.join(this.runtimeDirectory,'workspaces'),moved=new Map<string,string>();
    const mapFile=path.join(this.directory,'migration-backup','paths.json');
    try{for(const [from,to] of z.array(z.tuple([z.string(),z.string()])).parse(JSON.parse(await readFile(mapFile,'utf8'))))moved.set(from,to);}catch(e){if(!missing(e))throw e;}
    const report={version:1,completed_at:'',projects:[] as string[],records:0,unavailable:[] as string[]};
    const owns=(filename:string)=>{const relative=path.relative(legacyRoot,filename);return !relative.startsWith('..')&&!path.isAbsolute(relative)&&/^work-[a-zA-Z0-9]{6}[\\/]assets[\\/][a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(relative);};
    const legacy=await readdir(legacyRoot,{withFileTypes:true}).catch(e=>{if(missing(e))return [];throw e;});
    for(const entry of legacy){
      if(!entry.isDirectory()||!workId.safeParse(entry.name).success||excluded.has(entry.name))continue;
      const from=new ProjectRepository(path.join(legacyRoot,entry.name),this.outputDirectory),to=this.forId(entry.name);
      try{await stat(path.join(to.directory,projectFilename));continue;}catch(e){if(!missing(e))throw e;}
      let project:Project;
      try{project=await from.load();}catch(e){report.unavailable.push(entry.name);if(active&&path.resolve(active)===path.resolve(from.directory))throw new Error(`当前项目无法迁移：${entry.name}。原文件已保留。`);await mkdir(to.directory,{recursive:true});continue;}
      await mkdir(to.directory,{recursive:true});
      const ownedOutputJobs=project.jobs.filter(j=>j.output_asset_ids.some(id=>project.assets.some(a=>a.asset_id===id&&a.kind==='output'&&a.location.type==='managed'))).map(j=>j.task_id);
      for(const [oldFile,newFile] of await to.adoptAssets(project,from,owns))moved.set(oldFile,newFile);
      await atomicJson(mapFile,[...moved]);
      await from.copyAuxiliary(to.directory);
      await to.save(project);await to.load();report.projects.push(entry.name);
      for(const job of project.jobs)if(ownedOutputJobs.includes(job.task_id))await to.saveOutputRecords(project,job);
    }
    const sidecars:string[]=await readdir(this.outputDirectory).catch(e=>{if(missing(e))return [];throw e;});
    for(const name of sidecars){
      if(!name.endsWith('.json'))continue;
      const filename=path.join(this.outputDirectory,name);
      let raw:unknown;try{raw=await this.records.read(filename);}catch{report.unavailable.push(`output/${name}`);continue;}
      if(!raw||typeof raw!=='object'||!('format' in raw)||raw.format!=='ediro-output')continue;
      const record=outputRecordSchema.parse(raw);
      // Historical snapshots can outlive their original workspace. Collect any
      // remaining owned images in an archive identified by the project ID.
      const archive=this.repository(path.join(this.directory,`archive-${record.project.project_id}`));
      const unresolved=record.project.assets.filter(a=>a.location.type==='external'&&!moved.has(a.location.path)&&(a.kind==='generated'||owns(a.location.path)));
      if(unresolved.length){
        const partial={...record.project,assets:structuredClone(unresolved)};
        for(const [oldFile,newFile] of await archive.adoptAssets(partial,new ProjectRepository(archive.directory),owns))moved.set(oldFile,newFile);
        await atomicJson(mapFile,[...moved]);
      }
      for(const asset of record.project.assets){
        if(asset.location.type!=='external')throw new Error('旧产出记录包含不能迁移的内部路径，原记录已保留。');
        const target=moved.get(asset.location.path);if(!target)continue;
        const bytes=await readFile(target),info=await stat(target);
        const hash=createHash('sha256').update(bytes).digest('hex');
        if(hash!==asset.location.sha256)throw new Error('历史素材与迁移副本不一致，原记录已保留。');
        asset.location={type:'external',path:target,sha256:hash,size:info.size,modified_at:info.mtimeMs};
      }
      const savedRecord=await this.records.save(record);
      const verified=outputRecordSchema.parse(await this.records.read(savedRecord));
      if(JSON.stringify(verified)!==JSON.stringify(record))throw new Error('产出记录迁移校验失败。');
      await this.archiveOutputFile(filename);report.records++;
    }
    // Legacy tool reference images also used to be written into output.
    // Repoint every migrated project and recovery snapshot before archiving them.
    const tools=[...moved].filter(([oldFile])=>path.dirname(path.resolve(oldFile))===path.resolve(this.outputDirectory)&&sidecars.includes(path.basename(oldFile)));
    if(tools.length&&!report.unavailable.length){
      const redirects=new Map(tools);
      const redirect=async(project:Project)=>{let changed=false;for(const asset of project.assets){if(asset.location.type!=='external')continue;const target=redirects.get(asset.location.path);if(!target)continue;const bytes=await readFile(target),info=await stat(target);if(createHash('sha256').update(bytes).digest('hex')!==asset.location.sha256)throw new Error('旧工具引用内容不一致，未清理原图。');asset.location={...asset.location,path:target,size:info.size,modified_at:info.mtimeMs};changed=true;}return changed;};
      for(const entry of await readdir(this.directory)){if(!workId.safeParse(entry).success)continue;const repo=this.forId(entry);let project;try{project=await repo.load();}catch{continue;}if(await redirect(project))await repo.save(project);}
      for(const name of await readdir(this.records.directory).catch(e=>{if(missing(e))return [];throw e;})){if(!/^asset_[a-zA-Z0-9_-]+\.json$/.test(name))continue;const record=outputRecordSchema.parse(await this.records.read(path.join(this.records.directory,name)));if(await redirect(record.project))await this.records.save(record);}
      for(const [filename] of tools)await this.archiveOutputFile(filename);
    }
    report.completed_at=new Date().toISOString();
    if(report.projects.length||report.records||report.unavailable.length)await atomicJson(path.join(this.directory,'migration-backup',`report-${Date.now()}.json`),report);
    if(active&&path.dirname(path.resolve(active))===path.resolve(legacyRoot)){
      if(excluded.has(path.basename(active)))return undefined;
      const destination=this.forId(path.basename(active)).directory;
      await stat(path.join(destination,projectFilename));
      const pointer=path.join(this.runtimeDirectory,'active-workspace.json');
      await mkdir(path.join(this.directory,'migration-backup'),{recursive:true});
      try{await copyFile(pointer,path.join(this.directory,'migration-backup','active-workspace.json'),constants.COPYFILE_EXCL);}catch(e){if(!missing(e)&&(e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
      return destination;
    }
    return active;
  }
  private async archiveOutputFile(filename:string){
    let original:string;try{original=await realpath(filename);}catch(e){if(missing(e))return;throw e;}
    const outputRoot=await realpath(this.outputDirectory);
    if(path.dirname(original)!==outputRoot)throw new Error('不能迁移 output 之外的文件。');
    const backup=path.join(this.directory,'migration-backup','output',path.basename(filename));await mkdir(path.dirname(backup),{recursive:true});
    try{await copyFile(original,backup,constants.COPYFILE_EXCL);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    if(!(await readFile(original)).equals(await readFile(backup)))throw new Error('迁移备份与原文件不同，未移除原文件。');
    await unlink(original);
  }
}
