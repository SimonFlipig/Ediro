import {readFile,readdir,stat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {idSchema,type Project} from '../core/domain.js';
import {MAX_STORED_IMAGE_BYTES} from '../core/image-limits.js';
import {atomicJson} from './atomic-json.js';

export interface OutputRecord {format:'ediro-output';version:1;output_asset_id:string;project:Project}
const entrySchema=z.object({id:idSchema,name:z.string().max(200),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
type Entry=z.infer<typeof entrySchema>;

// The index is disposable. Each record retains its identity and image hash.
export class OutputRecords {
  private cache?:Entry[];
  constructor(readonly directory:string){}
  filename(id:string,name:string){const suffix=createHash('sha256').update(path.basename(name)).digest('hex').slice(0,16);return path.join(this.directory,`${idSchema.parse(id)}_${suffix}.json`);}
  async read(filename:string):Promise<unknown>{
    if((await stat(filename)).size>20*1024*1024)throw new Error('产出恢复记录超过读取上限。');
    return JSON.parse(await readFile(filename,'utf8'));
  }
  private entry(record:OutputRecord):Entry{
    const asset=record.project.assets.find(a=>a.asset_id===record.output_asset_id&&a.kind==='output');
    if(asset?.location.type!=='external')throw new Error('恢复记录缺少产出图片。');
    return entrySchema.parse({id:asset.asset_id,name:path.basename(asset.location.path),sha256:asset.location.sha256});
  }
  private async entries(){
    if(this.cache)return this.cache;
    try{this.cache=z.array(entrySchema).parse(await this.read(path.join(this.directory,'index.json')));}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
      this.cache=[];
      for(const name of await readdir(this.directory).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;})){
        if(!/^asset_[a-zA-Z0-9_-]+\.json$/.test(name))continue;
        const record=await this.read(path.join(this.directory,name)) as OutputRecord;
        if(record.format!=='ediro-output'||record.version!==1)throw new Error('产出恢复记录格式无效。');
        const entry=this.entry(record);if(name!==path.basename(this.filename(entry.id,entry.name)))throw new Error('产出恢复记录身份不匹配。');
        this.cache.push(entry);
      }
    }
    return this.cache;
  }
  async save(record:OutputRecord){
    const entries=await this.entries(),entry=this.entry(record);
    const filename=this.filename(entry.id,entry.name);await atomicJson(filename,record);
    const next=[...entries.filter(e=>e.id!==entry.id||e.name!==entry.name),entry];
    await atomicJson(path.join(this.directory,'index.json'),next);this.cache=next;
    return filename;
  }
  async find(image:string):Promise<string|undefined>{
    const entries=await this.entries();
    const named=entries.filter(e=>e.name===path.basename(image));
    if(named.length===1)return this.filename(named[0].id,named[0].name);
    if(!(await stat(image)).isFile()||(await stat(image)).size>MAX_STORED_IMAGE_BYTES)return;
    const hash=createHash('sha256').update(await readFile(image)).digest('hex');
    const candidates=(named.length?named:entries).filter(e=>e.sha256===hash);
    if(candidates.length>1)throw new Error('多份记录对应相同图片，请从项目记录打开，或使用原文件名恢复。');
    return candidates[0]?this.filename(candidates[0].id,candidates[0].name):undefined;
  }
  async forget(id:string,image:string){
    const next=(await this.entries()).filter(e=>e.id!==id||e.name!==path.basename(image));
    await atomicJson(path.join(this.directory,'index.json'),next);this.cache=next;
  }
  async validatedPath(id:string,image:string){
    const root=await realpath(this.directory),file=await realpath(this.filename(id,image));
    if(path.dirname(file)!==root)throw new Error('恢复记录不能指向记录目录外。');
    return file;
  }
}
