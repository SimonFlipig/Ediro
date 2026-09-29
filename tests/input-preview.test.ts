import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeInputPreview } from '../src/ui/input-preview.js';
import { compileRecipe } from '../src/core/compiler.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { seedModels } from '../src/core/models.js';
import { defaultParameters, newId, type Project } from '../src/core/domain.js';
import type { WorkspaceView } from '../src/shared/api.js';

function fixture():WorkspaceView {
  const registry=new ModuleRegistry(),subject=registry.create('subject'),prompt=registry.create('prompt');
  subject.asset_ids=['asset_first','asset_second'];prompt.user_instruction='生成商品图';
  const recipe={recipe_id:newId('recipe'),schema_version:1 as const,modules:[subject,prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const project:Project={schema_version:2,project_id:newId('project'),name:'测试',created_at:'',updated_at:'',recipe,assets:[],jobs:[],revisions:[]};
  return {project,chain:compileRecipe(recipe),adaptation:null,models:seedModels().map(m=>({...m,has_credential:false})),module_definitions:registry.list(),assets:[],project_location:null};
}
test('排序保存响应即使携带旧链，也立即按新配方派生完整预览与适配输入',()=>{
  const state=fixture(),old=structuredClone(state.chain);
  state.project!.recipe.modules.reverse();
  const preview=synchronizeInputPreview(state);
  assert.deepEqual(state.chain,old); // do not mutate incoming state or historic chains.
  assert.equal(preview.chain!.blocks[0].reference_type,'prompt');
  assert.deepEqual(preview.chain,compileRecipe(state.project!.recipe));
  assert.deepEqual(preview.adaptation!.blocks,preview.chain!.blocks);
  assert.deepEqual(preview.chain!.blocks.filter(b=>b.type==='image').map(b=>b.asset_id),['asset_first','asset_second']);
});
test('提示词编辑无需刷新就进入预览；原快照保持不变',()=>{
  const state=fixture(),old=structuredClone(state.chain);state.project!.recipe.modules[1].user_instruction='新的生成要求';
  assert.equal(synchronizeInputPreview(state).chain!.blocks.at(-1)!.type,'text');
  assert.equal((synchronizeInputPreview(state).chain!.blocks.at(-1)! as {text:string}).text,'新的生成要求');
  assert.deepEqual(state.chain,old);
});
test('未知模块和模型配置明确报错，不显示旧的可执行输入',()=>{
  const state=fixture();state.project!.recipe.modules[0].reference_type='not_installed';
  const unknown=synchronizeInputPreview(state);assert.equal(unknown.chain,null);assert.ok(unknown.adaptation_error);
  state.project!.recipe.modules[0].reference_type='subject';state.models=[];
  const missing=synchronizeInputPreview(state);assert.equal(missing.adaptation,null);assert.match(missing.adaptation_error!,/模型配置不存在/);
});

test('已有模块的卡片核心语义与发送预览统一采用最新定义，不改写输入快照',()=>{
  const state=fixture();
  state.project!.recipe.modules[0].base_instruction='旧核心语义';
  state.project!.recipe.modules[0].numbered_instruction='旧{images}';
  const before=structuredClone(state),preview=synchronizeInputPreview(state);
  const current=state.module_definitions.find(d=>d.type==='subject')!;
  assert.equal(preview.project!.recipe.modules[0].base_instruction,current.base_instruction);
  assert.equal(preview.project!.recipe.modules[0].numbered_instruction,current.numbered_instruction);
  assert.equal((preview.chain!.blocks[0] as {text:string}).text,`subject:\n${current.base_instruction}`);
  assert.deepEqual(state,before);
});
