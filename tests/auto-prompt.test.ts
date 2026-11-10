import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getAutoPromptState } from '../src/core/auto-prompt.js';
import { defaultParameters, recipeSchema, type Asset, type Recipe } from '../src/core/domain.js';
import { defaultModuleSettings } from '../src/core/module-settings.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { defaultPromptConfig } from '../src/core/prompt-config.js';
import { buildPromptSystemInstruction } from '../src/core/module-inference-tasks.js';
import { defaultModuleInferenceInstructions } from '../src/core/module-inference-instructions.js';

function fixture(){
  const registry=new ModuleRegistry(),settings=structuredClone(defaultModuleSettings);
  const subject=registry.create('subject'),composition=registry.create('composition'),style=registry.create('style'),otherPrompt=registry.create('prompt'),target=registry.create('prompt'),disabled=registry.create('style');
  subject.asset_ids=['asset_subject'];subject.user_instruction='白色沙发';
  composition.asset_ids=['asset_comp'];composition.user_instruction='居中';
  style.asset_ids=['asset_style'];style.user_instruction='户外';
  otherPrompt.user_instruction='不要增加文字';target.auto_prompt=true;target.user_instruction='原文';disabled.enabled=false;disabled.asset_ids=['asset_disabled'];
  const recipe:Recipe={recipe_id:'recipe_auto_prompt',schema_version:1,modules:[subject,composition,style,otherPrompt,target,disabled],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const assets:Asset[]=[{asset_id:'asset_comp',name:'composition.png',location:{type:'external',path:'D:\\samples\\composition.png',sha256:'a'.repeat(64),size:1024,modified_at:1},thumbnail_path:'thumb.png',width:2048,height:1024,mime_type:'image/png',created_at:'2026-10-22T00:00:00.000Z',kind:'import'}];
  const state=()=>getAutoPromptState(recipe,registry,settings,assets)!;
  return{registry,settings,subject,composition,style,otherPrompt,target,disabled,recipe,assets,state};
}

test('只选第一个启用的自动提示词目标，关闭开关时不拦生图且保留旧结果',()=>{
  const f=fixture();f.target.auto_prompt=false;assert.equal(f.state(),undefined);
  f.otherPrompt.auto_prompt=true;f.target.auto_prompt=true;assert.equal(f.state().module_id,f.otherPrompt.module_id);
  f.otherPrompt.enabled=false;assert.equal(f.state().module_id,f.target.module_id);
  f.subject.auto_prompt=true;f.target.auto_prompt=false;assert.equal(f.state(),undefined);
  assert.equal(f.target.user_instruction,'原文');
});

test('成功 key 随工程保存并复用，目标正文任意手动修改不强制重新推理',()=>{
  const f=fixture(),first=f.state();assert.equal(first.needs_inference,true);assert.match(first.input_key,/^auto-v5:[a-f0-9]{64}$/);
  f.target.auto_prompt_input_key=first.input_key;assert.equal(f.state().needs_inference,false);
  for(const text of ['人工修订', '', '复杂字符 🪑\u0000']){f.target.user_instruction=text;assert.deepEqual(f.state(),{...first,needs_inference:false});}
  const reopened=recipeSchema.parse(JSON.parse(JSON.stringify(f.recipe)));
  assert.equal(getAutoPromptState(reopened,f.registry,f.settings,f.assets)!.needs_inference,false);
  f.target.auto_prompt=false;f.target.auto_prompt=true;assert.equal(f.state().needs_inference,false);
});

test('仅当前自动提示词的角色影响复用，默认值和其它模块角色不改变已生成结果',()=>{
  const f=fixture(),general=f.state().input_key;f.target.auto_prompt_input_key=general;
  delete f.target.prompt_role;assert.equal(f.state().input_key,general);
  f.settings.prompt.role='merchandiser';assert.equal(f.state().needs_inference,false);
  f.otherPrompt.prompt_role='merchandiser';assert.equal(f.state().input_key,general);
  f.target.prompt_role='merchandiser';const display=f.state().input_key;
  assert.notEqual(display,general);assert.equal(f.state().needs_inference,true);
  f.target.auto_prompt_input_key=display;f.target.user_instruction='用户调整陈列细节';
  assert.equal(f.state().needs_inference,false);
  const reopened=recipeSchema.parse(JSON.parse(JSON.stringify(f.recipe)));
  assert.equal(getAutoPromptState(reopened,f.registry,f.settings,f.assets)!.needs_inference,false);
  f.target.prompt_role='general';assert.equal(f.state().input_key,general);assert.equal(f.state().needs_inference,true);
});

test('生成模型、输出参数、图像预处理和未启用模块不影响复用',()=>{
  const f=fixture(),key=f.state().input_key;
  f.recipe.model_config_id='model_other';f.recipe.input_strategy='numbered_flat';f.recipe.core_parameters.count=3;f.recipe.core_parameters.aspect_ratio='16:9';
  f.composition.reference_settings!.preprocess='depth';f.composition.reference_settings!.blur_strength='strong';f.style.reference_settings!.preprocess='segment';
  f.settings.composition.max_edge=512;f.settings.style.preprocess='blur';
  f.disabled.user_instruction='禁用模块变化';f.disabled.asset_ids=['asset_other'];f.disabled.reference_mode='text_only';
  f.target.title='改名字';f.subject.title='另一个显示标题';
  assert.equal(f.state().input_key,key);
  f.subject.reference_mode='text_only';assert.equal(f.state().input_key,key);
});

test('模块换位不建议更新，不修改实际顺序或正文，也不清除已有更新建议',()=>{
  const f=fixture(),key=f.state().input_key;f.target.auto_prompt_input_key=key;
  f.recipe.modules.reverse();const reordered=structuredClone(f.recipe);
  assert.equal(f.state().needs_inference,false);assert.equal(f.state().input_key,key);
  assert.deepEqual(f.recipe,reordered);
  const reopened=recipeSchema.parse(JSON.parse(JSON.stringify(f.recipe)));
  assert.equal(getAutoPromptState(reopened,f.registry,f.settings,f.assets)!.needs_inference,false);
  f.subject.user_instruction='蓝色柜子';assert.equal(f.state().needs_inference,true);
  f.recipe.modules.reverse();assert.equal(f.state().needs_inference,true);
  assert.equal(f.target.user_instruction,'原文');assert.equal(f.target.auto_prompt_input_key,key);
});

test('其它启用模块的文字、类型、图片和参考模式变化均会过期',()=>{
  const changes:Array<(f:ReturnType<typeof fixture>)=>void>=[
    f=>{f.subject.user_instruction='黑色沙发';},
    f=>{f.otherPrompt.user_instruction='保留品牌文字';},
    f=>{f.style.reference_type='composition';},
    f=>{f.composition.asset_ids.push('asset_other');},
    f=>{f.composition.asset_ids=['asset_replaced'];},
    f=>{f.composition.reference_mode='text_only';},
    f=>{f.composition.reference_settings!.max_edge=512;},
    f=>{f.disabled.enabled=true;},
    f=>{f.subject.enabled=false;},
    f=>{f.subject.tool_state={yaw:30};},
  ];
  for(const change of changes){const f=fixture(),key=f.state().input_key;f.target.auto_prompt_input_key=key;change(f);assert.notEqual(f.state().input_key,key);assert.equal(f.state().needs_inference,true);assert.equal(f.target.user_instruction,'原文');assert.equal(f.target.auto_prompt_input_key,key);}
});

test('旧模块使用当前缩图默认值，已有明确尺寸不随默认值变化',()=>{
  const f=fixture();delete f.composition.reference_settings;
  const original=f.state().input_key;f.settings.composition.max_edge=512;assert.notEqual(f.state().input_key,original);
  const smaller=f.state().input_key;f.composition.reference_settings={max_edge:512,preprocess:'blur',blur_strength:'weak'};
  assert.equal(f.state().input_key,smaller);f.settings.composition.max_edge=1024;assert.equal(f.state().input_key,smaller);
  f.composition.reference_mode='image_text';assert.equal(f.state().input_key,smaller);
});

test('外部图片同 ID 换内容按 sha 失效，同内容重定位和名称变化不失效',()=>{
  const f=fixture(),key=f.state().input_key,location=f.assets[0].location;
  assert.equal(location.type,'external');if(location.type!=='external')throw new Error('fixture');
  location.path='D:\\relocated\\same.png';location.modified_at=2;f.assets[0].name='renamed';assert.equal(f.state().input_key,key);
  location.sha256='b'.repeat(64);assert.notEqual(f.state().input_key,key);
});

test('四模块生图指令不影响复用，参与模块的有效推理规则变化才失效',()=>{
  const f=fixture(),withoutViewpoint=f.state().input_key;
  const unusedViewpoint=new ModuleRegistry(undefined,defaultPromptConfig,{}, {viewpoint:'未参与的视角规则'});
  assert.equal(getAutoPromptState(f.recipe,unusedViewpoint,f.settings,f.assets)!.input_key,withoutViewpoint);
  const viewpoint=f.registry.create('viewpoint');viewpoint.user_instruction='正面观察';f.recipe.modules.push(viewpoint);
  const key=f.state().input_key;f.target.auto_prompt_input_key=key;
  for(const module of [f.subject,f.composition,f.style,viewpoint]){
    module.base_instruction='旧工程携带的旧定义';module.numbered_instruction='旧工程的编号定义';
  }
  assert.equal(f.state().input_key,key);
  for(const type of ['subject','composition','style','viewpoint'] as const){
    const config=structuredClone(defaultPromptConfig);config.modules[type]={native_instruction:'新的生图要求',numbered_instruction:'新的编号生图要求'};
    assert.equal(getAutoPromptState(f.recipe,new ModuleRegistry(undefined,config),f.settings,f.assets)!.input_key,key);
    const same=new ModuleRegistry(undefined,defaultPromptConfig,{}, {[type]:defaultModuleInferenceInstructions[type]});
    assert.equal(getAutoPromptState(f.recipe,same,f.settings,f.assets)!.needs_inference,false);
    for(const instruction of ['新的独立推理要求','']){
      const changed=new ModuleRegistry(undefined,defaultPromptConfig,{}, {[type]:instruction});
      const state=getAutoPromptState(f.recipe,changed,f.settings,f.assets)!;
      assert.notEqual(state.input_key,key);assert.equal(state.needs_inference,true);
    }
  }
  const config=structuredClone(defaultPromptConfig);config.modules.prompt={native_instruction:'新的目标语义'};
  assert.notEqual(getAutoPromptState(f.recipe,new ModuleRegistry(undefined,config),f.settings,f.assets)!.input_key,key);
  assert.equal(f.target.user_instruction,'原文');assert.equal(f.target.auto_prompt_input_key,key);
});

test('对象键顺序不影响复用，图片顺序与相邻文字边界不会碰撞',()=>{
  const f=fixture();f.subject.tool_state={yaw:30,pitch:10};const key=f.state().input_key;
  f.subject.tool_state={pitch:10,yaw:30};assert.equal(f.state().input_key,key);
  f.composition.asset_ids=['asset_one','asset_two'];const ordered=f.state().input_key;f.composition.asset_ids.reverse();assert.notEqual(f.state().input_key,ordered);
  f.subject.user_instruction='ab';f.style.user_instruction='c';const first=f.state().input_key;
  f.subject.user_instruction='a';f.style.user_instruction='bc';assert.notEqual(f.state().input_key,first);
});

test('浏览器可用同步摘要符合完整 SHA-256 且长文本不扩大持久化 key',()=>{
  const registry=new ModuleRegistry(),target=registry.create('prompt');target.module_id='mod_target';target.auto_prompt=true;
  const recipe:Recipe={recipe_id:'recipe_hash',schema_version:1,modules:[target],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const system_instruction=buildPromptSystemInstruction(registry.roleInstruction('general'));
  const canonical=JSON.stringify({modules:[{base_instruction:'',images:[],model_name:'prompt',module_id:'mod_target',reference_type:'prompt'}],system_instruction,target_module_id:'mod_target'});
  assert.equal(getAutoPromptState(recipe,registry,defaultModuleSettings)!.input_key,'auto-v5:'+createHash('sha256').update(canonical).digest('hex'));
  const legacyCanonical='{"modules":[{"base_instruction":"","images":[],"model_name":"prompt","module_id":"mod_target","reference_type":"prompt"}],"target_module_id":"mod_target"}';
  for(const prefix of ['auto-v1:','auto-v2:','auto-v3:','auto-v4:']){
    target.auto_prompt_input_key=prefix+createHash('sha256').update(prefix==='auto-v3:'||prefix==='auto-v4:'?canonical:legacyCanonical).digest('hex');
    const before=structuredClone(recipe);
    assert.equal(getAutoPromptState(recipe,registry,defaultModuleSettings)!.needs_inference,true);
    assert.deepEqual(recipe,before,'new rules only suggest refreshing; they never change existing text or saved keys');
  }
  const other=registry.create('prompt');other.module_id='mod_other';other.user_instruction='中文 🪑'.repeat(4000);recipe.modules.push(other);
  const longCanonical=JSON.stringify({modules:[
    {base_instruction:'',images:[],model_name:'prompt',module_id:'mod_other',reference_type:'prompt',user_instruction:other.user_instruction},
    {base_instruction:'',images:[],model_name:'prompt',module_id:'mod_target',reference_type:'prompt'},
  ],system_instruction,target_module_id:'mod_target'});
  const longKey=getAutoPromptState(recipe,registry,defaultModuleSettings)!.input_key;
  assert.equal(longKey,'auto-v5:'+createHash('sha256').update(longCanonical).digest('hex'));
  assert.equal(longKey.length,72);
});
