import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRecipe } from '../src/core/compiler.js';
import { defaultParameters, recipeSchema, type Recipe } from '../src/core/domain.js';
import { defaultModuleSettings, moduleSettingsSchema } from '../src/core/module-settings.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { resolvePromptRole } from '../src/core/prompt-roles.js';

test('新提示词采用默认角色，默认变更不覆盖已有模块，复制保留原选择',()=>{
  const registry=new ModuleRegistry(),settings=structuredClone(defaultModuleSettings);
  const original=registry.create('prompt',settings);
  settings.prompt.role='merchandiser';
  const next=registry.create('prompt',settings);
  assert.equal(original.prompt_role,'general');assert.equal(next.prompt_role,'merchandiser');
  settings.prompt.role='general';
  assert.equal(next.prompt_role,'merchandiser');
  const copied=registry.copy(next,settings);
  assert.equal(copied.prompt_role,'merchandiser');assert.notEqual(copied.module_id,next.module_id);
  assert.equal(registry.create('subject',settings).prompt_role,undefined);
});

test('旧工程角色缺省为通用，工程解析保留显式选择并拒绝未知角色',()=>{
  const registry=new ModuleRegistry(),prompt=registry.create('prompt');delete prompt.prompt_role;
  const recipe:Recipe={recipe_id:'recipe_prompt_roles',schema_version:1,modules:[prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const legacy=recipeSchema.parse(JSON.parse(JSON.stringify(recipe)));
  assert.equal(legacy.modules[0].prompt_role,undefined);
  assert.equal(resolvePromptRole(legacy.modules[0]),'general');
  const settings=structuredClone(defaultModuleSettings);settings.prompt.role='merchandiser';
  assert.equal(resolvePromptRole(registry.copy(legacy.modules[0],settings)),'general');
  prompt.prompt_role='merchandiser';
  assert.equal(recipeSchema.parse(JSON.parse(JSON.stringify(recipe))).modules[0].prompt_role,'merchandiser');
  assert.throws(()=>recipeSchema.parse({...recipe,modules:[{...prompt,prompt_role:'unknown'}]}));
  assert.throws(()=>moduleSettingsSchema.parse({...settings,prompt:{role:'unknown'}}));
});

test('角色定义不会作为额外文字发给生图模型',()=>{
  const registry=new ModuleRegistry(),prompt=registry.create('prompt');prompt.user_instruction='亚麻背景，木质台座，柔和侧光。';
  const recipe:Recipe={recipe_id:'recipe_prompt_generation',schema_version:1,modules:[prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const general=compileRecipe(recipe,registry);
  prompt.prompt_role='merchandiser';
  assert.deepEqual(compileRecipe(recipe,registry),general);
});
