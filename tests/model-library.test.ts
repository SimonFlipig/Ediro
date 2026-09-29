import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelLibrary,seedModels } from '../src/core/models.js';
import { migrateModels,mockDescription,librarySchema } from '../src/core/model-library.js';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { openModelLibrary } from '../src/adapters/model-library-repository.js';

function fixture(){const values=new Map<string,string>();const library=new ModelLibrary(migrateModels(seedModels()),async()=>{}, {has:async ref=>values.has(ref),set:async(ref,key)=>{values.set(ref,key);},resolve:async ref=>values.get(ref)!},[mockDescription,new GeminiGenerator().description]);return {values,library};}
test('默认编辑模型独立保存，必须具备编辑能力，删除前须先更换默认项',async()=>{
  const {library}=fixture();await library.assign('editing','model_mock_native');
  const snapshot=library.snapshot();assert.equal(snapshot.assignments.editing_default,'model_mock_native');assert.equal(snapshot.assignments.generation_default,'model_mock_native');
  await library.assign('generation','model_mock_separated');assert.equal(library.snapshot().assignments.editing_default,'model_mock_native');
  await assert.rejects(()=>library.deleteModel('model_mock_native'),/默认/);
  const bad=snapshot.models.find(m=>m.model_config_id==='model_mock_separated')!;
  await library.saveModel({...bad,capabilities:{...bad.capabilities,operations:['generate']}});
  await assert.rejects(()=>library.assign('editing',bad.model_config_id),/用途/);
  const restored=new ModelLibrary(library.snapshot(),async()=>{},{has:async()=>false,set:async()=>{}});assert.equal(restored.snapshot().assignments.editing_default,'model_mock_native');
});
test('共享连接共用凭据；已冻结执行配置不随地址和 Key 修改',async()=>{
  const {library}=fixture(),data=library.snapshot(),connection=data.connections[0],first=data.models[2];
  await library.saveConnection({...connection,endpoint:'https://api.aipix.one'},'key-old');
  await library.saveModel({...first,model_config_id:'model_google_second',model:'another-image'});
  const frozen=await library.execution(first.model_config_id);assert.equal(await library.credential(frozen),'key-old');
  await library.saveConnection({...connection,endpoint:'https://example.com'},'key-new');
  assert.equal(frozen.endpoint,'https://api.aipix.one');assert.equal(await library.credential(frozen),'key-old');
  assert.equal(await library.credential(await library.execution('model_google_second')),'key-new');
  const publicData=JSON.stringify({models:await library.list(),connections:await library.connections()});assert.ok(!publicData.includes('key-old')&&!publicData.includes('key-new')&&!publicData.includes('credential_ref'));
});
test('失效引用、未知适配器、功能错配和连接删除均明确失败',async()=>{
  const {library}=fixture(),data=library.snapshot();await assert.rejects(()=>library.deleteConnection(data.connections[0].connection_id),/关联模型/);
  await assert.rejects(()=>library.saveModel({...data.models[2],adapter_id:'not-installed'}),/适配器不存在|预设与接口协议/);
  await assert.rejects(()=>library.assign('understanding','model_mock_native'),/用途/);
  assert.throws(()=>library.resolve('model_missing'),/不存在/);
  const broken=library.snapshot();broken.models[2].connection_id='connection_missing';assert.equal(librarySchema.safeParse(broken).success,false);
});
test('同连接多协议可配置，协议缺失不允许执行；能力不超出协议范围',async()=>{
  const {library}=fixture(),data=library.snapshot();
  assert.equal(library.resolve('model_image_2').executable,false);
  await library.saveConnection(data.connections[0],'key');
  await library.saveModel({...data.models[2],capabilities:{...data.models[2].capabilities,qualities:['2K','unsupported'],formats:['png','webp'],max_count:10}});
  const resolved=library.resolve('model_nano_pro');assert.deepEqual(resolved.capabilities.qualities,['2K']);assert.deepEqual(resolved.capabilities.formats,['png']);assert.equal(resolved.capabilities.max_count,1);
  await assert.rejects(()=>library.saveModel({...data.models[2],capability_source:'tested'}),/不能手动/);
});
test('迁移保持模型 ID 和凭据引用，备份原文件；重复启动不重复迁移',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'ediro-library-')),legacy=seedModels();legacy[2].credential_ref='credential_legacy';
  const original=JSON.stringify(legacy);await writeFile(path.join(directory,'models.json'),original);
  const data=await openModelLibrary(directory);assert.deepEqual(data.models.map(m=>m.model_config_id),legacy.map(m=>m.model_config_id));assert.equal(data.connections[0].credential_ref,'credential_legacy');
  assert.equal(await readFile(path.join(directory,'models.json'),'utf8'),original);assert.equal(await readFile(path.join(directory,'models.pre-library-v1.json'),'utf8'),original);
  assert.deepEqual(await openModelLibrary(directory),data);
  await writeFile(path.join(directory,'model-library.v3.json'),'invalid');await assert.rejects(()=>openModelLibrary(directory),/不会重置/);
});
test('失败保存不改变连接、模型或默认路由',async()=>{
  const data=migrateModels(seedModels()),library=new ModelLibrary(data,async()=>{throw new Error('disk failure');},{has:async()=>false,set:async()=>{}}),before=library.snapshot();
  await assert.rejects(()=>library.saveConnection({...data.connections[0],endpoint:'https://changed.example'},'new-key'));assert.deepEqual(library.snapshot(),before);
  await assert.rejects(()=>library.assign('generation','model_mock_separated'));assert.equal(library.defaultModel(),'model_mock_native');
});
test('旧站点适配器迁移为通用协议并备份，保留连接、凭据、模型身份与声明能力',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'ediro-images-migration-')),data=migrateModels(seedModels());const m=data.models[3];m.adapter_id='kuai-images';m.model='custom-image-model';data.connections[1].credential_ref='credential_old';
  const original=JSON.stringify(data);await writeFile(path.join(directory,'model-library.v1.json'),original);
  const result=await openModelLibrary(directory);assert.equal(result.models[3].adapter_id,'openai-images');assert.equal(result.models[3].model,m.model);assert.equal(result.models[3].model_config_id,m.model_config_id);assert.equal(result.models[3].revision,m.revision+1);assert.deepEqual(result.models[3].capabilities,{...m.capabilities,features:[]});assert.deepEqual(result.connections,JSON.parse(original).connections);assert.deepEqual(result.assignments,data.assignments);assert.deepEqual(result.models[3].images_compatibility,{format_field:'format',image_field:'image',send_response_format:true,max_prompt_chars:1000});assert.equal(await readFile(path.join(directory,'model-library.pre-images-protocol-v1.json'),'utf8'),original);assert.deepEqual(await openModelLibrary(directory),result);
});
