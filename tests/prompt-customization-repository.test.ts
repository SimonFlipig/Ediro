import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadPromptSettings,savePromptCustomizations,importPromptCustomizations,exportPromptCustomizations,promptCustomizationsFilename} from '../src/adapters/prompt-config-repository.js';
import {releasePromptConfig} from '../src/core/release-prompt-config.js';
import {emptyPromptCustomizations} from '../src/core/prompt-customization.js';
import {ModuleRegistry} from '../src/core/modules.js';

test('新安装只提供空的自定义配置，保存和恢复不改变发布默认',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ediro-custom-prompts-'));
  try{
    const released=structuredClone(releasePromptConfig);
    const first=await loadPromptSettings(dir);
    assert.deepEqual(first.config,released);
    assert.deepEqual(first.customizations,emptyPromptCustomizations);
    const custom={version:1 as const,modules:{subject:{native_instruction:'我的主体 {images}'}},roles:{merchandiser:'我的陈列师'}};
    const saved=await savePromptCustomizations(dir,custom);
    assert.equal(new ModuleRegistry(undefined,saved.config,saved.customizations.roles).get('subject').base_instruction,'我的主体 {images}');
    assert.equal(saved.config.modules.subject.numbered_instruction,released.modules.subject.numbered_instruction);
    assert.deepEqual((await loadPromptSettings(dir)).customizations,custom);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir,promptCustomizationsFilename),'utf8')),custom);
    const reset=await savePromptCustomizations(dir,structuredClone(emptyPromptCustomizations));
    assert.deepEqual(reset.config,released);
    assert.deepEqual(releasePromptConfig,released);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('旧 Tuner 只识别与出厂不同的文字，恢复不会唤回旧覆盖或改写原文件',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ediro-legacy-prompts-'));
  try{
    const legacy=structuredClone(releasePromptConfig);
    legacy.revision='legacy-private';legacy.module_header='[{module_number}] {module}';
    legacy.modules.subject.native_instruction='旧的私人主体指令';
    legacy.modules.subject.model_name='商品身份';
    legacy.modules.style={numbered_instruction:''};
    const raw=JSON.stringify(legacy),filename=path.join(dir,'prompt-config.v1.json');
    await writeFile(filename,raw);
    const loaded=await loadPromptSettings(dir);
    // An omitted legacy field follows the current release even before the
    // first settings save, rather than briefly reviving the low-level default.
    const expected=structuredClone(legacy);
    expected.modules.style.native_instruction=releasePromptConfig.modules.style.native_instruction;
    assert.deepEqual(loaded.config,expected);
    assert.deepEqual(loaded.customizations,{version:1,modules:{subject:{native_instruction:'旧的私人主体指令'},style:{numbered_instruction:''}},roles:{}});
    const migrated=await savePromptCustomizations(dir,loaded.customizations);
    const before=new ModuleRegistry(undefined,loaded.config),after=new ModuleRegistry(undefined,migrated.config);
    for(const type of ['subject','composition','style','viewpoint'])assert.deepEqual(after.get(type),before.get(type));
    await savePromptCustomizations(dir,structuredClone(emptyPromptCustomizations));
    const reset=await loadPromptSettings(dir);
    assert.equal(reset.config.modules.subject.native_instruction,releasePromptConfig.modules.subject.native_instruction);
    assert.equal(reset.config.modules.subject.model_name,'商品身份');
    assert.equal(reset.config.module_header,legacy.module_header);
    assert.deepEqual(reset.customizations,emptyPromptCustomizations);
    assert.equal(await readFile(filename,'utf8'),raw);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('导入导出只往返用户覆盖，非法输入不会改变已生效配置',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ediro-import-prompts-'));
  try{
    const custom={version:1 as const,modules:{viewpoint:{numbered_instruction:'从 {viewpoint} 观察 {images}'}},roles:{general:'中文角色，可包含普通 {文字}。'}};
    const exported=path.join(dir,'自定义.json');
    await savePromptCustomizations(dir,custom);
    await exportPromptCustomizations(exported,custom);
    assert.deepEqual(await importPromptCustomizations(exported),custom);
    assert.doesNotMatch(await readFile(exported,'utf8'),/Preserve the subject|commercial product stylist/);
    await writeFile(exported,JSON.stringify({...custom,roles:{unknown:'不支持的角色'}}));
    await assert.rejects(importPromptCustomizations(exported),/格式无效/);
    await assert.rejects(savePromptCustomizations(dir,{...custom,modules:{subject:{native_instruction:'错误 {unknown}'}}}));
    assert.deepEqual((await loadPromptSettings(dir)).customizations,custom);
    await writeFile(exported,'\uFEFF'+JSON.stringify(custom));
    assert.deepEqual(await importPromptCustomizations(exported),custom);
    await writeFile(path.join(dir,promptCustomizationsFilename),'{');
    await assert.rejects(loadPromptSettings(dir),/原文件未修改/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
