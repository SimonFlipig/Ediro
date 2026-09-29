import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir,rename,unlink,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {DocumentRepository} from '../src/adapters/document-repository.js';
import {DocumentLibrary} from '../src/adapters/document-library.js';
import {ProjectRepository,projectFilename} from '../src/adapters/project-repository.js';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {MockGenerator} from '../src/adapters/mock-generator.js';
import {ModuleRegistry} from '../src/core/modules.js';
import {MaskPixels} from '../src/adapters/mask-pixels.js';
import type {CloudExecutionPort} from '../src/core/ports.js';
import type {MaskDraft} from '../src/core/mask.js';
import {optionalRemovedResults} from '../src/core/project-asset-references.js';
import type {ModelInput} from '../src/core/model-input.js';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function workspace(delay=0,executor:CloudExecutionPort=new MockGenerator(1)){return new Workspace(new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}}),executor,new ModuleRegistry(),new MaskPixels(),delay);}
async function fixture(delay=0){
  const root=path.join(process.cwd(),'.local','test-documents');await mkdir(root,{recursive:true});const base=await mkdtemp(path.join(root,'case-'));
  const filename=path.join(base,'工程.ediro'),cache=path.join(base,'cache');
  const repo=await DocumentRepository.prepare(filename,cache),w=workspace(delay);await w.create(repo,'单文件测试');
  return {base,filename,cache,repo,w};
}
async function image(base:string){const filename=path.join(base,'source.png');const bytes=await sharp({create:{width:24,height:20,channels:3,background:'#cd7788'}}).png().toBuffer();await writeFile(filename,bytes);return {filename,bytes};}
async function settle(w:Workspace){for(let i=0;i<200;i++){if(await w.serial(async()=>w.project!.jobs.every(j=>['succeeded','failed','cancelled'].includes(j.status))))return;await pause(20);}throw Error('任务等待超时');}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const capture=(body:ModelInput['body']):ModelInput=>({version:1,adapter_id:'fixture',captured_at:'2026-09-24T00:00:00Z',route:'/fixture',body});

test('单张大图编码超过 8 MB 时保存与另存为不耗尽调用栈，重开逐字节一致',async()=>{
  const {base,filename,cache,repo,w}=await fixture();
  const bytes=await sharp(randomBytes(1536*1536*3),{raw:{width:1536,height:1536,channels:3}}).png().toBuffer(),encoded=bytes.toString('base64');
  assert.ok(encoded.length>8*1024*1024);
  const source=path.join(base,'large.png');await writeFile(source,bytes);await w.importFiles([source]);
  const records:ModelInput[]=[
    capture({encoding:'json',json:JSON.stringify({contents:[{parts:[{text:'大图前后保持原文'},{inlineData:{mimeType:'image/png',data:encoded}},{inlineData:{mimeType:'image/png',data:encoded}}]}]})}),
    capture({encoding:'multipart',fields:[{name:'image[]',value:{filename:'large.png',mime_type:'image/png',data_base64:encoded}}]}),
  ];
  for(const [index,record] of records.entries())await repo.saveModelInput('large_'+index,record);
  const copy=await DocumentRepository.saveAs(repo,w.project!,path.join(base,'copy.ediro'),cache);
  for(const [index,record] of records.entries())assert.deepEqual(await copy.loadModelInput('large_'+index),record);
  await copy.close();await repo.close();
  const opened=await DocumentRepository.open(filename,path.join(base,'fresh-cache'));
  for(const [index,record] of records.entries())assert.deepEqual(await opened.loadModelInput('large_'+index),record);
  assert.deepEqual(await opened.readAsset((await opened.load()).assets[0]),bytes);
  const db=new DatabaseSync(filename,{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM blobs WHERE hash=?').get(digest(bytes))!.n,1);assert.equal(db.prepare("SELECT count(*) AS n FROM parts WHERE blob_hash=? AND encoding='base64'").get(digest(bytes))!.n,3);db.close();await opened.close();
});

test('同一原图跨素材身份与十次实际请求只存一份字节，重开请求逐字节一致',async()=>{
  const {base,filename,cache,repo,w}=await fixture();
  const bytes=await sharp(randomBytes(256*256*3),{raw:{width:256,height:256,channels:3}}).png().toBuffer(),source=path.join(base,'noise.png');await writeFile(source,bytes);
  await w.importFiles([source]);const duplicate=await repo.saveInternalImage(bytes,'另一素材身份');w.project!.assets.push(duplicate);await w.persist();
  const before=(await stat(filename)).size,encoded=bytes.toString('base64'),records=new Map<string,Buffer>();
  for(let i=0;i<10;i++){
    const id='repeat_'+i,input=capture({encoding:'json',json:'{ "contents": [{"parts": [{"text":"场景 '+i+' 🌿"},{"inlineData":{"mimeType":"image/png","data":"'+encoded+'"}},{"inlineData":{"mimeType":"image/png","data":"'+encoded+'"}}]}], "value":1.00 }'});
    await repo.saveModelInput(id,input);records.set(id,await readFile(path.join(repo.directory,'model-inputs',id+'.json')));
  }
  const db=new DatabaseSync(filename,{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM blobs WHERE hash=?').get(digest(bytes))!.n,1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM parts WHERE blob_hash=? AND encoding='base64'").get(digest(bytes))!.n,20);
  assert.equal(db.prepare("SELECT count(*) AS n FROM parts WHERE blob_hash=? AND entry_name LIKE 'assets/%'").get(digest(bytes))!.n,2);db.close();
  assert.ok((await stat(filename)).size-before<bytes.length,'重复请求不能按原图大小增长');
  await repo.close();await unlink(source);
  const opened=await DocumentRepository.open(filename,path.join(base,'fresh-cache'));
  for(const [id,expected] of records){assert.deepEqual(await readFile(path.join(opened.directory,'model-inputs',id+'.json')),expected);assert.deepEqual(await opened.loadModelInput(id),JSON.parse(expected.toString()));}
  assert.deepEqual(await opened.readAsset((await opened.load()).assets[0]),bytes);await opened.close();
});

test('multipart 同名字段、蒙版、模拟请求与非标准编码完整往返',async()=>{
  const {base,filename,repo}=await fixture();const {bytes}=await image(base),encoded=bytes.toString('base64');
  const records:ModelInput[]=[
    capture({encoding:'multipart',fields:[{name:'prompt',value:'第一行\n第二行'},{name:'image[]',value:{filename:'甲.png',mime_type:'image/png',data_base64:encoded}},{name:'image[]',value:{filename:'乙.png',mime_type:'image/png',data_base64:encoded}},{name:'mask',value:{filename:'mask.png',mime_type:'image/png',data_base64:encoded}}]}),
    capture({encoding:'simulation',blocks:[{text:'提示词'},{inlineData:{mimeType:'image/png',data:encoded}},{mask:{mimeType:'image/png',data:encoded}}]}),
    capture({encoding:'json',json:JSON.stringify({inlineData:{mimeType:'image/png',data:encoded}}).replaceAll('/','\\/')}),
    capture({encoding:'json',json:'{"unknown":"'+encoded+'","order":1,"order":2}'}),
  ];
  for(const [index,record] of records.entries())await repo.saveModelInput('record_'+index,record);
  const db=new DatabaseSync(filename,{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM blobs WHERE hash=?').get(digest(bytes))!.n,1);db.close();await repo.close();
  const opened=await DocumentRepository.open(filename,path.join(base,'fresh-cache'));for(const [index,record] of records.entries())assert.deepEqual(await opened.loadModelInput('record_'+index),record);await opened.close();
});

test('请求独有图片按最后一个引用释放，仍被素材引用的图片保留',async()=>{
  const {base,filename,repo,w}=await fixture();const {bytes,filename:source}=await image(base);await w.importFiles([source]);
  const requestOnly=await sharp({create:{width:28,height:26,channels:3,background:'#55aa33'}}).png().toBuffer();
  const record=(image:Buffer)=>capture({encoding:'simulation',blocks:[{inlineData:{mimeType:'image/png',data:image.toString('base64')}}]});
  await repo.saveModelInput('first',record(requestOnly));await repo.saveModelInput('second',record(requestOnly));await repo.saveModelInput('first',record(bytes));
  let db=new DatabaseSync(filename,{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM blobs WHERE hash=?').get(digest(requestOnly))!.n,1);db.close();
  await unlink(path.join(repo.directory,'model-inputs','second.json'));await w.persist();
  db=new DatabaseSync(filename,{readOnly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM blobs WHERE hash=?').get(digest(requestOnly))!.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM blobs WHERE hash=?').get(digest(bytes))!.n,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();await repo.close();
});

test('v1 原位编辑保留旧格式，另存为去重副本且源文件不变',async()=>{
  const {base,repo,w}=await fixture();const {bytes,filename:source}=await image(base);await w.importFiles([source]);
  const input=capture({encoding:'simulation',blocks:[{inlineData:{mimeType:'image/png',data:bytes.toString('base64')}}]});await repo.saveModelInput('old_task',input);
  const oldFile=path.join(base,'old.ediro'),db=new DatabaseSync(oldFile);
  db.exec('PRAGMA application_id=0x45444952; PRAGMA user_version=1; CREATE TABLE document(id INTEGER PRIMARY KEY,identity TEXT,revision INTEGER); CREATE TABLE entries(name TEXT PRIMARY KEY,hash TEXT,bytes BLOB)');db.prepare('INSERT INTO document VALUES(1,?,1)').run(randomUUID());
  const files=[projectFilename,...(await readdir(path.join(repo.directory,'assets'))).map(name=>'assets/'+name),'model-inputs/old_task.json'];
  for(const key of files){const data=await readFile(path.join(repo.directory,key));db.prepare('INSERT INTO entries VALUES(?,?,?)').run(key,digest(data),data);}db.close();
  const old=await DocumentRepository.open(oldFile,path.join(base,'old-cache'));assert.equal(old.storageVersion,1);const project=await old.load();project.name='仍可编辑旧版';await old.save(project);await old.saveModelInput('another_task',input);assert.deepEqual(await old.loadModelInput('old_task'),input);
  const before=await readFile(oldFile),copy=await DocumentRepository.saveAs(old,await old.load(),path.join(base,'dedup.ediro'),path.join(base,'new-cache'));assert.equal(copy.storageVersion,2);
  assert.deepEqual(await readFile(oldFile),before);assert.deepEqual(await copy.loadModelInput('old_task'),input);assert.deepEqual(await copy.loadModelInput('another_task'),input);
  const check=new DatabaseSync(copy.filename,{readOnly:true});assert.equal(check.prepare('SELECT count(*) AS n FROM blobs WHERE hash=?').get(digest(bytes))!.n,1);check.close();await old.close();await copy.close();await repo.close();
});

test('去重工程缺少共享图片或分段顺序损坏时拒绝打开',async()=>{
  const {base,filename,cache,repo}=await fixture();const {bytes}=await image(base);await repo.saveModelInput('only',capture({encoding:'simulation',blocks:[{inlineData:{mimeType:'image/png',data:bytes.toString('base64')}}]}));await repo.close();
  const original=await readFile(filename);let db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=OFF');db.prepare('DELETE FROM blobs WHERE hash=?').run(digest(bytes));db.close();await assert.rejects(()=>DocumentRepository.open(filename,cache),/引用缺失/);
  await writeFile(filename,original);db=new DatabaseSync(filename);db.exec("UPDATE parts SET ordinal=ordinal+100 WHERE entry_name='model-inputs/only.json'");db.close();await assert.rejects(()=>DocumentRepository.open(filename,cache),/引用缺失|无效/);
});

test('分段写入中途失败时整笔回滚，不留下半条请求或孤立图片',async()=>{
  const {base,filename,cache,repo}=await fixture();const {bytes}=await image(base);
  const db=new DatabaseSync(filename);const before=db.prepare('SELECT hash FROM blobs ORDER BY hash').all();db.exec("CREATE TRIGGER reject_part BEFORE INSERT ON parts WHEN NEW.entry_name='model-inputs/fault.json' AND NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'part write rejected'); END");db.close();
  await assert.rejects(()=>repo.saveModelInput('fault',capture({encoding:'simulation',blocks:[{inlineData:{mimeType:'image/png',data:bytes.toString('base64')}}]})),/part write rejected/);
  const check=new DatabaseSync(filename,{readOnly:true});assert.deepEqual(check.prepare('SELECT hash FROM blobs ORDER BY hash').all(),before);assert.equal(check.prepare("SELECT count(*) AS n FROM entries WHERE name='model-inputs/fault.json'").get()!.n,0);assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(),[]);check.close();
  assert.equal((await DocumentRepository.recoverable(cache)).length,1);const reopened=await DocumentRepository.open(filename,path.join(base,'fresh-cache'));assert.equal(await reopened.loadModelInput('fault'),null);await reopened.close();await repo.close();
});

test('单文件收齐外部图片，移动工程、删除原图与缓存后仍可读取并原位保存',async()=>{
  const {base,filename,cache,repo,w}=await fixture();const source=await image(base);
  await w.importFiles([source.filename],w.project!.recipe.modules[0].module_id);
  const originalId=w.project!.project_id;await repo.close();await unlink(source.filename);
  // A clean warm cache is optional; carrying just the document must still work.
  assert.equal((await readdir(cache)).filter(name=>name.startsWith('cached-')).length,1);
  assert.equal(path.dirname(path.resolve(cache)),path.resolve(base));await rm(cache,{recursive:true});
  const relocated=path.join(base,'带走的工程.ediro');await rename(filename,relocated);
  const reopened=await DocumentRepository.open(relocated,cache);const p=await reopened.load();assert.equal(p.project_id,originalId);
  assert.ok(p.assets.every(a=>a.location.type==='managed'));assert.deepEqual(await reopened.readAsset(p.assets[0]),source.bytes);
  p.name='继续编辑';await reopened.save(p);await reopened.close();
  const again=await DocumentRepository.open(relocated,cache);assert.equal((await again.load()).name,'继续编辑');await again.close();
  assert.deepEqual((await readdir(base)).sort(),['cache','带走的工程.ediro']);assert.equal((await readdir(cache)).filter(name=>name.startsWith('cached-')).length,1);
});

test('只修改参数不重写图片条目；另存为新身份并保留源工程',async()=>{
  const {base,filename,cache,repo,w}=await fixture();const source=await image(base);await w.importFiles([source.filename]);
  const db=new DatabaseSync(filename);db.exec('CREATE TABLE image_updates(n INTEGER); INSERT INTO image_updates VALUES(0); CREATE TRIGGER count_images AFTER UPDATE ON entries WHEN NEW.name LIKE \'assets/%\' BEGIN UPDATE image_updates SET n=n+1; END;');db.close();
  const p=w.project!;p.recipe.modules[0].user_instruction='参数变化';await w.persist();
  const check=new DatabaseSync(filename,{readOnly:true});assert.equal(check.prepare('SELECT n FROM image_updates').get()!.n,0);check.close();
  const copy=await DocumentRepository.saveAs(repo,p,path.join(base,'copy.ediro'),cache),copied=await copy.load();assert.notEqual(copied.project_id,p.project_id);assert.equal(copied.recipe.modules[0].user_instruction,'参数变化');
  copied.name='副本编辑';await copy.save(copied);assert.equal((await repo.load()).name,'单文件测试');
  await assert.rejects(()=>DocumentRepository.saveAs(repo,p,copy.filename,cache),/已存在/);
  await copy.close();await repo.close();
});

test('再次打开复用已验证缓存；缓存损坏或缺失从工程重建',async()=>{
  const {base,filename,cache,repo,w}=await fixture();const source=await image(base);await w.importFiles([source.filename]);
  const asset=w.project!.assets[0],before=await stat(await repo.resolveAssetPath(asset,false));await repo.close();
  const warm=await DocumentRepository.open(filename,cache),after=await stat(await warm.resolveAssetPath(asset,false));
  assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.ino,before.ino);assert.deepEqual(await warm.readAsset(asset),source.bytes);await warm.close();
  const slot=path.join(cache,(await readdir(cache)).find(name=>name.startsWith('cached-'))!);
  assert.equal(asset.location.type,'managed');if(asset.location.type!=='managed')throw Error('expected embedded image');
  await writeFile(path.join(slot,asset.location.relative_path),Buffer.from('损坏的缓存'));
  const repaired=await DocumentRepository.open(filename,cache);assert.deepEqual(await repaired.readAsset(asset),source.bytes);await repaired.close();
  await unlink(path.join(slot,asset.location.relative_path));
  const restored=await DocumentRepository.open(filename,cache);assert.deepEqual(await restored.readAsset(asset),source.bytes);await restored.close();
});

test('旧缓存不掩盖原文件变化或损坏，同时打开的工程使用独立目录',async()=>{
  const {base,filename,cache,repo,w}=await fixture();const source=await image(base);await w.importFiles([source.filename]);
  const second=await DocumentRepository.open(filename,cache);assert.notEqual(second.directory,repo.directory);
  const project=await second.load();project.name='另一处的最新内容';await second.save(project);
  await repo.close();await second.close(); // The first cache is stale; never treat it as authoritative.
  const latest=await DocumentRepository.open(filename,cache);assert.equal((await latest.load()).name,'另一处的最新内容');await latest.close();
  const db=new DatabaseSync(filename);db.exec("UPDATE blobs SET bytes=x'00' WHERE hash IN (SELECT blob_hash FROM parts WHERE entry_name LIKE 'assets/%')");db.close();
  await assert.rejects(()=>DocumentRepository.open(filename,cache),/校验失败|展开大小/);
});

test('未修改时保存与关闭不写工程，未保存修改仍补存并阻止失败关闭',async()=>{
  const {repo,w}=await fixture(2000);let writes=0;const save=repo.save.bind(repo);repo.save=async p=>{writes++;await save(p);};
  await w.flush();await w.shutdown();assert.equal(writes,0);
  const recipe=structuredClone(w.project!.recipe);recipe.modules[0].user_instruction='待补存';await w.saveRecipe(recipe);
  await w.flush();await w.shutdown();assert.equal(writes,1);assert.equal((await repo.load()).recipe.modules[0].user_instruction,'待补存');
  recipe.modules[0].user_instruction='保存失败仍保留';await w.saveRecipe(recipe);repo.save=async()=>{throw Error('模拟磁盘故障');};
  await assert.rejects(()=>w.shutdown(),/模拟磁盘故障/);assert.equal(w.saveState,'error');
  repo.save=save;await w.shutdown();assert.equal((await repo.load()).recipe.modules[0].user_instruction,'保存失败仍保留');await repo.close();
});

test('同一个文件的第二个写入者不能覆盖更新；失败缓存保留，可另存救回',async()=>{
  const {base,filename,cache,repo,w}=await fixture();const second=await DocumentRepository.open(filename,cache),stale=await second.load();
  w.project!.name='第一处修改';await w.persist();stale.name='第二处未保存';
  await assert.rejects(()=>second.save(stale),/另一处修改/);
  const rescue=await DocumentRepository.saveAs(second,stale,path.join(base,'rescue.ediro'),cache);assert.equal((await rescue.load()).name,'第二处未保存');
  assert.equal((await repo.load()).name,'第一处修改');const failedCache=second.directory;await second.close();
  assert.equal(JSON.parse(await readFile(path.join(failedCache,projectFilename),'utf8')).name,'第二处未保存');
  await rescue.close();await repo.close();
});

test('生成结果和实际请求在工程内，导出之外不产生散落成品；结果移除保留历史像素',async()=>{
  const {base,filename,cache,repo,w}=await fixture(50);const recipe=structuredClone(w.project!.recipe);recipe.modules[3].user_instruction='mock product';await w.saveRecipe(recipe);
  await w.enqueue(false);await settle(w);assert.equal(w.project!.jobs[0].status,'succeeded');
  const output=w.project!.assets.find(a=>a.kind==='output')!;assert.ok(output);assert.equal(output.location.type,'managed');assert.ok(await repo.loadModelInput(w.project!.jobs[0].task_id));
  await assert.rejects(()=>readdir(path.join(base,'output')),/ENOENT/);
  const exported=path.join(base,'成品.png');await repo.export(output,exported);assert.ok((await readFile(exported)).length);
  await repo.trashResult(w.project!,output.asset_id,async()=>{throw Error('不应删除外部文件');});assert.ok((await repo.readAsset(output)).length);
  await repo.close();const fresh=await DocumentRepository.open(filename,cache);assert.equal((await fresh.load()).jobs[0].status,'succeeded');await fresh.close();
});

test('旧目录工程转存失败不改变旧工程；成功收齐原图',async()=>{
  const {base,cache,repo,w}=await fixture();const source=await image(base);const legacy=new ProjectRepository(path.join(base,'legacy')),old=workspace();await old.create(legacy,'旧工程');await old.importFiles([source.filename]);
  const original=await readFile(path.join(legacy.directory,projectFilename));await rename(source.filename,source.filename+'.moved');
  await assert.rejects(()=>DocumentRepository.saveAs(legacy,old.project!,path.join(base,'bad.ediro'),cache),/移动或删除/);
  assert.deepEqual(await readFile(path.join(legacy.directory,projectFilename)),original);
  await rename(source.filename+'.moved',source.filename);const converted=await DocumentRepository.saveAs(legacy,old.project!,path.join(base,'converted.ediro'),cache);
  assert.ok((await converted.load()).assets.every(a=>a.location.type==='managed'));await converted.close();await repo.close();
});

test('非法条目、未来版本、损坏内容都不能作为工程打开',async()=>{
  const {filename,cache,repo}=await fixture();await repo.close();const db=new DatabaseSync(filename);
  db.prepare('INSERT INTO entries VALUES(?,?,?)').run('../escaped.txt','invalid',3);db.close();
  await assert.rejects(()=>DocumentRepository.open(filename,cache),/非法条目/);
  const fix=new DatabaseSync(filename);fix.exec("DELETE FROM entries WHERE name='../escaped.txt'; PRAGMA user_version=99;");fix.close();
  await assert.rejects(()=>DocumentRepository.open(filename,cache),/格式版本/);
  const corrupt=new DatabaseSync(filename);corrupt.exec("PRAGMA user_version=2; UPDATE entries SET hash='corrupt' WHERE name='ediro.project.json'");corrupt.close();
  await assert.rejects(()=>DocumentRepository.open(filename,cache),/校验失败/);
});

test('缓存原图缺失时拒绝提交，已经保存的工程保持完整',async()=>{
  const {filename,cache,base,repo,w}=await fixture();const source=await image(base);await w.importFiles([source.filename]);
  await unlink(await repo.resolveAssetPath(w.project!.assets[0],false));w.project!.name='不能损坏原工程';
  await assert.rejects(()=>w.persist(),/工程素材缺失/);const intact=await DocumentRepository.open(filename,cache);
  assert.equal((await intact.load()).name,'单文件测试');assert.deepEqual(await intact.readAsset((await intact.load()).assets[0]),source.bytes);await intact.close();await repo.close();
});

test('连续编辑合并保存；切换和正常关闭立即补存',async()=>{
  const {repo,w,base}=await fixture(80);let writes=0;const save=repo.save.bind(repo);repo.save=async p=>{writes++;await save(p);};
  for(let i=0;i<5;i++){const r=structuredClone(w.project!.recipe);r.modules[0].user_instruction='编辑'+i;await w.saveRecipe(r);}
  assert.equal(writes,0);assert.equal(w.saveState,'pending');await pause(180);await w.serial(async()=>{});assert.equal(writes,1);assert.equal(w.saveState,'saved');
  const r=structuredClone(w.project!.recipe);r.modules[0].user_instruction='关闭前';await w.saveRecipe(r);await w.shutdown();assert.equal((await repo.load()).recipe.modules[0].user_instruction,'关闭前');
  r.modules[0].user_instruction='切换前';await w.saveRecipe(r);await w.create(new ProjectRepository(path.join(base,'other')),'其他');assert.equal((await repo.load()).recipe.modules[0].user_instruction,'切换前');await repo.close();
});

test('请求前保存失败绝不调用执行器；自动保存失败显式保留修改',async()=>{
  const {repo,base}=await fixture();let calls=0;const w=workspace(40,{execute:async()=>{calls++;throw Error('不应请求');}});await w.open(repo);
  const real=repo.save.bind(repo);repo.save=async()=>{throw Error('磁盘故障');};
  const r=structuredClone(w.project!.recipe);r.modules[3].user_instruction='必须保留';await w.saveRecipe(r);await pause(100);await w.serial(async()=>{});
  assert.equal(w.saveState,'error');assert.equal(w.project!.recipe.modules[3].user_instruction,'必须保留');
  await assert.rejects(()=>w.enqueue(false),/磁盘故障/);await pause(30);assert.equal(calls,0);
  await assert.rejects(()=>w.create(new ProjectRepository(path.join(base,'blocked')),'不得切换'),/磁盘故障/);
  repo.save=real;await w.persist();assert.equal(w.saveState,'saved');await repo.close();
});

test('最近工程按路径识别：重复打开同文件同记录，复制文件为另一个入口',async()=>{
  const {base,filename,cache,repo,w}=await fixture();const library=new DocumentLibrary(path.join(base,'runtime'));await library.initialize();
  const id=await library.register(repo,w.project!.name);assert.equal((await library.openFile(filename)).id,id);
  await writeFile(path.join(base,'physical-copy.ediro'),await readFile(filename));const copy=await library.openFile(path.join(base,'physical-copy.ediro'));assert.notEqual(copy.id,id);
  assert.equal((await library.list(new Set())).length,2);await library.releaseExcept(undefined);
});

test('删除后的缓存清理只移除已保存副本，保留失败恢复缓存与工程文件',async()=>{
  const {base,filename,cache,repo,w}=await fixture(),library=new DocumentLibrary(path.join(base,'runtime'));await library.initialize();
  const id=await library.register(repo,w.project!.name);assert.deepEqual(await library.trashTarget(id),{filename,missing:false});
  const stale=await DocumentRepository.open(filename,cache),project=await stale.load();w.project!.name='已保存更新';await w.persist();project.name='冲突修改';await assert.rejects(()=>stale.save(project),/另一处修改/);await stale.close();await repo.close();
  const before=await readFile(filename);
  // The fixture's cache root differs from DocumentLibrary's production root.
  await DocumentRepository.discardCleanCache(filename,cache);
  assert.deepEqual(await readFile(filename),before);assert.ok(!(await readdir(cache)).some(name=>name.startsWith('cached-')));assert.equal((await DocumentRepository.recoverable(cache)).length,1);
  await rename(filename,filename+'.moved');assert.deepEqual(await library.trashTarget(id),{filename,missing:true});await mkdir(filename);await assert.rejects(()=>library.trashTarget(id),/目录或链接/);
});

test('事务中断后回滚到完整旧工程；失败草稿可被下次启动发现',async()=>{
  const {filename,cache,repo,w}=await fixture();
  // Simulate an interrupted writer without closing its transaction/connection.
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec("BEGIN IMMEDIATE; UPDATE entries SET hash='corrupt' WHERE name='ediro.project.json'");process.exit(9);`,filename],{windowsHide:true});
  assert.equal(child.status,9,child.error?.message);
  const recovered=await DocumentRepository.open(filename,cache);assert.equal((await recovered.load()).name,'单文件测试');await recovered.close();
  const db=new DatabaseSync(filename);db.exec("CREATE TRIGGER reject_save BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'write rejected'); END");db.close();
  w.project!.name='未能写回的编辑';await assert.rejects(()=>w.persist(),/write rejected/);
  const candidates=await DocumentRepository.recoverable(cache);assert.equal(candidates.length,1);assert.equal(candidates[0].directory,repo.directory);
  const intact=await DocumentRepository.open(filename,cache);assert.equal((await intact.load()).name,'单文件测试');await intact.close();await repo.close();
});

test('中断后已暂存的模型返回可恢复，不会自动重新请求',async()=>{
  const {filename,cache,repo,w,base}=await fixture();const source=await image(base);
  const r=structuredClone(w.project!.recipe);r.modules[3].user_instruction='准备任务';await w.saveRecipe(r);
  // Hold the queue so no executor runs; retain a queued task exactly as on disk.
  await w.serial(async()=>{
    await w.enqueue(false);const job=w.project!.jobs[0];
    await repo.stageResult(job,{images:[{bytes:source.bytes,format:'png',width:24,height:20}]});
    job.status='cancelled';
  });
  await repo.close();const opened=await DocumentRepository.open(filename,cache);
  let calls=0;const fresh=workspace(0,{execute:async()=>{calls++;throw Error('不能重新调用');}});await fresh.open(opened);
  const job=fresh.project!.jobs[0];assert.equal(job.status,'failed');assert.equal(job.recoverable_result,true);
  await fresh.recoverResult(job.task_id);assert.equal(job.status,'succeeded');assert.equal(calls,0);await opened.close();
});

test('蒙版草稿、模型原始返回、严格合成和补画版本在单文件中重开可编辑',async()=>{
  const {filename,cache,repo,w,base}=await fixture(40);const source=await image(base);await w.importFiles([source.filename]);
  const draft:MaskDraft={source_asset_id:w.project!.assets[0].asset_id,width:24,height:20,strokes:[{tool:'paint',size:8,points:[[.5,.5]]}],instruction:'改变选区颜色',model_config_id:'model_mock_native',quality:'standard',mode:'strict',feather:0};
  await w.serial(()=>w.enqueueMask(w.project!.project_id,draft));await settle(w);const job=w.project!.jobs[0];assert.equal(job.status,'succeeded',job.error);
  const first=await w.reprocessMask(w.project!.project_id,job.task_id,'strict',0);
  const strokes:MaskDraft['strokes']=[{tool:'paint',size:4,points:[[.7,.5]]}];await w.saveCompositeMask(w.project!.project_id,job.task_id,strokes);
  const second=await w.reprocessMask(w.project!.project_id,job.task_id,'strict',0,strokes);assert.notEqual(first,second);
  const before=await repo.readAsset(w.project!.assets.find(a=>a.asset_id===second)!);await repo.close();await unlink(source.filename);
  const reopened=await DocumentRepository.open(filename,cache),next=workspace();await next.open(reopened);
  assert.deepEqual(next.project!.jobs[0].mask_edit!.composite_strokes,strokes);
  assert.deepEqual(await reopened.readAsset(next.project!.assets.find(a=>a.asset_id===second)!),before);
  assert.ok((await next.previewMask(next.project!.project_id,job.task_id,'natural',0)).startsWith('data:image/'));await reopened.close();
});

test('旧工程已删除且无输入引用的结果可保留删除记录转存、重开和再次另存',async()=>{
  const {base,cache,repo}=await fixture(),legacy=new ProjectRepository(path.join(base,'legacy')),w=workspace();await w.create(legacy,'旧工程删除历史');
  const r=structuredClone(w.project!.recipe);r.modules[3].user_instruction='模拟旧结果';await w.saveRecipe(r);await w.enqueue(false);await settle(w);
  const output=w.project!.assets.find(a=>a.kind==='output')!,assetId=output.asset_id,job=structuredClone(w.project!.jobs[0]),revisions=structuredClone(w.project!.revisions);
  await legacy.trashResult(w.project!,assetId,unlink);
  assert.ok(optionalRemovedResults(w.project!).has(assetId));
  const copied=await DocumentRepository.saveAs(legacy,w.project!,path.join(base,'deleted.ediro'),cache),project=await copied.load();
  assert.equal(project.assets.find(a=>a.asset_id===assetId)!.removed_result,true);assert.deepEqual(project.jobs[0],job);assert.deepEqual(project.revisions,revisions);
  assert.ok(project.assets.every(a=>a.location.type==='managed'));project.name='继续保存';await copied.save(project);
  const again=await DocumentRepository.saveAs(copied,project,path.join(base,'again.ediro'),cache);assert.equal((await again.load()).name,'继续保存');
  // The compatible directory-open path also retains the tombstone.
  const folder=path.join(base,'folder');await legacy.packageProject(w.project!,folder);const source=new ProjectRepository(folder),fork=path.join(base,'fork');await source.forkWorkspace(await source.load(),fork);assert.equal((await new ProjectRepository(fork).load()).assets[0].removed_result,true);
  await again.close();await copied.close();await repo.close();
});

test('已删除结果只要仍是当前、停用模块、历史请求或蒙版输入，就不能跳过',async()=>{
  const {base,cache,repo,w}=await fixture();const source=await image(base);await w.importFiles([source.filename]);
  const asset=w.project!.assets[0];asset.kind='output';asset.removed_result=true;const id=asset.asset_id;
  const clean=structuredClone(w.project!);assert.ok(optionalRemovedResults(clean).has(id));
  for(const enabled of [true,false]){const p=structuredClone(clean);p.recipe.modules[0].asset_ids=[id];p.recipe.modules[0].enabled=enabled;assert.ok(!optionalRemovedResults(p).has(id));}
  const r=structuredClone(w.project!.recipe);r.modules[0].asset_ids=[id];r.modules[3].user_instruction='历史引用';await w.saveRecipe(r);await w.enqueue(false);await settle(w);
  const used=structuredClone(w.project!);used.recipe.modules[0].asset_ids=[];assert.ok(!optionalRemovedResults(used).has(id));
  const adaptedOnly=structuredClone(used);adaptedOnly.jobs[0].recipe_snapshot.modules[0].asset_ids=[];adaptedOnly.jobs[0].chain_snapshot.blocks=adaptedOnly.jobs[0].chain_snapshot.blocks.filter(b=>b.type!=='image');adaptedOnly.jobs[0].adapted_input={kind:'separated_inputs',image_asset_ids:[id],prompt:'历史请求',adjustments:[]};assert.ok(!optionalRemovedResults(adaptedOnly).has(id));
  const draft:MaskDraft={source_asset_id:id,width:24,height:20,strokes:[],instruction:'草稿引用',model_config_id:'model_mock_native',quality:'standard',mode:'strict',feather:0};const masked=structuredClone(clean);masked.mask_drafts=[draft];assert.ok(!optionalRemovedResults(masked).has(id));
  await unlink(await repo.resolveAssetPath(asset,false));
  await assert.rejects(()=>DocumentRepository.saveAs(repo,used,path.join(base,'must-not-skip.ediro'),cache),/ENOENT/);
  // An accidentally missing but not explicitly deleted result must still fail.
  const ordinary=structuredClone(clean);ordinary.assets[0].removed_result=false;await assert.rejects(()=>DocumentRepository.saveAs(repo,ordinary,path.join(base,'ordinary.ediro'),cache),/ENOENT/);
  await repo.close();
});
