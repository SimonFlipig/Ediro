import {Worker} from 'node:worker_threads';

// SQLite and large image I/O run off the Electron/UI thread. DELETE journaling
// leaves one durable document after each commit (no persistent WAL companion).
const workerSource = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {filename,cache}=workerData;
const APP_ID=0x45444952;
const allowed=/^(ediro\.project\.json|assets\/[a-zA-Z0-9_-]+\.(png|jpeg|jpg|webp)|model-inputs\/[a-zA-Z0-9_-]+\.json|pending-results\/[a-zA-Z0-9_-]+\/(result\.json|\d+\.(png|jpeg|webp)))$/;
let revision,identity,version=2,documentStamp,signatures=new Map();
function stamp(){const s=fs.statSync(filename,{bigint:true});return s.mtimeNs+':'+s.ctimeNs+':'+s.size;}
function checkKey(key,size){
  if(!allowed.test(key)||!Number.isSafeInteger(size)||size<0||size>192*1024*1024)throw Error('工程包含非法条目或超大文件。');
  if(key==='ediro.project.json'&&size>20*1024*1024)throw Error('工程记录超过 20 MB。');
}
function metadata(db){
  const format=db.prepare('PRAGMA user_version').get().user_version;
  if(db.prepare('PRAGMA application_id').get().application_id!==APP_ID||![1,2].includes(format))throw Error('不是支持的 Ediro 工程，或工程格式版本较新。');
  return {...db.prepare('SELECT identity,revision FROM document WHERE id=1').get(),version:format};
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Preserve the exact serialized record, including the captured JSON string's
// whitespace, ordering and escapes. Only canonical image Base64 runs become
// binary references. Unknown encodings stay verbatim rather than being guessed.
function splitRequest(bytes){
  const raw=()=>[{bytes,encoding:'raw'}],text=bytes.toString('utf8');
  if(!Buffer.from(text).equals(bytes))return raw();
  let input;try{input=JSON.parse(text);}catch{return raw();}
  if(input?.version!==1||!input.body)return raw();
  let root=input.body;
  if(root.encoding==='json'){try{root=JSON.parse(root.json);}catch{return raw();}}
  const candidates=new Map(),pending=[root];let visited=0;
  while(pending.length){
    if(++visited>50000)return raw();
    const item=pending.pop();if(!item||typeof item!=='object')continue;
    if(/^image\/(png|jpeg|webp)$/.test(item.mimeType??item.mime_type??'')){
      const encoded=item.data_base64??item.data;
      if(typeof encoded==='string'&&encoded.length>=32&&!candidates.has(encoded)){
        const image=Buffer.from(encoded,'base64');
        if(image.toString('base64')===encoded)candidates.set(encoded,image);
      }
    }
    for(const child of Object.values(item))if(child&&typeof child==='object')pending.push(child);
  }
  if(!candidates.size)return raw();
  // Counted RegExp repetitions can exhaust V8's regexp stack on multi-MB
  // Base64 strings. Scan runs iteratively, with constant stack usage.
  const base64Code=code=>(code>=65&&code<=90)||(code>=97&&code<=122)||(code>=48&&code<=57)||code===43||code===47;
  const parts=[];let cursor=0,offset=0;
  while(offset<text.length){
    const start=offset;
    while(offset<text.length&&base64Code(text.charCodeAt(offset)))offset++;
    if(offset===start){offset++;continue;}
    const length=offset-start;
    if(text.charCodeAt(offset)===61){offset++;if(text.charCodeAt(offset)===61)offset++;}
    if(length<32)continue;
    const image=candidates.get(text.slice(start,offset));if(!image)continue;
    if(start>cursor)parts.push({bytes:Buffer.from(text.slice(cursor,start)),encoding:'raw'});
    parts.push({bytes:image,encoding:'base64'});cursor=offset;
    if(parts.length>10000)return raw();
  }
  if(!cursor)return raw();
  if(cursor<text.length)parts.push({bytes:Buffer.from(text.slice(cursor)),encoding:'raw'});
  return parts;
}
function putEntry(db,key,bytes){
  const digest=hash(bytes);
  if(version===1){db.prepare('INSERT INTO entries(name,hash,bytes) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET hash=excluded.hash,bytes=excluded.bytes WHERE hash<>excluded.hash').run(key,digest,bytes);return;}
  if(db.prepare('SELECT hash FROM entries WHERE name=?').get(key)?.hash===digest)return;
  const parts=key.startsWith('model-inputs/')?splitRequest(bytes):[{bytes,encoding:'raw'}];
  db.prepare('INSERT INTO entries(name,hash,size) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET hash=excluded.hash,size=excluded.size').run(key,digest,bytes.length);
  db.prepare('DELETE FROM parts WHERE entry_name=?').run(key);
  const blob=db.prepare('INSERT INTO blobs(hash,bytes) VALUES(?,?) ON CONFLICT(hash) DO NOTHING');
  const part=db.prepare('INSERT INTO parts(entry_name,ordinal,blob_hash,encoding) VALUES(?,?,?,?)');
  for(const [index,piece] of parts.entries()){
    const contentHash=hash(piece.bytes);blob.run(contentHash,piece.bytes);part.run(key,index,contentHash,piece.encoding);
  }
}
function readEntry(db,e){
  let bytes;
  if(version===1)bytes=Buffer.from(db.prepare('SELECT bytes FROM entries WHERE name=?').get(e.name).bytes);
  else{
    // Bound reconstructed size before allocating bytes (including repeated
    // references); a malformed container cannot expand an unbounded request.
    const parts=db.prepare('SELECT p.ordinal,p.blob_hash,p.encoding,length(b.bytes) AS size FROM parts p LEFT JOIN blobs b ON b.hash=p.blob_hash WHERE p.entry_name=? ORDER BY p.ordinal LIMIT 10002').all(e.name);
    if(!parts.length||parts.length>10001)throw Error('工程条目分段数量无效：'+e.name);
    let size=0;
    for(const [index,piece] of parts.entries()){
      if(piece.ordinal!==index||!['raw','base64'].includes(piece.encoding)||!/^[a-f0-9]{64}$/.test(piece.blob_hash)||!Number.isSafeInteger(piece.size)||piece.size<0)throw Error('工程图片引用缺失或无效：'+e.name);
      size+=piece.encoding==='base64'?4*Math.ceil(piece.size/3):piece.size;
      if(size>e.size)throw Error('工程条目展开大小无效：'+e.name);
    }
    if(size!==e.size)throw Error('工程条目展开大小无效：'+e.name);
    const read=db.prepare('SELECT bytes FROM blobs WHERE hash=?'),chunks=[];
    for(const piece of parts){
      const content=Buffer.from(read.get(piece.blob_hash).bytes);
      if(hash(content)!==piece.blob_hash)throw Error('工程内容校验失败：'+e.name);
      chunks.push(piece.encoding==='base64'?Buffer.from(content.toString('base64')):content);
    }
    bytes=Buffer.concat(chunks,size);
  }
  if(bytes.length!==e.size||hash(bytes)!==e.hash)throw Error('工程条目校验失败：'+e.name);
  return bytes;
}
function scan(dir=cache,prefix=''){
  const found=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const key=prefix+entry.name,file=path.join(dir,entry.name);
    if(entry.isSymbolicLink())throw Error('工程缓存不能包含符号链接。');
    if(entry.isDirectory()){
      if(key==='assets'||key==='model-inputs'||key==='pending-results'||/^pending-results\/[a-zA-Z0-9_-]+$/.test(key))found.push(...scan(file,key+'/'));
    }else if(allowed.test(key)){
      const info=fs.statSync(file);checkKey(key,info.size);
      found.push({key,file,size:info.size,stamp:info.mtimeMs+':'+info.ctimeMs+':'+info.size});
    }
  }
  return found;
}
parentPort.on('message',({id,action,optionalPaths=[]})=>{
  let db;
  try{
    if(action==='cache'){
      // Only a performance hint. The document identity, revision, file stamp
      // and every expanded file's stamp must all match before it is reused.
      fs.writeFileSync(path.join(cache,'cache-state.json'),JSON.stringify({identity,revision,version,documentStamp,signatures:[...signatures]}));
      parentPort.postMessage({id,value:revision,version});return;
    }
    if(action==='create'){
      const fd=fs.openSync(filename,'wx');fs.closeSync(fd);
      db=new DatabaseSync(filename);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA application_id='+APP_ID+'; PRAGMA user_version=2; CREATE TABLE document(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL,revision INTEGER NOT NULL); CREATE TABLE entries(name TEXT PRIMARY KEY,hash TEXT NOT NULL,size INTEGER NOT NULL) STRICT; CREATE TABLE blobs(hash TEXT PRIMARY KEY,bytes BLOB NOT NULL) STRICT; CREATE TABLE parts(entry_name TEXT NOT NULL REFERENCES entries(name) ON DELETE CASCADE,ordinal INTEGER NOT NULL,blob_hash TEXT NOT NULL REFERENCES blobs(hash),encoding TEXT NOT NULL CHECK(encoding IN (\'raw\',\'base64\')),PRIMARY KEY(entry_name,ordinal)) STRICT; CREATE INDEX parts_blob_hash ON parts(blob_hash);');
      identity=randomUUID();revision=0;
      db.prepare('INSERT INTO document VALUES(1,?,0)').run(identity);
      parentPort.postMessage({id,value:revision,version});
    }else{
      if(!fs.statSync(filename).isFile())throw Error('工程文件已移动或删除，请重新打开或另存为。');
      db=new DatabaseSync(filename,{timeout:2000});
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON;');
      if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete')throw Error('工程使用了不支持的日志模式，请通过兼容版本另存为。');
      db.exec(action==='load'?'BEGIN':'BEGIN IMMEDIATE');
      const meta=metadata(db);
      if(action==='load'){
        version=meta.version;
        const entries=db.prepare(version===1?'SELECT name,hash,length(bytes) AS size FROM entries':'SELECT name,hash,size FROM entries').all();
        if(entries.length>50000||!entries.some(e=>e.name==='ediro.project.json'))throw Error('工程条目不完整或数量超限。');
        let total=0;
        for(const e of entries){checkKey(e.name,e.size);total+=e.size;}
        if(total>64*1024*1024*1024)throw Error('工程解包超过 64 GB 限制。');
        let hint;try{hint=JSON.parse(fs.readFileSync(path.join(cache,'cache-state.json'),'utf8'));}catch{}
        const existing=scan();
        const reusable=hint&&(hint.version??1)===version&&hint.identity===meta.identity&&hint.revision===meta.revision&&hint.documentStamp===stamp()
          &&JSON.stringify(hint.signatures)===JSON.stringify(existing.map(e=>[e.key,e.stamp]));
        if(!reusable){
          for(const e of existing)fs.unlinkSync(e.file);
          for(const e of entries){
            const bytes=readEntry(db,e);
            const target=path.join(cache,e.name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});
          }
        }
        identity=meta.identity;revision=meta.revision;
        signatures=new Map(scan().map(e=>[e.key,e.stamp]));
      }else if(action==='commit'){
        if(meta.identity!==identity||meta.revision!==revision||meta.version!==version)throw Error('工程已被另一处修改，未覆盖文件；请将当前修改另存为。');
        const entries=scan(),next=new Map(entries.map(e=>[e.key,e.stamp]));
        if(entries.length>50000||entries.reduce((sum,e)=>sum+e.size,0)>64*1024*1024*1024)throw Error('工程条目数量或总大小超过当前限制。');
        if(!next.has('ediro.project.json'))throw Error('工程缺少项目记录。');
        const project=JSON.parse(fs.readFileSync(path.join(cache,'ediro.project.json'),'utf8'));
        const optional=new Set(optionalPaths);
        for(const asset of project.assets){
          const omitted=asset.kind==='output'&&asset.removed_result&&optional.has(asset.location.relative_path);
          if(asset.location.type!=='managed'||(!next.has(asset.location.relative_path)&&!omitted))throw Error('工程素材缺失，未覆盖已保存工程：'+asset.name);
        }
        for(const e of entries)if(signatures.get(e.key)!==e.stamp){
          putEntry(db,e.key,fs.readFileSync(e.file));
        }
        const remove=db.prepare('DELETE FROM entries WHERE name=?');
        for(const key of signatures.keys())if(!next.has(key))remove.run(key);
        if(version===2)db.exec('DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM parts WHERE parts.blob_hash=blobs.hash)');
        db.prepare('UPDATE document SET revision=revision+1 WHERE id=1').run();
        db.exec('COMMIT');revision++;signatures=next;documentStamp=stamp();
        parentPort.postMessage({id,value:revision,version});return;
      }else throw Error('未知工程操作。');
      // Capture while the read transaction still excludes another writer.
      documentStamp=stamp();db.exec('COMMIT');parentPort.postMessage({id,value:revision,version});
    }
  }catch(error){
    if(db?.isTransaction)try{db.exec('ROLLBACK');}catch{}
    parentPort.postMessage({id,error:error.message});
  }finally{db?.close();}
});
`;

export class DocumentDatabase {
  version:1|2=2;
  private worker:Worker;
  private sequence=0;
  private pending=new Map<number,{resolve:(value:number)=>void;reject:(error:Error)=>void}>();
  private failure?:Error;
  constructor(filename:string,cache:string){
    this.worker=new Worker(workerSource,{eval:true,workerData:{filename,cache}});
    this.worker.on('message',({id,value,error,version})=>{
      const request=this.pending.get(id);if(!request)return;
      this.pending.delete(id);if(!this.pending.size)this.worker.unref();
      if(error)request.reject(new Error(error));else{this.version=version;request.resolve(value);}
    });
    this.worker.on('error',error=>this.fail(error));
    this.worker.on('exit',()=>this.fail(new Error('工程存储进程已关闭。')));
    this.worker.unref();
  }
  private fail(error:Error){this.failure=error;for(const p of this.pending.values())p.reject(error);this.pending.clear();}
  run(action:'create'|'load'|'commit'|'cache',optionalPaths:string[]=[]):Promise<number>{
    if(this.failure)return Promise.reject(this.failure);
    return new Promise((resolve,reject)=>{const id=++this.sequence;this.pending.set(id,{resolve,reject});this.worker.ref();this.worker.postMessage({id,action,optionalPaths});});
  }
  async close(){await this.worker.terminate();}
}
