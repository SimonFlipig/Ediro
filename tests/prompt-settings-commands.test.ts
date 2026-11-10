import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchema } from '../src/shared/commands.js';
import { createPromptSettings, type ModuleInstructionPreset, type RoleInstructionPreset, type InferenceInstructionPreset } from '../src/core/prompt-settings.js';

const preset:ModuleInstructionPreset={id:'preset_subject',name:'主体保真',module:'subject',instructions:{native_instruction:'保留 {images} 的主体结构。',numbered_instruction:''}};

test('提示词命令边界保留整包、库独立保存和旧版命令',()=>{
  const settings=createPromptSettings({version:1,modules:{subject:preset.instructions},roles:{general:'整理画面条件。'}});
  settings.presets=[preset];settings.selected_presets.subject=preset.id;
  const commands=[
    {type:'prompt-settings:save',settings},
    {type:'prompt-presets:save',presets:[preset]},
    {type:'prompt-customizations:export',customizations:settings.customizations,settings},
    {type:'prompt-customizations:save',customizations:settings.customizations},
    {type:'prompt-customizations:export',customizations:settings.customizations},
  ];
  for(const command of commands)assert.deepEqual(commandSchema.parse(command),command);
});

test('提示词命令拒绝悬空选择、非法模板和重复预设',()=>{
  const settings=createPromptSettings();settings.selected_presets.subject='missing';
  assert.equal(commandSchema.safeParse({type:'prompt-settings:save',settings}).success,false);
  assert.equal(commandSchema.safeParse({type:'prompt-customizations:export',customizations:settings.customizations,settings}).success,false);
  assert.equal(commandSchema.safeParse({type:'prompt-presets:save',presets:[preset,preset]}).success,false);
  assert.equal(commandSchema.safeParse({type:'prompt-presets:save',presets:[{...preset,instructions:{native_instruction:'使用 {viewpoint}'}}]}).success,false);
});

test('角色预设命令保留角色正文、普通花括号和默认与清空状态',()=>{
  const rolePresets:RoleInstructionPreset[]=[
    {id:'preset_general',name:'完整整理',role:'general',instruction:'按 {主体} 与 {环境} 整理，示例 {"focus":"product"}。'},
    {id:'preset_merchandiser',name:'默认陈列师',role:'merchandiser'},
    {id:'preset_empty_role',name:'清空角色',role:'general',instruction:''},
  ];
  const settings=createPromptSettings();
  settings.presets=[preset,...rolePresets];
  settings.selected_presets={subject:preset.id,general:rolePresets[0].id,merchandiser:rolePresets[1].id};
  settings.customizations.roles.general=rolePresets[0].instruction;
  const commands=[
    {type:'prompt-presets:save',presets:settings.presets},
    {type:'prompt-settings:save',settings},
    {type:'prompt-customizations:export',customizations:settings.customizations,settings},
  ];
  for(const command of commands)assert.deepEqual(commandSchema.parse(command),command);
});

test('角色预设不能被不同角色或模块选中',()=>{
  const settings=createPromptSettings();
  settings.presets=[preset,{id:'preset_general',name:'通用要求',role:'general',instruction:'整理条件。'}];
  for(const selected_presets of [
    {merchandiser:'preset_general'},
    {subject:'preset_general'},
    {general:preset.id},
  ]){
    const invalid={...settings,selected_presets};
    assert.equal(commandSchema.safeParse({type:'prompt-settings:save',settings:invalid}).success,false);
    assert.equal(commandSchema.safeParse({type:'prompt-customizations:export',customizations:settings.customizations,settings:invalid}).success,false);
  }
});

test('推理设置命令保留独立正文、混合预设库及默认与清空状态',()=>{
  const inferencePresets:InferenceInstructionPreset[]=[
    {id:'infer_subject',name:'主体理解',kind:'inference',module:'subject',instruction:'按 {用户要求} 理解主体，字面示例 {"item":1}。'},
    {id:'infer_style_default',name:'默认风格理解',kind:'inference',module:'style'},
    {id:'infer_style_empty',name:'关闭风格附加要求',kind:'inference',module:'style',instruction:''},
  ];
  const settings=createPromptSettings();
  settings.inference_instructions={subject:inferencePresets[0].instruction,style:''};
  settings.presets=[preset,...inferencePresets];
  settings.selected_presets={subject:preset.id,'inference:subject':inferencePresets[0].id,'inference:style':inferencePresets[2].id};
  const commands=[
    {type:'prompt-presets:save',presets:settings.presets},
    {type:'prompt-settings:save',settings},
    {type:'prompt-customizations:export',customizations:settings.customizations,settings},
  ];
  for(const command of commands)assert.deepEqual(commandSchema.parse(command),command);
  assert.deepEqual(settings.customizations,{version:1,modules:{},roles:{}});
});

test('推理设置命令拒绝跨用途选择、未知目标和过长指令',()=>{
  const settings=createPromptSettings();
  settings.presets=[preset,{id:'infer_subject',name:'主体理解',kind:'inference',module:'subject',instruction:'只理解必要主体条件。'}];
  for(const selected_presets of [{subject:'infer_subject'},{'inference:subject':preset.id},{'inference:style':'infer_subject'},{general:'infer_subject'}]){
    const invalid={...settings,selected_presets};
    assert.equal(commandSchema.safeParse({type:'prompt-settings:save',settings:invalid}).success,false);
    assert.equal(commandSchema.safeParse({type:'prompt-customizations:export',customizations:settings.customizations,settings:invalid}).success,false);
  }
  for(const inference_instructions of [{prompt:'未知目标'},{style:'长'.repeat(32001)}]){
    assert.equal(commandSchema.safeParse({type:'prompt-settings:save',settings:{...settings,inference_instructions}}).success,false);
  }
  assert.equal(commandSchema.safeParse({type:'prompt-presets:save',presets:[{id:'infer_invalid',name:'错误预设',kind:'inference',module:'prompt',instruction:'未知模块'}]}).success,false);
});
