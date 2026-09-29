import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleRegistry } from '../src/core/modules.js';
import { compileRecipe,adaptChain } from '../src/core/compiler.js';
import { semanticPrompts } from '../src/core/semantic-prompts.js';
import { defaultParameters,type Recipe } from '../src/core/domain.js';
import { seedModels } from '../src/core/models.js';
import { describeInputBlock } from '../src/ui/module-presentation.js';
import { defaultPromptConfig } from '../src/core/prompt-config.js';

test('中文说明只用于展示，原生与降级发送继续使用核心语义，链与状态不变',()=>{
  const registry=new ModuleRegistry(),module=registry.create('viewpoint'),prompt=registry.create('prompt');
  module.asset_ids=['asset_view'];module.user_instruction='保持商品比例';prompt.user_instruction='生成产品图';
  const recipe:Recipe={recipe_id:'recipe_display',schema_version:1,modules:[module,prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const chain=compileRecipe(recipe,registry),before=structuredClone(chain),state=structuredClone(recipe);
  const definition=registry.get('viewpoint');
  assert.equal(definition.description,semanticPrompts.viewpoint.description);
  assert.equal(describeInputBlock(chain.blocks[0],module,definition),`viewpoint:\n${semanticPrompts.viewpoint.description}`);
  assert.equal(describeInputBlock(chain.blocks[3],module,definition),'保持商品比例');
  assert.equal(describeInputBlock(chain.blocks[4],prompt,registry.get('prompt')),'生成产品图');
  const native=adaptChain(chain,seedModels()[0]);
  assert.ok(JSON.stringify(native).includes(semanticPrompts.viewpoint.native));
  const separated=adaptChain(chain,seedModels()[1]);
  assert.ok(separated.prompt!.includes(semanticPrompts.viewpoint.numbered.replace('{images}','image_1')));
  assert.ok(!JSON.stringify(native).includes(semanticPrompts.viewpoint.description));
  assert.ok(!separated.prompt!.includes(semanticPrompts.viewpoint.description));
  assert.deepEqual(chain,before);assert.deepEqual(recipe,state);
});

test('视角语义可按需引用由水平与俯仰标签组成的 {viewpoint}',()=>{
  const config=structuredClone(defaultPromptConfig);
  config.modules.viewpoint={
    native_instruction:'Match the reference image. Target viewpoint: {viewpoint}.',
    numbered_instruction:'Match {images}. Target viewpoint: {viewpoint}.',
  };
  const registry=new ModuleRegistry(undefined,config),module=registry.create('viewpoint'),prompt=registry.create('prompt');
  module.asset_ids=['asset_view'];module.tool_state={yaw:3,pitch:18,roll:30,projection:'orthographic'};prompt.user_instruction='生成产品图';
  const recipe:Recipe={recipe_id:'recipe_viewpoint_variable',schema_version:1,modules:[module,prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const chain=compileRecipe(recipe,registry),native=JSON.stringify(adaptChain(chain,seedModels()[0])),separated=adaptChain(chain,seedModels()[1]).prompt!;
  for(const output of [native,separated]){
    assert.match(output,/Target viewpoint: Symmetrical front view, Eye-level shot\./);
    assert.ok(!output.includes('Orthographic view'));
    assert.ok(!output.includes('Clockwise tilt'));
  }
});

test('自定义模块标题、图片标签和旧文本块不能通过输入预览暴露调优文字',()=>{
  const config=structuredClone(defaultPromptConfig);
  config.module_header='PRIVATE HEADER {module}';config.image_label='PRIVATE LABEL {image}';
  const registry=new ModuleRegistry(undefined,config),module=registry.create('viewpoint');
  module.asset_ids=['asset_view'];module.user_instruction='用户要求';
  const recipe:Recipe={recipe_id:'recipe_private',schema_version:1,modules:[module,registry.create('prompt')],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const chain=compileRecipe(recipe,registry),before=structuredClone(chain),definition=registry.get('viewpoint');
  for(const block of chain.blocks){
    const displayed=describeInputBlock(block,module,definition);
    assert.ok(!displayed.includes('PRIVATE'));assert.ok(!displayed.includes(semanticPrompts.viewpoint.native));
  }
  const text=chain.blocks.find(block=>block.type==='text')!;
  assert.equal(describeInputBlock({...text,type:'text',text_role:'header',text:'PRIVATE HEADER'},module,definition),module.title);
  assert.equal(describeInputBlock({...text,type:'text',text_role:undefined,text:'PRIVATE LEGACY'},module,definition),definition.description);
  assert.equal(describeInputBlock({...text,type:'text',text_role:undefined,text:'用户要求'},module,definition),'用户要求');
  assert.deepEqual(chain,before);assert.ok(JSON.stringify(adaptChain(chain,seedModels()[0])).includes('PRIVATE HEADER'));
});
