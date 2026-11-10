import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Application-local diagnostics only. Never attach these records to a Job or project.
export interface GenerationFailureRecord {
  timestamp:string;
  task_id:string;
  model:string;
  adapter_id:string;
  duration_ms:number;
  stage:string;
  reason:string;
  timeout_ms?:number;
  http_status?:number;
  received_bytes?:number;
  upstream_request_id?:string;
  error_name?:string;
  error_code?:string;
}

const limit=50,maxLineBytes=4096,maxReadBytes=256*1024;
const queues=new Map<string,Promise<void>>();
function text(value:unknown,maximum:number){return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,maximum):undefined;}
function nonnegative(value:unknown){return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;}
function sanitize(value:unknown):GenerationFailureRecord|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const input=value as Record<string,unknown>,stamp=typeof input.timestamp==='string'?Date.parse(input.timestamp):NaN;
  const task_id=text(input.task_id,120),model=text(input.model,200),adapter_id=text(input.adapter_id,120),stage=text(input.stage,80),reason=text(input.reason,80),duration_ms=nonnegative(input.duration_ms);
  if(!Number.isFinite(stamp)||!task_id||!model||!adapter_id||!stage||!reason||duration_ms===undefined)return null;
  const record:GenerationFailureRecord={timestamp:new Date(stamp).toISOString(),task_id,model,adapter_id,duration_ms,stage,reason};
  for(const key of ['timeout_ms','received_bytes'] as const){const number=nonnegative(input[key]);if(number!==undefined)record[key]=number;}
  const status=input.http_status;if(typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599)record.http_status=status;
  for(const key of ['upstream_request_id','error_name','error_code'] as const){const string=text(input[key],key==='upstream_request_id'?200:80);if(string)record[key]=string;}
  return record;
}
function serialize(records:GenerationFailureRecord[]){return records.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).slice(-limit).map(record=>JSON.stringify(record)).join('\n')+(records.length?'\n':'');}

export class GenerationFailureLog {
  readonly filename:string;
  constructor(runtimeDirectory:string){this.filename=path.resolve(runtimeDirectory,'logs','generation-errors.jsonl');}
  private serial(action:()=>Promise<void>){
    const key=process.platform==='win32'?this.filename.toLowerCase():this.filename;
    const work=(queues.get(key)??Promise.resolve()).then(action);
    const settled=work.catch(()=>{});queues.set(key,settled);
    void settled.then(()=>{if(queues.get(key)===settled)queues.delete(key);});
    return work;
  }
  private async read(){
    let file;try{file=await open(this.filename,'r');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    try{
      const size=(await file.stat()).size,offset=Math.max(0,size-maxReadBytes),buffer=Buffer.alloc(size-offset);
      let read=0;while(read<buffer.length){const result=await file.read(buffer,read,buffer.length-read,offset+read);if(!result.bytesRead)break;read+=result.bytesRead;}
      const raw=buffer.subarray(0,read).toString('utf8');
      // A bounded tail may begin in the middle of a JSON line or UTF-8 character.
      const complete=offset?raw.slice(raw.indexOf('\n')+1):raw;
      const records:GenerationFailureRecord[]=[];
      for(const line of complete.split('\n')){
        if(!line.trim()||Buffer.byteLength(line)>maxLineBytes)continue;
        try{const record=sanitize(JSON.parse(line));if(record)records.push(record);}catch{/* Discard incomplete or malformed diagnostics. */}
      }
      return {raw,records,truncated:offset>0};
    }finally{await file.close();}
  }
  private async write(contents:string){
    await mkdir(path.dirname(this.filename),{recursive:true});
    const temporary=`${this.filename}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,contents,{encoding:'utf8',flag:'wx'});await rename(temporary,this.filename);}
    finally{await unlink(temporary).catch(()=>{});}
  }
  initialize(){return this.serial(async()=>{
    const existing=await this.read();if(!existing)return;
    const contents=serialize(existing.records);if(existing.truncated||contents!==existing.raw)await this.write(contents);
  });}
  append(record:GenerationFailureRecord){
    // Rebuild an explicit allowlist, including when callers pass richer objects.
    const safe=sanitize(record);if(!safe)return Promise.reject(new Error('生成失败诊断字段无效。'));
    return this.serial(async()=>{const existing=await this.read();await this.write(serialize([...(existing?.records??[]),safe]));});
  }
}
