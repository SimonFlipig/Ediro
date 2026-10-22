import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultModuleSettings, moduleSettingsSchema, resolveReferenceSettings } from '../src/core/module-settings.js';
import { loadModuleSettings, saveModuleSettings, moduleSettingsFilename } from '../src/adapters/module-settings-repository.js';
import { commandSchema } from '../src/shared/commands.js';
import { Workspace } from '../src/core/workspace.js';
import { ModelLibrary, seedModels } from '../src/core/models.js';
import { ProjectRepository } from '../src/adapters/project-repository.js';
import { prepareModuleInference } from '../src/core/module-inference.js';

async function directory() {
  const root=path.join(process.cwd(),'.local','test-module-settings');
  await mkdir(root,{recursive:true});
  return mkdtemp(path.join(root,'case-'));
}

test('模块默认值独立保存，重载保留选择，缺失设置使用独立的 1K 默认值', async()=>{
  const root=await directory(),other=await directory();
  const initial=await loadModuleSettings(root);
  assert.deepEqual(initial,defaultModuleSettings);
  initial.composition.max_edge=512;
  assert.equal((await loadModuleSettings(root)).composition.max_edge,1024);
  await saveModuleSettings(root,initial);
  assert.deepEqual(await loadModuleSettings(root),{...defaultModuleSettings,composition:{...defaultModuleSettings.composition,max_edge:512}});
  assert.deepEqual(await loadModuleSettings(other),defaultModuleSettings);
  const next=await loadModuleSettings(root);next.style.max_edge=512;
  await saveModuleSettings(root,next);
  assert.equal((await loadModuleSettings(root)).style.max_edge,512);
});

test('模块设置拒绝未支持分辨率、主体预处理和损坏配置，不覆盖已有设置',async()=>{
  const root=await directory();
  await saveModuleSettings(root,defaultModuleSettings);
  const invalid={...defaultModuleSettings,composition:{max_edge:2048}};
  assert.throws(()=>commandSchema.parse({type:'module-settings:save',settings:invalid}));
  await assert.rejects(()=>saveModuleSettings(root,invalid as never));
  assert.deepEqual(await loadModuleSettings(root),defaultModuleSettings);
  assert.throws(()=>moduleSettingsSchema.parse({...defaultModuleSettings,subject:{max_edge:512}}));
  await writeFile(path.join(root,moduleSettingsFilename),'{broken');
  await assert.rejects(()=>loadModuleSettings(root),/模块设置无效/);
});

test('旧缩图设置升级为仅缩图，新预处理方式与强度独立保存',async()=>{
  const root=await directory();
  await writeFile(path.join(root,moduleSettingsFilename),JSON.stringify({version:1,composition:{max_edge:512},style:{max_edge:1024}}));
  const settings=await loadModuleSettings(root);
  assert.equal(settings.composition.preprocess,'none');assert.equal(settings.style.blur_strength,'medium');
  assert.equal(settings.prompt.role,'general');
  settings.composition.preprocess='depth';settings.style.preprocess='blur';settings.style.blur_strength='strong';
  settings.prompt.role='merchandiser';
  await saveModuleSettings(root,settings);assert.deepEqual(await loadModuleSettings(root),settings);
  assert.throws(()=>moduleSettingsSchema.parse({...settings,style:{...settings.style,preprocess:'matting'}}));
  assert.throws(()=>moduleSettingsSchema.parse({...settings,style:{...settings.style,blur_strength:'extreme'}}));
  assert.throws(()=>commandSchema.parse({type:'reference:preview',project_id:'project_test',asset_id:'asset_test',reference_type:'subject'}));
});

test('启动默认角色持久化，新工程和新增提示词采用默认值，已有选择随工程重开保留',async()=>{
  const root=await directory(),runtime=await directory(),repository=new ProjectRepository(root);
  const models=new ModelLibrary(seedModels(),async()=>{}, {has:async()=>false,set:async()=>{}});
  const workspace=new Workspace(models,{execute:async()=>{throw new Error('不得调用模型');}});
  const settings=structuredClone(defaultModuleSettings);settings.prompt.role='merchandiser';
  await saveModuleSettings(runtime,settings);workspace.moduleSettings=await loadModuleSettings(runtime);
  await workspace.create(repository,'提示词角色持久化');
  const first=workspace.project!.recipe.modules.find(module=>module.reference_type==='prompt')!;
  assert.equal(first.prompt_role,'merchandiser');
  workspace.moduleSettings.prompt.role='general';await saveModuleSettings(runtime,workspace.moduleSettings);
  await workspace.addModule('prompt');
  assert.equal(workspace.project!.recipe.modules.at(-1)!.prompt_role,'general');
  await workspace.open(repository);
  assert.equal(workspace.project!.recipe.modules.find(module=>module.module_id===first.module_id)!.prompt_role,'merchandiser');
  assert.equal((await loadModuleSettings(runtime)).prompt.role,'general');
  await workspace.shutdown();
});

test('生成和推理冻结本次模块设置，任务重开与重试不随当前默认值改变',async()=>{
  const root=await directory();
  const models=new ModelLibrary(seedModels(),async()=>{}, {has:async()=>false,set:async()=>{}});
  // Failure avoids output generation; each request still traverses the real queue and persistence.
  const workspace=new Workspace(models,{execute:async()=>{throw new Error('测试中止，不调用模型');}});
  await workspace.create(new ProjectRepository(root),'缩图设置验证');
  workspace.project!.recipe.modules.at(-1)!.user_instruction='保留主体';
  const settle=async()=>{
    for(let i=0;i<100;i++){
      if(await workspace.serial(async()=>workspace.project!.jobs.every(job=>job.status==='failed')))return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('测试任务未结束');
  };
  await workspace.serial(()=>workspace.enqueue(false));await settle();
  workspace.moduleSettings.composition.max_edge=512;
  assert.equal(workspace.project!.jobs[0].module_settings_snapshot!.composition.max_edge,1024);
  await workspace.open(new ProjectRepository(root));
  assert.equal(workspace.project!.jobs[0].module_settings_snapshot!.composition.max_edge,1024);
  const first=workspace.project!.jobs[0];
  await workspace.serial(()=>workspace.retry(workspace.project!.project_id,first.task_id));await settle();
  assert.equal(workspace.project!.jobs[1].module_settings_snapshot!.composition.max_edge,1024);
  await workspace.serial(()=>workspace.enqueue(false));await settle();
  assert.equal(workspace.project!.jobs[2].module_settings_snapshot!.composition.max_edge,512);
  assert.equal(workspace.project!.jobs[2].recipe_snapshot.modules.find(module=>module.reference_type==='composition')!.reference_settings!.max_edge,1024);
  // Old jobs have no snapshot and remain distinguishable after loading.
  delete workspace.project!.jobs[0].module_settings_snapshot;
  await workspace.persist();await workspace.open(new ProjectRepository(root));
  assert.equal(workspace.project!.jobs[0].module_settings_snapshot,undefined);
  const model={...seedModels()[0],purpose:'understanding' as const,enabled:true,executable:true,capabilities:{...seedModels()[0].capabilities,operations:['understand']}};
  const recipe=workspace.project!.recipe,prompt=recipe.modules.find(m=>m.reference_type==='prompt')!;
  const prepared=prepareModuleInference(recipe,prompt.module_id,'分析本次要求',model,workspace.registry,false,workspace.moduleSettings);
  workspace.moduleSettings.composition.max_edge=1024;
  assert.equal(prepared.job.module_settings_snapshot!.composition.max_edge,512);
  const edited=structuredClone(recipe),composition=edited.modules.find(module=>module.reference_type==='composition')!;
  composition.reference_settings={max_edge:512,preprocess:'blur',blur_strength:'strong'};
  await workspace.saveRecipe(edited);await workspace.serial(()=>workspace.enqueue(false));await settle();
  const frozen=workspace.project!.jobs.at(-1)!.recipe_snapshot.modules.find(module=>module.module_id===composition.module_id)!;
  assert.deepEqual(frozen.reference_settings,composition.reference_settings);
  const next=structuredClone(workspace.project!.recipe);next.modules.find(module=>module.module_id===composition.module_id)!.reference_settings!.blur_strength='weak';
  await workspace.saveRecipe(next);
  assert.equal(frozen.reference_settings!.blur_strength,'strong');
  assert.equal(prepared.job.recipe_snapshot.modules.find(module=>module.module_id===composition.module_id)!.reference_settings!.max_edge,1024);
  await workspace.shutdown();
});

test('模块参数随工程保存，新建采用默认值，复制保留选择，切换类型采用目标默认值',async()=>{
  const root=await directory(),repository=new ProjectRepository(root);
  const models=new ModelLibrary(seedModels(),async()=>{}, {has:async()=>false,set:async()=>{}});
  const workspace=new Workspace(models,{execute:async()=>{throw new Error('不得调用模型');}});
  workspace.moduleSettings.composition={max_edge:512,preprocess:'blur',blur_strength:'strong'};
  workspace.moduleSettings.style={max_edge:1024,preprocess:'depth',blur_strength:'medium'};
  await workspace.create(repository,'模块参数持久化');
  const compositionId=workspace.project!.recipe.modules.find(module=>module.reference_type==='composition')!.module_id;
  const styleId=workspace.project!.recipe.modules.find(module=>module.reference_type==='style')!.module_id;
  const get=(id:string)=>workspace.project!.recipe.modules.find(module=>module.module_id===id)!;
  assert.deepEqual(get(compositionId).reference_settings,{max_edge:512,preprocess:'blur',blur_strength:'strong'});
  assert.equal(workspace.project!.recipe.modules[0].reference_settings,undefined);
  workspace.moduleSettings.composition={max_edge:1024,preprocess:'segment',blur_strength:'weak'};
  assert.equal(get(compositionId).reference_settings!.preprocess,'blur');
  await workspace.addModule('composition');
  assert.deepEqual(workspace.project!.recipe.modules.at(-1)!.reference_settings,workspace.moduleSettings.composition);
  const edited=structuredClone(workspace.project!.recipe);edited.modules.find(module=>module.module_id===compositionId)!.reference_settings={max_edge:512,preprocess:'none',blur_strength:'medium'};
  await workspace.saveRecipe(edited);await workspace.copyModule(compositionId);
  const copy=workspace.project!.recipe.modules[workspace.project!.recipe.modules.findIndex(module=>module.module_id===compositionId)+1];
  assert.notEqual(copy.module_id,compositionId);assert.deepEqual(copy.reference_settings,get(compositionId).reference_settings);
  assert.notStrictEqual(copy.reference_settings,get(compositionId).reference_settings);
  await workspace.changeReferenceType(compositionId,'style');assert.deepEqual(get(compositionId).reference_settings,workspace.moduleSettings.style);
  await workspace.changeReferenceType(compositionId,'subject');assert.equal(get(compositionId).reference_settings,undefined);
  await workspace.changeReferenceType(compositionId,'composition');assert.deepEqual(get(compositionId).reference_settings,workspace.moduleSettings.composition);
  await workspace.open(repository);
  assert.deepEqual(get(copy.module_id).reference_settings,{max_edge:512,preprocess:'none',blur_strength:'medium'});
  // Legacy modules remain compatible without rewriting every old project.
  const legacy=structuredClone(workspace.project!.recipe);delete legacy.modules.find(module=>module.module_id===styleId)!.reference_settings;
  await workspace.saveRecipe(legacy);await workspace.open(repository);assert.equal(get(styleId).reference_settings,undefined);
  assert.deepEqual(resolveReferenceSettings(get(styleId),workspace.moduleSettings),workspace.moduleSettings.style);
  await workspace.copyModule(styleId);
  const legacyCopy=workspace.project!.recipe.modules[workspace.project!.recipe.modules.findIndex(module=>module.module_id===styleId)+1];
  workspace.moduleSettings.style={max_edge:512,preprocess:'none',blur_strength:'weak'};
  assert.equal(legacyCopy.reference_settings!.preprocess,'depth');
  assert.equal(resolveReferenceSettings(get(styleId),workspace.moduleSettings)!.preprocess,'none');
  assert.equal(resolveReferenceSettings(workspace.project!.recipe.modules.find(module=>module.reference_type==='subject')!,workspace.moduleSettings),undefined);
  await workspace.shutdown();
});
