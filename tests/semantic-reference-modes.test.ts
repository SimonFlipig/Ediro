import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptChain, compileRecipe } from '../src/core/compiler.js';
import { defaultParameters, moduleSchema, type Recipe } from '../src/core/domain.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { seedModels } from '../src/core/models.js';
import { defaultPromptConfig } from '../src/core/prompt-config.js';

function fixture(){
  const config=structuredClone(defaultPromptConfig);
  config.modules.composition={native_instruction:'COMPOSITION_IMAGE_CORE',numbered_instruction:'COMPOSITION_NUMBERED_CORE {images}'};
  config.modules.style={native_instruction:'STYLE_IMAGE_CORE',numbered_instruction:'STYLE_NUMBERED_CORE {images}'};
  const registry=new ModuleRegistry(undefined,config);
  const subject=registry.create('subject'),composition=registry.create('composition'),style=registry.create('style'),imageText=registry.create('image_text'),prompt=registry.create('prompt');
  subject.asset_ids=['asset_subject'];subject.reference_mode='text_only';
  composition.asset_ids=['asset_composition','asset_composition_other'];composition.user_instruction='主体居中，留出右侧文字空间。';
  style.asset_ids=['asset_style'];style.user_instruction='户外庭院与柔和光线。';
  imageText.asset_ids=['asset_extra'];imageText.user_instruction='额外参考';prompt.user_instruction='保持产品结构';
  const recipe:Recipe={recipe_id:'recipe_reference_modes',schema_version:1,modules:[subject,composition,style,imageText,prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  return{registry,recipe,subject,composition,style,imageText,prompt};
}

for(const strategy of ['interleaved','numbered_flat'] as const){
  test(`文字参考在 ${strategy} 生图请求中排除图片和核心语义，正文保留且编号连续`,()=>{
    const f=fixture();f.composition.reference_mode='text_only';f.style.reference_mode='text_only';
    const before=structuredClone(f.recipe),chain=compileRecipe(f.recipe,f.registry);
    const input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
    const ids=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='image').map(block=>block.asset_id):input.image_asset_ids;
    assert.deepEqual(ids,['asset_subject','asset_extra']);
    assert.deepEqual(chain.blocks.filter(block=>block.type==='image').map(block=>block.image_name),['image_1','image_2']);
    const sent=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join('\n'):input.prompt!;
    assert.match(sent,/主体居中，留出右侧文字空间。/);assert.match(sent,/户外庭院与柔和光线。/);
    assert.doesNotMatch(sent,/COMPOSITION_(?:IMAGE|NUMBERED)_CORE|STYLE_(?:IMAGE|NUMBERED)_CORE|image_3/);
    assert.ok(chain.blocks.some(block=>block.source_module_id===f.subject.module_id&&block.type==='image'));
    assert.deepEqual(f.recipe,before);
  });
}

test('缺省仍为图文参考，文字模块之后的图文参考使用实际发送图片编号',()=>{
  const f=fixture();f.composition.reference_mode='text_only';
  const chain=compileRecipe(f.recipe,f.registry),input=adaptChain(chain,seedModels()[1]);
  assert.deepEqual(input.image_asset_ids,['asset_subject','asset_style','asset_extra']);
  assert.match(input.prompt!,/STYLE_NUMBERED_CORE image_2/);assert.doesNotMatch(input.prompt!,/COMPOSITION_NUMBERED_CORE/);
  f.composition.reference_mode='image_text';
  assert.deepEqual(compileRecipe(f.recipe,f.registry).blocks.filter(block=>block.type==='image').map(block=>block.asset_id),['asset_subject','asset_composition','asset_composition_other','asset_style','asset_extra']);
});

test('理解链保留两种文字参考的图片、语义和连续编号',()=>{
  const f=fixture();f.composition.reference_mode='text_only';f.style.reference_mode='text_only';
  const chain=compileRecipe(f.recipe,f.registry,{purpose:'understanding'});
  assert.deepEqual(chain.blocks.filter(block=>block.type==='image').map(block=>block.image_name),['image_1','image_2','image_3','image_4','image_5']);
  const input=adaptChain(chain,seedModels()[1]);
  assert.match(input.prompt!,/COMPOSITION_NUMBERED_CORE image_2, image_3/);
  assert.match(input.prompt!,/STYLE_NUMBERED_CORE image_4/);
  assert.deepEqual(input.image_asset_ids,['asset_subject','asset_composition','asset_composition_other','asset_style','asset_extra']);
});

test('仅有图片的文字参考不生成空模块，移除全部参考后成为纯文字请求',()=>{
  const f=fixture();f.composition.reference_mode='text_only';f.composition.user_instruction='';
  f.style.reference_mode='text_only';f.recipe.modules=[f.composition,f.style,f.prompt];
  const chain=compileRecipe(f.recipe,f.registry);
  assert.equal(chain.mode,'text_to_image');assert.ok(chain.blocks.every(block=>block.type==='text'));
  assert.ok(chain.blocks.every(block=>block.source_module_id!==f.composition.module_id));
  assert.ok(chain.blocks.some(block=>block.source_module_id===f.style.module_id&&block.type==='text'&&block.text===f.style.user_instruction));
});

test('同一素材可同时用于主体和文字参考，按模块过滤而不误删主体图',()=>{
  const f=fixture();f.composition.asset_ids=['asset_subject'];f.composition.reference_mode='text_only';
  f.style.enabled=false;f.imageText.enabled=false;
  const images=compileRecipe(f.recipe,f.registry).blocks.filter(block=>block.type==='image');
  assert.equal(images.length,1);assert.equal(images[0].source_module_id,f.subject.module_id);assert.equal(images[0].asset_id,'asset_subject');
});

test('旧模块兼容新可选字段，复制自动提示词关闭自动目标并移除复用标记',()=>{
  const f=fixture();const old=moduleSchema.parse(f.prompt);
  assert.equal(old.auto_prompt,undefined);assert.equal(old.auto_prompt_input_key,undefined);assert.equal(old.reference_mode,undefined);
  f.prompt.auto_prompt=true;f.prompt.auto_prompt_input_key='auto-v1:'+'a'.repeat(64);f.prompt.user_instruction='已生成并编辑的内容';
  const copy=f.registry.copy(f.prompt);
  assert.equal(copy.auto_prompt,false);assert.equal(copy.auto_prompt_input_key,undefined);assert.equal(copy.user_instruction,f.prompt.user_instruction);
  assert.notEqual(copy.module_id,f.prompt.module_id);assert.equal(f.prompt.auto_prompt,true);assert.ok(f.prompt.auto_prompt_input_key);
  f.style.reference_mode='text_only';assert.equal(f.registry.copy(f.style).reference_mode,'text_only');
  assert.throws(()=>moduleSchema.parse({...f.prompt,auto_prompt_input_key:'x'.repeat(129)}));
});
