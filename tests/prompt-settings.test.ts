import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPromptSettings,mergeImportedPromptSettings,promptSettingsSchema,promptPresetLibrarySchema,roleInstructionPresetSchema,inferenceInstructionPresetSchema,presetTarget,type ModuleInstructionPreset,type RoleInstructionPreset,type InferenceInstructionPreset} from '../src/core/prompt-settings.js';
import {emptyPromptCustomizations} from '../src/core/prompt-customization.js';
import {defaultModuleInferenceInstructions} from '../src/core/module-inference-instructions.js';
import {loadPromptSettings,savePromptSettings,savePromptPresetLibrary,savePromptCustomizations,importPromptSettings,exportPromptSettings,promptSettingsFilename,promptCustomizationsFilename} from '../src/adapters/prompt-config-repository.js';
import {releasePromptConfig} from '../src/core/release-prompt-config.js';
import {ModuleRegistry} from '../src/core/modules.js';

function samplePreset(overrides:Partial<ModuleInstructionPreset>={}):ModuleInstructionPreset{
  return {id:'preset_subject',name:'商品参考',module:'subject',instructions:{native_instruction:'保留主体 {images}'},...overrides};
}

function sampleRolePreset(overrides:Partial<RoleInstructionPreset>={}):RoleInstructionPreset{
  return {id:'preset_general',name:'通用角色方案',role:'general',instruction:'按角色原文处理 {images}、{viewpoint}、{module} 和 {任意花括号}。',...overrides};
}

function sampleInferencePreset(overrides:Partial<InferenceInstructionPreset>={}):InferenceInstructionPreset{
  return {id:'preset_inference_subject',name:'主体理解范围',kind:'inference',module:'subject',instruction:'只识别场景所需的主体类别和用户明确的改动。',...overrides};
}

function sampleSettings(){
  return promptSettingsSchema.parse({
    ...createPromptSettings({version:1,modules:{subject:{native_instruction:'尚未存入预设的改动',numbered_instruction:''}},roles:{general:'自定义角色'}}),
    presets:[samplePreset()],selected_presets:{subject:'preset_subject'},
  });
}

async function withRuntime(run:(directory:string)=>Promise<void>){
  const directory=await mkdtemp(path.join(tmpdir(),'ediro-prompt-settings-'));
  try{await run(directory);}
  finally{await rm(directory,{recursive:true,force:true});}
}

test('指令设置保留未存入预设的当前文字，并区分默认和显式空指令',()=>{
  const settings=sampleSettings();
  assert.equal(settings.customizations.modules.subject?.native_instruction,'尚未存入预设的改动');
  assert.equal(settings.customizations.modules.subject?.numbered_instruction,'');
  assert.ok('instructions' in settings.presets[0]);
  assert.equal(Object.hasOwn(settings.presets[0].instructions,'numbered_instruction'),false);
  assert.deepEqual(promptSettingsSchema.parse(JSON.parse(JSON.stringify(settings))),settings);
  const fresh=createPromptSettings();
  fresh.customizations.roles.general='只改这一份';
  assert.deepEqual(createPromptSettings().customizations,emptyPromptCustomizations);
});

test('预设名称会去除首尾空格，同模块名称和所有 ID 必须唯一',()=>{
  const presets=promptPresetLibrarySchema.parse([samplePreset({name:'  商品参考  '})]);
  assert.equal(presets[0].name,'商品参考');
  assert.throws(()=>promptPresetLibrarySchema.parse([samplePreset(),samplePreset({id:'preset_other',name:' 商品参考 '})]));
  assert.throws(()=>promptPresetLibrarySchema.parse([samplePreset(),samplePreset({module:'style'})]));
  assert.doesNotThrow(()=>promptPresetLibrarySchema.parse([samplePreset(),samplePreset({id:'preset_style',module:'style'})]));
  assert.throws(()=>promptPresetLibrarySchema.parse([samplePreset({name:'   '})]));
  assert.throws(()=>promptPresetLibrarySchema.parse([samplePreset({name:'长'.repeat(81)})]));
  assert.throws(()=>promptPresetLibrarySchema.parse(Array.from({length:201},(_,index)=>samplePreset({id:`preset_${index}`,name:`名称 ${index}`}))));
});

test('预设校验模块占位符及当前选择所属模块',()=>{
  assert.throws(()=>promptPresetLibrarySchema.parse([samplePreset({instructions:{native_instruction:'不合法 {unknown}'}})]));
  assert.throws(()=>promptPresetLibrarySchema.parse([samplePreset({instructions:{native_instruction:'不合法 {viewpoint}'}})]));
  assert.doesNotThrow(()=>promptPresetLibrarySchema.parse([samplePreset({module:'viewpoint',instructions:{native_instruction:'从 {viewpoint} 观察 {images}'}})]));
  const settings=sampleSettings();
  assert.throws(()=>promptSettingsSchema.parse({...settings,selected_presets:{style:'preset_subject'}}));
  assert.throws(()=>promptSettingsSchema.parse({...settings,selected_presets:{subject:'missing'}}));
  assert.doesNotThrow(()=>promptSettingsSchema.parse({...settings,selected_presets:{subject:undefined}}));
});

test('旧格式导入保留预设库并清除选择，新整包可以明确恢复空库',()=>{
  const current=sampleSettings();
  const legacy={version:1 as const,modules:{style:{native_instruction:''}},roles:{}};
  const merged=mergeImportedPromptSettings(current,legacy);
  assert.deepEqual(merged.presets,current.presets);
  assert.deepEqual(merged.customizations,legacy);
  assert.deepEqual(merged.selected_presets,{});
  assert.deepEqual(current.selected_presets,{subject:'preset_subject'});
  assert.deepEqual(mergeImportedPromptSettings(current,createPromptSettings()),createPromptSettings());
});

test('v2 原子保存后优先读取完整设置，兼容载入旧 v1 配置',async()=>withRuntime(async directory=>{
  const legacy={version:1 as const,modules:{composition:{native_instruction:'旧构图'}},roles:{}};
  await writeFile(path.join(directory,promptCustomizationsFilename),JSON.stringify(legacy));
  const old=await loadPromptSettings(directory);
  assert.deepEqual(old.settings,createPromptSettings(legacy));
  const settings=sampleSettings();
  const saved=await savePromptSettings(directory,settings);
  assert.deepEqual(saved.settings,settings);
  assert.deepEqual(saved.customizations,settings.customizations);
  assert.equal(saved.config.modules.subject.native_instruction,'尚未存入预设的改动');
  await writeFile(path.join(directory,promptCustomizationsFilename),'{');
  assert.deepEqual((await loadPromptSettings(directory)).settings,settings);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,promptSettingsFilename),'utf8')),settings);
}));

test('只保存或删除预设库不改变已应用文字，删除当前预设只清除关联',async()=>withRuntime(async directory=>{
  const settings=sampleSettings();
  const applied=await savePromptSettings(directory,settings);
  const editedPreset=samplePreset({instructions:{native_instruction:'新预设文字，不自动应用'}});
  const saved=await savePromptPresetLibrary(directory,[editedPreset,samplePreset({id:'preset_style',module:'style'})]);
  assert.deepEqual(saved.config,applied.config);
  assert.deepEqual(saved.customizations,applied.customizations);
  assert.deepEqual(saved.settings.selected_presets,settings.selected_presets);
  assert.ok('instructions' in saved.settings.presets[0]);
  assert.equal(saved.settings.presets[0].instructions.native_instruction,'新预设文字，不自动应用');
  const removed=await savePromptPresetLibrary(directory,[]);
  assert.deepEqual(removed.settings.selected_presets,{});
  assert.deepEqual(removed.customizations,applied.customizations);
  assert.deepEqual((await loadPromptSettings(directory)).customizations,applied.customizations);
}));

test('旧保存接口更新 v2 而不丢预设，恢复默认保留库',async()=>withRuntime(async directory=>{
  const settings=sampleSettings();
  await savePromptSettings(directory,settings);
  const edited={version:1 as const,modules:{style:{native_instruction:'新的风格'}},roles:{}};
  await savePromptCustomizations(directory,edited);
  const loaded=await loadPromptSettings(directory);
  assert.deepEqual(loaded.customizations,edited);
  assert.deepEqual(loaded.settings.presets,settings.presets);
  assert.deepEqual(loaded.settings.selected_presets,{});
  const reset=await savePromptCustomizations(directory,emptyPromptCustomizations);
  assert.deepEqual(reset.config,releasePromptConfig);
  assert.deepEqual(reset.settings.presets,settings.presets);
  assert.deepEqual((await loadPromptSettings(directory)).customizations,emptyPromptCustomizations);
}));

test('整包导入导出可还原所有内容，非法文件或保存输入不覆盖已有配置',async()=>withRuntime(async directory=>{
  const settings=sampleSettings();
  const filename=path.join(directory,'用户自选位置.json');
  await savePromptSettings(directory,settings);
  await exportPromptSettings(filename,settings);
  assert.deepEqual(await importPromptSettings(filename),settings);
  await writeFile(filename,'\uFEFF'+JSON.stringify(emptyPromptCustomizations));
  assert.deepEqual(await importPromptSettings(filename),emptyPromptCustomizations);
  const original=await readFile(path.join(directory,promptSettingsFilename),'utf8');
  const invalid={...settings,presets:[samplePreset(),samplePreset()]};
  await writeFile(filename,JSON.stringify(invalid));
  await assert.rejects(importPromptSettings(filename),/格式无效/);
  await assert.rejects(savePromptSettings(directory,invalid));
  await assert.rejects(savePromptPresetLibrary(directory,invalid.presets));
  assert.equal(await readFile(path.join(directory,promptSettingsFilename),'utf8'),original);
  const invalidSource='{';
  await writeFile(path.join(directory,promptSettingsFilename),invalidSource);
  await assert.rejects(loadPromptSettings(directory),/原文件未修改/);
  await assert.rejects(savePromptCustomizations(directory,emptyPromptCustomizations),/原文件未修改/);
  assert.equal(await readFile(path.join(directory,promptSettingsFilename),'utf8'),invalidSource);
}));

test('角色预设保留原文花括号并区分使用默认和显式清空',()=>{
  const original=sampleRolePreset();
  assert.deepEqual(roleInstructionPresetSchema.parse(original),original);
  const defaults=roleInstructionPresetSchema.parse({id:'role_default',name:'默认角色',role:'general'});
  const empty=roleInstructionPresetSchema.parse({id:'role_empty',name:'清空角色',role:'general',instruction:''});
  assert.equal(Object.hasOwn(defaults,'instruction'),false);
  assert.equal(empty.instruction,'');
  assert.equal(presetTarget(original),'general');
  assert.equal(presetTarget(samplePreset()),'subject');
  assert.throws(()=>roleInstructionPresetSchema.parse({...original,instruction:'长'.repeat(32001)}));
  assert.throws(()=>roleInstructionPresetSchema.parse({...original,module:'subject',instructions:{}}));
});

test('预设名称只在具体模块或角色内去重，跨类别 ID 及错绑选择仍被拒绝',()=>{
  const module=samplePreset({name:'相同名字'}),general=sampleRolePreset({name:'相同名字'}),merchandiser=sampleRolePreset({id:'preset_merchandiser',role:'merchandiser',name:'相同名字'});
  const presets=[module,general,merchandiser];
  assert.doesNotThrow(()=>promptPresetLibrarySchema.parse(presets));
  assert.throws(()=>promptPresetLibrarySchema.parse([...presets,sampleRolePreset({id:'another_general',name:' 相同名字 '})]));
  assert.throws(()=>promptPresetLibrarySchema.parse([module,{...general,id:module.id}]));
  const settings={...createPromptSettings(),presets,selected_presets:{subject:module.id,general:general.id,merchandiser:merchandiser.id}};
  assert.doesNotThrow(()=>promptSettingsSchema.parse(settings));
  for(const selected_presets of [{subject:general.id},{general:module.id},{general:merchandiser.id},{merchandiser:general.id}]){
    assert.throws(()=>promptSettingsSchema.parse({...settings,selected_presets}));
  }
});

test('混合模块和角色整包完整往返，旧格式导入与恢复默认均保留角色库',async()=>withRuntime(async directory=>{
  const previous=sampleSettings();
  const settings=promptSettingsSchema.parse({...previous,
    customizations:{...previous.customizations,roles:{general:'当前角色的未存预设改动',merchandiser:''}},
    presets:[...previous.presets,sampleRolePreset(),sampleRolePreset({id:'preset_merchandiser',role:'merchandiser',instruction:''}),{id:'preset_default',name:'默认角色',role:'general'}],
    selected_presets:{...previous.selected_presets,general:'preset_general',merchandiser:'preset_merchandiser'},
  });
  const saved=await savePromptSettings(directory,settings);
  const registry=new ModuleRegistry(undefined,saved.config,saved.customizations.roles);
  assert.equal(registry.roleInstruction('general'),'当前角色的未存预设改动');
  assert.equal(registry.roleInstruction('merchandiser'),'');
  const filename=path.join(directory,'完整角色库.json');
  await exportPromptSettings(filename,settings);
  assert.deepEqual(await importPromptSettings(filename),settings);
  assert.deepEqual((await loadPromptSettings(directory)).settings,settings);
  const merged=mergeImportedPromptSettings(settings,emptyPromptCustomizations);
  assert.deepEqual(merged.presets,settings.presets);
  assert.deepEqual(merged.selected_presets,{});
  const reset=await savePromptSettings(directory,merged);
  assert.equal(new ModuleRegistry(undefined,reset.config,reset.customizations.roles).roleInstruction('general'),new ModuleRegistry().roleInstruction('general'));
  assert.deepEqual(reset.settings.presets,settings.presets);
}));

test('仅更新或删除角色预设不应用角色文字，非法绑定不会覆盖文件',async()=>withRuntime(async directory=>{
  const previous=sampleSettings();
  const settings=promptSettingsSchema.parse({...previous,presets:[...previous.presets,sampleRolePreset()],selected_presets:{...previous.selected_presets,general:'preset_general'}});
  await savePromptSettings(directory,settings);
  const saved=await savePromptPresetLibrary(directory,[...previous.presets,sampleRolePreset({instruction:'只改库，不应用角色'})]);
  assert.deepEqual(saved.customizations,settings.customizations);
  assert.deepEqual(saved.settings.selected_presets,settings.selected_presets);
  assert.equal(new ModuleRegistry(undefined,saved.config,saved.customizations.roles).roleInstruction('general'),'自定义角色');
  const filename=path.join(directory,promptSettingsFilename),before=await readFile(filename,'utf8');
  await assert.rejects(savePromptSettings(directory,{...saved.settings,selected_presets:{subject:'preset_general'}}));
  assert.equal(await readFile(filename,'utf8'),before);
  const removed=await savePromptPresetLibrary(directory,previous.presets);
  assert.deepEqual(removed.settings.selected_presets,previous.selected_presets);
  assert.deepEqual(removed.customizations,settings.customizations);
  assert.equal(new ModuleRegistry(undefined,removed.config,removed.customizations.roles).roleInstruction('general'),'自定义角色');
}));

test('推理设置向后兼容旧 v2，正文和预设区分默认与显式空串',()=>{
  const legacy=sampleSettings();
  assert.deepEqual(promptSettingsSchema.parse(JSON.parse(JSON.stringify(legacy))),legacy);
  assert.equal(Object.hasOwn(legacy,'inference_instructions'),false);
  const defaults=inferenceInstructionPresetSchema.parse({id:'infer_default',name:'跟随默认',kind:'inference',module:'style'});
  const empty=inferenceInstructionPresetSchema.parse({...defaults,id:'infer_empty',name:'清空',instruction:''});
  assert.equal(Object.hasOwn(defaults,'instruction'),false);
  assert.equal(empty.instruction,'');
  assert.equal(presetTarget(defaults),'inference:style');
  const inference_instructions={subject:'保留普通 {文字} 和 {"示例":1}',composition:'',style:'只观察文字排版',viewpoint:'只观察方向'};
  const settings=promptSettingsSchema.parse({...legacy,inference_instructions,presets:[...legacy.presets,defaults,empty]});
  assert.deepEqual(settings.inference_instructions,inference_instructions);
  assert.throws(()=>promptSettingsSchema.parse({...legacy,inference_instructions:{subject:'长'.repeat(32001)}}));
  assert.throws(()=>promptSettingsSchema.parse({...legacy,inference_instructions:{prompt:'未知模块'}}));
  assert.throws(()=>inferenceInstructionPresetSchema.parse({...defaults,instruction:'长'.repeat(32001)}));
});

test('推理预设和同模块生图预设分开命名并严格绑定各自目标',()=>{
  const generation=samplePreset({name:'同名'}),inference=sampleInferencePreset({name:'同名'}),otherInference=sampleInferencePreset({id:'infer_style',module:'style',name:'同名'});
  const presets=[generation,inference,otherInference,sampleRolePreset({name:'同名'})];
  assert.doesNotThrow(()=>promptPresetLibrarySchema.parse(presets));
  assert.throws(()=>promptPresetLibrarySchema.parse([...presets,{...inference,id:'infer_duplicate',name:' 同名 '}]));
  assert.throws(()=>promptPresetLibrarySchema.parse([generation,{...inference,id:generation.id}]));
  const settings={...createPromptSettings(),presets,selected_presets:{subject:generation.id,'inference:subject':inference.id,'inference:style':otherInference.id}};
  assert.doesNotThrow(()=>promptSettingsSchema.parse(settings));
  for(const selected_presets of [{subject:inference.id},{'inference:subject':generation.id},{'inference:composition':inference.id},{general:inference.id}]){
    assert.throws(()=>promptSettingsSchema.parse({...settings,selected_presets}));
  }
});

test('旧 v1 导入保留推理设置和选择，v2 整包仍明确替换全部内容',()=>{
  const previous=sampleSettings(),inference=sampleInferencePreset();
  const current=promptSettingsSchema.parse({...previous,inference_instructions:{subject:'当前推理要求',composition:''},presets:[...previous.presets,sampleRolePreset(),inference],selected_presets:{...previous.selected_presets,general:'preset_general','inference:subject':inference.id}});
  const imported=mergeImportedPromptSettings(current,emptyPromptCustomizations);
  assert.deepEqual(imported.customizations,emptyPromptCustomizations);
  assert.deepEqual(imported.inference_instructions,current.inference_instructions);
  assert.deepEqual(imported.presets,current.presets);
  assert.deepEqual(imported.selected_presets,{'inference:subject':inference.id});
  assert.deepEqual(mergeImportedPromptSettings(current,createPromptSettings()),createPromptSettings());
});

test('推理设置完整保存和导出，但不会混入生图配置或模块内容',async()=>withRuntime(async directory=>{
  const previous=sampleSettings(),preset=sampleInferencePreset();
  const marker='只在推理模型中使用的专属要求';
  const settings=promptSettingsSchema.parse({...previous,inference_instructions:{subject:marker,composition:''},presets:[...previous.presets,preset],selected_presets:{...previous.selected_presets,'inference:subject':preset.id}});
  const saved=await savePromptSettings(directory,settings);
  const loaded=await loadPromptSettings(directory);
  assert.deepEqual(loaded.settings,settings);
  assert.deepEqual(saved.config,(await savePromptSettings(directory,{...settings,inference_instructions:{}})).config);
  await savePromptSettings(directory,settings);
  assert.equal(JSON.stringify(saved.config).includes(marker),false);
  assert.equal(JSON.stringify(saved.customizations).includes(marker),false);
  const registry=new ModuleRegistry(undefined,loaded.config,loaded.customizations.roles,loaded.settings.inference_instructions);
  assert.equal(registry.inferenceInstruction('subject'),marker);
  assert.equal(registry.inferenceInstruction('composition'),'');
  assert.equal(registry.inferenceInstruction('style'),defaultModuleInferenceInstructions.style);
  assert.equal(JSON.stringify(registry.create('subject')).includes(marker),false);
  const filename=path.join(directory,'完整推理配置.json');
  await exportPromptSettings(filename,settings);
  assert.deepEqual(await importPromptSettings(filename),settings);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,promptSettingsFilename),'utf8')),settings);
}));

test('仅存推理预设库和旧保存接口保留已应用推理正文，删除只清关联',async()=>withRuntime(async directory=>{
  const previous=sampleSettings(),preset=sampleInferencePreset();
  const settings=promptSettingsSchema.parse({...previous,inference_instructions:{subject:'当前推理正文'},presets:[...previous.presets,preset],selected_presets:{...previous.selected_presets,'inference:subject':preset.id}});
  const applied=await savePromptSettings(directory,settings);
  const saved=await savePromptPresetLibrary(directory,[...previous.presets,{...preset,instruction:'新的预设正文'}]);
  assert.deepEqual(saved.config,applied.config);
  assert.deepEqual(saved.customizations,applied.customizations);
  assert.deepEqual(saved.settings.inference_instructions,applied.settings.inference_instructions);
  assert.deepEqual(saved.settings.selected_presets,applied.settings.selected_presets);
  const legacySave=await savePromptCustomizations(directory,emptyPromptCustomizations);
  assert.deepEqual(legacySave.settings.inference_instructions,settings.inference_instructions);
  assert.deepEqual(legacySave.settings.selected_presets,{'inference:subject':preset.id});
  const filename=path.join(directory,promptSettingsFilename),before=await readFile(filename,'utf8');
  await assert.rejects(savePromptSettings(directory,{...legacySave.settings,inference_instructions:{subject:'长'.repeat(32001)}}));
  assert.equal(await readFile(filename,'utf8'),before);
  const removed=await savePromptPresetLibrary(directory,previous.presets);
  assert.deepEqual(removed.settings.selected_presets,{});
  assert.deepEqual(removed.settings.inference_instructions,settings.inference_instructions);
  assert.deepEqual((await loadPromptSettings(directory)).settings.inference_instructions,settings.inference_instructions);
}));
