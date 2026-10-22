import { compileRecipe } from '../core/compiler.js';
import { ModuleRegistry } from '../core/modules.js';
import type { WorkspaceView } from '../shared/api.js';
import { planExecution } from '../core/execution-plan.js';
import { getAutoPromptState } from '../core/auto-prompt.js';
import { defaultModuleSettings } from '../core/module-settings.js';

// Presentation is derived from the same confirmed Recipe as the cards. Reuse
// the core compiler and host-provided definitions; never maintain a second order.
export function synchronizeInputPreview(state: WorkspaceView): WorkspaceView {
  if (!state.project) return {...state,chain:null,adaptation:null,adaptation_error:undefined,auto_prompt:undefined};
  let chain: WorkspaceView['chain']=null;
  try {
    const registry=new ModuleRegistry(state.module_definitions,state.prompt_config,state.prompt_customizations?.roles);
    state={...state,project:{...state.project,recipe:registry.resolveRecipe(state.project.recipe)}};
    state={...state,auto_prompt:getAutoPromptState(state.project!.recipe,registry,state.module_settings??defaultModuleSettings,state.project!.assets)};
    chain=compileRecipe(state.project!.recipe,registry);
    const model=state.models.find(m=>m.model_config_id===state.project!.recipe.model_config_id);
    if(!model)throw new Error('当前配方使用的模型配置不存在，请从模型库重新选择。');
    const {adapted:adaptation}=planExecution(state.project!.recipe,state.project!.assets,model,registry);
    return {...state,chain,adaptation,adaptation_error:undefined};
  } catch(error) {
    return {...state,chain,adaptation:null,adaptation_error:error instanceof Error?error.message:'无法编译当前输入。'};
  }
}
