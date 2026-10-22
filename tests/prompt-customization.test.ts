import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPromptCustomizations, emptyPromptCustomizations, promptCustomizationsSchema } from '../src/core/prompt-customization.js';
import { previewModuleInstructions } from '../src/core/prompt-customization-preview.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { compileRecipe, defaultInputStrategies } from '../src/core/compiler.js';
import { defaultParameters, type Recipe } from '../src/core/domain.js';
import { releasePromptConfig } from '../src/core/release-prompt-config.js';
import { promptRoles } from '../src/core/prompt-roles.js';
import { prepareModuleInference } from '../src/core/module-inference.js';
import { seedModels } from '../src/core/models.js';
import { getAutoPromptState } from '../src/core/auto-prompt.js';
import { defaultModuleSettings } from '../src/core/module-settings.js';

function fixture(registry=new ModuleRegistry(undefined,releasePromptConfig)){
  const subject=registry.create('subject'),prompt=registry.create('prompt');
  subject.asset_ids=['asset_custom_subject'];prompt.auto_prompt=true;prompt.user_instruction='保留当前文字。';
  const recipe:Recipe={schema_version:1,recipe_id:'recipe_custom',modules:[subject,prompt],model_config_id:'model_mock_native',core_parameters:structuredClone(defaultParameters)};
  return {registry,subject,prompt,recipe};
}
const textOf=(blocks:ReturnType<typeof compileRecipe>['blocks'])=>blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');

test('自定义文件只接受固定模块和角色的覆盖，空串可清空但未知字段及占位符被拒绝',()=>{
  const input={version:1,modules:{subject:{native_instruction:'',numbered_instruction:'保留 {images}。'},viewpoint:{native_instruction:'视角 {viewpoint}'}},roles:{general:'自己的角色 {不是模板}。'}};
  assert.deepEqual(promptCustomizationsSchema.parse(input),input);
  for(const invalid of [
    {...input,version:2}, {...input,credentials:{}}, {...input,modules:{unknown:{}}},
    {...input,roles:{unknown:'无效'}}, {...input,modules:{subject:{model_name:'不属于此文件'}}},
    {...input,modules:{subject:{native_instruction:'{viewpoint}'}}},
    {...input,modules:{style:{native_instruction:'{unknown}'}}},
    {...input,modules:{style:{native_instruction:'{images'}}},
    {...input,roles:{general:'a'.repeat(32001)}},
  ])assert.throws(()=>promptCustomizationsSchema.parse(invalid));
});

test('单项覆盖保留另一组默认表达且不修改发布默认；恢复为空覆盖即可使用新默认',()=>{
  const before=structuredClone(releasePromptConfig);
  const native=applyPromptCustomizations(releasePromptConfig,{version:1,modules:{subject:{native_instruction:'我的原生表达'}},roles:{}});
  assert.equal(new ModuleRegistry(undefined,native).get('subject').base_instruction,'我的原生表达');
  assert.equal(new ModuleRegistry(undefined,native).get('subject').numbered_instruction,new ModuleRegistry(undefined,releasePromptConfig).get('subject').numbered_instruction);
  const numbered=applyPromptCustomizations(releasePromptConfig,{version:1,modules:{subject:{numbered_instruction:'我的编号表达 {images}'}},roles:{}});
  assert.equal(new ModuleRegistry(undefined,numbered).get('subject').base_instruction,new ModuleRegistry(undefined,releasePromptConfig).get('subject').base_instruction);
  assert.deepEqual(applyPromptCustomizations(releasePromptConfig,emptyPromptCustomizations),releasePromptConfig);
  assert.deepEqual(releasePromptConfig,before);
});

test('原生清空仍保留编号表达，编号清空不影响原生，均不偷偷回填默认指令',()=>{
  const config=applyPromptCustomizations(releasePromptConfig,{version:1,modules:{subject:{native_instruction:'',numbered_instruction:'仅编号 {images}'}},roles:{}});
  config.modules.subject.header=false;
  const f=fixture(new ModuleRegistry(undefined,config)),chain=compileRecipe(f.recipe,f.registry);
  const native=defaultInputStrategies.get('interleaved').compile(chain).blocks!;
  const flat=defaultInputStrategies.get('numbered_flat').compile(chain).prompt!;
  assert.equal(native.some(block=>block.type==='text'&&block.text_role==='instruction'),false);
  assert.match(flat,/仅编号 image_1/);assert.doesNotMatch(flat,/Preserve/);
  config.modules.subject.native_instruction='仅原生';config.modules.subject.numbered_instruction='';
  const reverse=compileRecipe(f.recipe,new ModuleRegistry(undefined,config));
  assert.match(textOf(defaultInputStrategies.get('interleaved').compile(reverse).blocks!),/仅原生/);
  assert.doesNotMatch(defaultInputStrategies.get('numbered_flat').compile(reverse).prompt!,/仅原生|Preserve/);
});

test('预览只编译当前项，分别展开两组图片表达，不泄露其它模块或出厂文字',()=>{
  const config=structuredClone(releasePromptConfig);
  config.modules.style={native_instruction:'不得泄露的其它模块'};
  const preview=previewModuleInstructions('subject',{native_instruction:'原生 {images}',numbered_instruction:'编号 {images}'},{imageCount:2,config});
  assert.equal(textOf(preview.native),'原生 image_1, image_2');
  assert.deepEqual(preview.native.filter(block=>block.type==='image').map(block=>block.image_name),['image_1','image_2']);
  assert.equal(preview.numbered,'编号 image_1, image_2');
  assert.deepEqual(preview.images,['image_1','image_2']);
  for(const result of [JSON.stringify(preview.native),preview.numbered])assert.doesNotMatch(result,/Preserve|不得泄露|隐藏|默认|##/);
  assert.equal(new Set(preview.native.map(block=>block.source_module_id)).size,1);
});

test('空白和未覆盖的预览独立为空，视角占位符使用同一实际编译器',()=>{
  assert.deepEqual(previewModuleInstructions('subject',{}),{native:[],numbered:'',images:[]});
  assert.deepEqual(previewModuleInstructions('subject',{native_instruction:'  ',numbered_instruction:''}),{native:[],numbered:'',images:[]});
  const numbered=previewModuleInstructions('subject',{numbered_instruction:'编号 {images}'});
  assert.deepEqual(numbered.native,[]);assert.equal(numbered.numbered,'编号 image_1');
  const native=previewModuleInstructions('subject',{native_instruction:'原生 {images}'});
  assert.equal(native.numbered,'');assert.deepEqual(native.images,[]);
  const viewpoint=previewModuleInstructions('viewpoint',{native_instruction:'我的角度 {viewpoint}',numbered_instruction:'{images}，{viewpoint}'},{toolState:{yaw:0,pitch:0,roll:0,projection:'perspective'}});
  assert.doesNotMatch(JSON.stringify(viewpoint),/\{viewpoint\}|Change the camera|Adjust the camera/);
  assert.match(viewpoint.numbered,/image_1/);
  assert.throws(()=>previewModuleInstructions('subject',{native_instruction:'{viewpoint}'}));
  assert.throws(()=>previewModuleInstructions('subject',{}, {imageCount:0}),/1～16/);
  assert.throws(()=>previewModuleInstructions('subject',{}, {imageCount:17}));
  assert.throws(()=>previewModuleInstructions('viewpoint',{native_instruction:'{viewpoint}'},{toolState:{yaw:300}}));
});

test('角色覆盖用于真实推理编译，保持输出约束，不混入生图；恢复采用出厂角色',()=>{
  const f=fixture(new ModuleRegistry(undefined,releasePromptConfig,{general:'我的自定义角色要求。'}));
  const model={...seedModels()[2],purpose:'understanding' as const,enabled:true,executable:true,capabilities:{...seedModels()[2].capabilities,operations:['understand']}};
  const prepared=prepareModuleInference(f.recipe,f.prompt.module_id,'优化这段描述',model,f.registry);
  const actual=textOf(prepared.job.chain_snapshot.blocks);
  assert.match(actual,/我的自定义角色要求/);assert.match(actual,/只返回可直接填回当前模块编辑框/);
  assert.ok(!actual.includes(promptRoles[0].instruction));
  assert.doesNotMatch(textOf(compileRecipe(f.recipe,f.registry).blocks),/我的自定义角色要求/);
  const original=textOf(prepareModuleInference(f.recipe,f.prompt.module_id,'优化这段描述',model,new ModuleRegistry(undefined,releasePromptConfig)).job.chain_snapshot.blocks);
  assert.ok(original.includes(promptRoles[0].instruction));
  assert.equal(new ModuleRegistry(undefined,releasePromptConfig,{general:''}).roleInstruction('general'),'');
});

test('角色文字变更或清空会使自动提示词过期，仅其它角色变更或无效差异不改变复用',()=>{
  const f=fixture(),key=(roles:ConstructorParameters<typeof ModuleRegistry>[2])=>getAutoPromptState(f.recipe,new ModuleRegistry(undefined,releasePromptConfig,roles),defaultModuleSettings)!;
  const base=key({});f.prompt.auto_prompt_input_key=base.input_key;
  assert.equal(key({}).needs_inference,false);
  assert.equal(key({merchandiser:'只改另一个角色'}).input_key,base.input_key);
  assert.equal(key({general:promptRoles[0].instruction}).input_key,base.input_key);
  const edited=key({general:'自己的角色'});assert.notEqual(edited.input_key,base.input_key);assert.equal(edited.needs_inference,true);
  assert.notEqual(key({general:''}).input_key,base.input_key);
  f.prompt.auto_prompt_input_key=edited.input_key;
  assert.equal(key({general:'自己的角色'}).needs_inference,false);
  assert.equal(key({}).needs_inference,true);
  assert.equal(f.prompt.user_instruction,'保留当前文字。');
});
