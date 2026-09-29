import path from 'node:path';
import { rm } from 'node:fs/promises';
import { newId, type Project } from '../core/domain.js';
import { ProjectRepository } from './project-repository.js';
import { DocumentRepository } from './document-repository.js';

// Empty work lives only in memory. Image validation may stage disposable files;
// the first successful material import or queued job publishes one document.
export class DraftRepository extends ProjectRepository {
  readonly transient=true;
  private project?:Project;
  constructor(private scratchRoot:string,private projectRoot:string,private cacheRoot:string,private attach:(repo:DocumentRepository)=>void){
    super(path.join(scratchRoot,newId('draft')));
  }
  override async create(project:Project){this.project=structuredClone(project);}
  override async load(){if(!this.project)throw new Error('空白工作尚未准备。');return structuredClone(this.project);}
  override async save(project:Project){
    if(!project.assets.length&&!project.jobs.length){this.project=structuredClone(project);return;}
    const filename=path.join(this.projectRoot,`未命名工程_${newId('file').slice(5)}.ediro`);
    const repo=await DocumentRepository.saveAs(this,project,filename,this.cacheRoot,{preserveIdentity:true});
    // Keep the workspace object and task IDs stable while replacing external
    // staging references with the document's embedded asset locations.
    Object.assign(project,await repo.load());this.attach(repo);
    await this.close().catch(()=>{});
  }
  async close(){
    const root=path.resolve(this.scratchRoot),target=path.resolve(this.directory);
    if(path.dirname(target)!==root||!/^draft_[a-f0-9]{16}$/.test(path.basename(target)))throw new Error('非法空白工作缓存位置。');
    await rm(target,{recursive:true,force:true});
  }
}
