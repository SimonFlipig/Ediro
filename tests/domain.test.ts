import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ModuleRegistry } from '../src/core/modules.js';
import { defaultParameters, newId, recipeSchema, type Recipe } from '../src/core/domain.js';
import { compileRecipe, adaptChain, validateParameters } from '../src/core/compiler.js';
import { ModelLibrary, seedModels } from '../src/core/models.js';
import { migrateModels } from '../src/core/model-library.js';
import { validateNumberedTemplate } from '../src/core/semantic-prompts.js';

function fixture(): { registry: ModuleRegistry; recipe: Recipe } {
  const registry = new ModuleRegistry();
  const subject = registry.create('subject'); subject.asset_ids=['asset_front','asset_side'];subject.user_instruction='保留 Logo';
  const style=registry.create('style');style.asset_ids=['asset_style'];
  const prompt=registry.create('prompt');prompt.user_instruction='生成暖色电商主视觉';
  return { registry, recipe: {recipe_id:newId('recipe'),schema_version:1,modules:[subject,style,prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}} };
}
test('基础图文模块不注入预设语义，原生保留图文，降级仅关联实际图片序号',()=>{
  const {registry,recipe}=fixture();
  const neutral=registry.create('image_text');neutral.title='用户自定义名字';neutral.asset_ids=['asset_a','asset_a'];neutral.user_instruction='这里是我自己的说明';
  recipe.modules=[recipe.modules[1],neutral,recipe.modules[2]];
  const chain=compileRecipe(recipe),own=chain.blocks.filter(b=>b.source_module_id===neutral.module_id);
  assert.equal(neutral.base_instruction,'');assert.equal(neutral.numbered_instruction,undefined);
  assert.deepEqual(own.map(b=>b.type),['text','image','text','image','text']);
  assert.deepEqual(own.filter(b=>b.type==='text').map(b=>b.text),['image_2','image_3','这里是我自己的说明']);
  assert.deepEqual(adaptChain(chain,seedModels()[0]).blocks,chain.blocks);
  const flat=adaptChain(chain,seedModels()[1]);
  assert.deepEqual(flat.image_asset_ids,['asset_style','asset_a','asset_a']);
  assert.match(flat.prompt!,/image_2\nimage_3\n这里是我自己的说明/);
  assert.ok(!flat.prompt!.includes(neutral.title));assert.ok(!flat.prompt!.includes(neutral.reference_id));
  recipe.modules=[neutral,recipe.modules[0],recipe.modules[2]];
  assert.match(adaptChain(compileRecipe(recipe),seedModels()[1]).prompt!,/^image_1\nimage_2\n这里是我自己的说明/);
});

test('基础图文模块支持仅图片、仅文字，空白及停用模块不加入输入',()=>{
  const {registry,recipe}=fixture(),neutral=registry.create('image_text');
  const prompt=registry.create('prompt');recipe.modules=[neutral,prompt];
  assert.deepEqual(compileRecipe(recipe).blocks,[]);
  neutral.asset_ids=['asset_a','asset_b'];
  assert.deepEqual(compileRecipe(recipe).blocks.map(b=>b.type),['text','image','text','image']);
  assert.equal(adaptChain(compileRecipe(recipe),seedModels()[1]).prompt,'image_1\nimage_2');
  neutral.asset_ids=[];neutral.user_instruction='自由输入文字';
  assert.equal(adaptChain(compileRecipe(recipe),seedModels()[1]).prompt,'自由输入文字');
  neutral.enabled=false;assert.deepEqual(compileRecipe(recipe).blocks,[]);
});

test('模块复制沿用 type，但 module_id/reference_id 都重新生成；素材引用可复用',()=>{
  const {registry,recipe}=fixture();const source=recipe.modules[0],copy=registry.copy(source);
  assert.notEqual(source.module_id,copy.module_id);assert.notEqual(source.reference_id,copy.reference_id);assert.equal(source.reference_type,copy.reference_type);
  assert.deepEqual(source.asset_ids,copy.asset_ids);copy.asset_ids.push('asset_extra');assert.equal(source.asset_ids.length,2);
});
test('富媒体链按模块顺序和模块内图片插入顺序展开',()=>{
  const {recipe}=fixture(),chain=compileRecipe(recipe);
  assert.deepEqual(chain.blocks.map(b=>b.type),['text','text','image','text','image','text','text','text','image','text']);
  assert.deepEqual(chain.blocks.filter(b=>b.type==='image').map(b=>b.asset_id),['asset_front','asset_side','asset_style']);
  assert.equal(chain.mode,'reference_generation');
  assert.equal((chain.blocks[0] as {text:string}).text,`subject:\n${recipe.modules[0].base_instruction}`);
  for(const module of recipe.modules){assert.ok(!chain.blocks.some(b=>b.type==='text'&&(b.text.includes(module.reference_id)||b.text.includes(module.module_id))));}
  assert.equal(chain.blocks[0].reference_id,recipe.modules[0].reference_id);
});
test('重排模块时对应图文片段整体自然移动，不改变模块内部顺序',()=>{
  const {recipe}=fixture();const ids=recipe.modules.map(m=>m.module_id);recipe.modules=[recipe.modules[2],recipe.modules[0],recipe.modules[1]];
  const chain=compileRecipe(recipe);assert.equal(chain.blocks[0].source_module_id,ids[2]);
  assert.deepEqual(chain.blocks.filter(b=>b.type==='image').map(b=>b.asset_id),['asset_front','asset_side','asset_style']);
});
test('至少保留一个启用提示词模块，禁止删除或停用最后一个',()=>{
  const {recipe}=fixture();recipe.modules=recipe.modules.filter(m=>m.reference_type!=='prompt');assert.throws(()=>recipeSchema.parse(recipe));
  const f=fixture();f.recipe.modules.at(-1)!.enabled=false;assert.throws(()=>recipeSchema.parse(f.recipe));
});
test('只有提示词时为文生图，空参考卡片不注入无关语义',()=>{
  const registry=new ModuleRegistry(),prompt=registry.create('prompt');prompt.user_instruction='一个白底产品';
  const recipe:Recipe={recipe_id:newId('recipe'),schema_version:1,modules:[registry.create('subject'),prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const chain=compileRecipe(recipe);assert.equal(chain.mode,'text_to_image');assert.equal(chain.blocks.length,1);
});
test('提示词模块禁止图片，停用模块不进入富媒体链',()=>{
  const {recipe}=fixture();recipe.modules[0].enabled=false;assert.equal(compileRecipe(recipe).blocks.some(b=>b.reference_type==='subject'),false);
  recipe.modules.at(-1)!.asset_ids=['asset_bad'];assert.throws(()=>compileRecipe(recipe),/不接受/);
});
test('相同图片引用不自动去重',()=>{
  const {recipe}=fixture();recipe.modules[0].asset_ids=['asset_front','asset_front'];
  assert.deepEqual(compileRecipe(recipe).blocks.filter(b=>b.type==='image').map(b=>b.asset_id),['asset_front','asset_front','asset_style']);
});
test('原生接口保留块链；降级接口保留图片对应、顺序及可见记录',()=>{
  const {recipe}=fixture(),chain=compileRecipe(recipe),models=seedModels();
  assert.deepEqual(adaptChain(chain,models[0]).blocks,chain.blocks);
  const adapted=adaptChain(chain,models[1]);assert.equal(adapted.kind,'separated_inputs');assert.equal(adapted.adjustments.length,1);
  assert.deepEqual(adapted.image_asset_ids,['asset_front','asset_side','asset_style']);
  assert.match(adapted.prompt!,/保持image_1, image_2中主体的结构、颜色和比例。/);
  assert.match(adapted.prompt!,/image_2\n保留 Logo/);
  assert.match(adapted.prompt!,/参考image_3的视觉风格、色调与光影表现。/);
  assert.ok(adapted.prompt!.indexOf('image_1')<adapted.prompt!.indexOf('image_3'));
  assert.ok(!/补充要求|用于|对应说明/.test(adapted.prompt!));
  assert.ok(adapted.prompt!.endsWith('生成暖色电商主视觉'));
  for(const module of recipe.modules)assert.ok(!adapted.prompt!.includes(module.reference_id));
});

test('降级图片编号随模块重排和停用重新生成，重复图片按出现次数对应',()=>{
  const {recipe}=fixture();recipe.modules[0].asset_ids=['asset_front','asset_front'];
  recipe.modules=[recipe.modules[1],recipe.modules[0],recipe.modules[2]];
  const model=seedModels()[1],chain=compileRecipe(recipe),snapshot=structuredClone(chain),adapted=adaptChain(chain,model);
  assert.deepEqual(adapted.image_asset_ids,['asset_style','asset_front','asset_front']);
  assert.match(adapted.prompt!,/^style:\n参考image_1的视觉风格、色调与光影表现。/);
  assert.match(adapted.prompt!,/image_3\n保留 Logo/);
  assert.deepEqual(chain,snapshot);
  recipe.modules[0].enabled=false;
  const next=adaptChain(compileRecipe(recipe),model);assert.deepEqual(next.image_asset_ids,['asset_front','asset_front']);
  assert.match(next.prompt!,/^subject:\n保持image_1, image_2中主体的结构、颜色和比例。/);assert.ok(!next.prompt!.includes('image_3'));
});

test('无图模块和独立提示词降级时保持原文，不冒用相邻图片的补充要求',()=>{
  const {recipe}=fixture();recipe.modules[0].asset_ids=[];
  const chain=compileRecipe(recipe),adapted=adaptChain(chain,seedModels()[1]);
  assert.ok(adapted.prompt!.startsWith(`subject:\n${recipe.modules[0].base_instruction}\n保留 Logo`));
  assert.match(adapted.prompt!,/参考image_1的视觉风格、色调与光影表现。/);
  assert.deepEqual(adapted.image_asset_ids,['asset_style']);
});
test('超出模型图片边界时阻止执行，不静默丢弃',()=>{
  const {recipe}=fixture();const model=seedModels()[0];model.capabilities.max_images=2;assert.throws(()=>adaptChain(compileRecipe(recipe),model),/最多接收 2/);
});
test('图片语义模板校验拒绝未知、缺失及重复占位符；旧配方可按相同基础语义应用模板',()=>{
  for(const template of ['保持主体。','保持{image}。','保持{images}{images}。','保持{images}和{other}。','保持{images}和{'])assert.throws(()=>validateNumberedTemplate(template),/占位符/);
  assert.equal(validateNumberedTemplate('Match {images}. Target viewpoint: {viewpoint}.'),'Match {images}. Target viewpoint: {viewpoint}.');
  const {recipe}=fixture();delete recipe.modules[0].numbered_instruction;
  assert.match(adaptChain(compileRecipe(recipe),seedModels()[1]).prompt!,/^subject:\n保持image_1, image_2中主体/);
  recipe.modules[0].base_instruction='旧版本语义。';
  recipe.modules[0].numbered_instruction='旧版本{images}。';
  const before=structuredClone(recipe);
  const updated=adaptChain(compileRecipe(recipe),seedModels()[1]);
  assert.match(updated.prompt!,/^subject:\n保持image_1, image_2中主体/);
  assert.ok(!updated.prompt!.includes('旧版本'));
  assert.deepEqual(recipe,before);
});
test('模型参数不兼容时阻止，不能带着旧模型参数运行',()=>{
  const {recipe}=fixture();assert.throws(()=>validateParameters(recipe,seedModels()[3]),/不兼容/);
});
test('特殊参考模块可注册工具状态，输出仍为标准图文块',()=>{
  const {registry,recipe}=fixture();registry.register({type:'custom_viewpoint',title:'视角',description:'观察角度',base_instruction:'参考当前观察角度。',editor_kind:'generated_reference',accepts_images:true,default_tool_state:{yaw:30,pitch:10}});
  const module=registry.create('custom_viewpoint');module.asset_ids=['asset_cube_snapshot'];recipe.modules.unshift(module);
  assert.equal(module.tool_state!.yaw,30);assert.equal(compileRecipe(recipe,registry).blocks[2].type,'image');
});
test('未知模块不静默略过；重复 ID 不允许',()=>{
  const {recipe}=fixture();recipe.modules[0].reference_type='uninstalled';assert.throws(()=>compileRecipe(recipe),/当前未安装/);
  const f=fixture();f.recipe.modules[1].reference_id=f.recipe.modules[0].reference_id;assert.throws(()=>recipeSchema.parse(f.recipe));
});
test('模型库不回显凭据，并固定配置修订；修改 resolve 副本不影响库',async()=>{
  const values=new Map<string,string>();let stored=migrateModels(seedModels());
  const library=new ModelLibrary(seedModels(),async models=>{stored=models;},{has:async ref=>values.has(ref),set:async(ref,value)=>{values.set(ref,value);}});
  await library.update('model_nano_pro',{title:'官方 Nano',endpoint:'https://generativelanguage.googleapis.com',enabled:true},'test-secret-do-not-log');
  const list=await library.list(),nano=list.find(m=>m.model_config_id==='model_nano_pro')!;
  assert.equal(nano.has_credential,true);assert.equal(nano.revision,2);assert.ok(!JSON.stringify(list).includes('test-secret'));assert.ok(!('credential_ref'in nano));
  assert.ok(stored.connections[0].credential_ref);const model=library.resolve('model_nano_pro');model.title='mutated';assert.equal(library.resolve('model_nano_pro').title,'官方 Nano');
  await assert.rejects(()=>library.update('model_nano_pro',{title:'bad',endpoint:'https://user:pass@example.com',enabled:true}));
});
test('业务内核不导入 Electron、React 或具体执行适配器',async()=>{
  for(const name of ['domain','modules','compiler','models','workspace','ports']){
    const source=await readFile(path.join(process.cwd(),'src','core',`${name}.ts`),'utf8');
    assert.ok(!/from ['"](?:electron|react|\.\.\/adapters)/.test(source),name);
  }
});
