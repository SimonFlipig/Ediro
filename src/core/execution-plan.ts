import type { Asset,CompiledChain,ModelConfig,Recipe } from './domain.js';
import { compileRecipe,adaptChain,validateParameters,defaultInputStrategies } from './compiler.js';
import { contractFor,normalizeParameters,parameterFields } from './generation-parameters.js';
import type { PlanSummary } from './generation-contract.js';
import { resolveOutputGeometry } from './output-geometry.js';
import { ModuleRegistry } from './modules.js';

// One pure planning entry for preview, queueing and understanding tasks.
export function planExecution(input:Recipe,assets:Pick<Asset,'asset_id'|'width'|'height'>[],model:ModelConfig,registry=new ModuleRegistry(),preparedChain?:CompiledChain,strategies=defaultInputStrategies){
  const recipe=registry.resolveRecipe(input);
  recipe.core_parameters=normalizeParameters(recipe.core_parameters,model);
  const contract=contractFor(model);
  if(model.purpose!=='understanding'&&recipe.core_parameters.resolution?.mode==='default'&&contract.tiers.length){
    recipe.core_parameters.resolution={mode:'tier',value:contract.tiers[0]};
  }
  const chain=preparedChain?structuredClone(preparedChain):compileRecipe(recipe,registry);
  const understanding=model.purpose==='understanding';
  const operation=understanding?'understand':chain.mode==='reference_generation'?'referenceEdit':'generate';
  if(model.kind==='cloud'&&!model.capabilities.operations.includes(operation))throw new Error('所选模型未声明本次操作能力。');
  validateParameters(recipe,model);
  const diagnostics:PlanSummary['diagnostics']=[];
  const ids=new Set(chain.blocks.filter(b=>b.type==='image').map(b=>b.asset_id));
  for(const f of parameterFields(model).filter(f=>f.kind==='references')){
    const overrides=recipe.core_parameters.extensions?.[model.adapter_id]?.[f.key];
    if(overrides&&typeof overrides==='object'){
      const inactive=Object.keys(overrides).filter(id=>!ids.has(id));
      for(const id of inactive)delete overrides[id];
      if(inactive.length)diagnostics.push({code:'input.inactive_overrides',severity:'info',message:'未参与本次输入的参考图设置不发送；配方中的设置仍保留。'});
    }
  }
  const adapted=adaptChain(chain,model,recipe.input_strategy,strategies);
  const actual=adapted.kind==='native_blocks'?'interleaved':'numbered_flat';
  const requested=recipe.input_strategy??actual;
  recipe.input_strategy=requested;
  if(actual==='numbered_flat')diagnostics.push({code:'input.numbered_flat',severity:'info',message:'已采用编号拍平：完整提示词与参考图序列一一对应，图文邻接关系已转换。'});
  adapted.adjustments=[];
  const geometry=understanding?undefined:resolveOutputGeometry(recipe,assets,model);
  for(const message of geometry?.adjustments??[])diagnostics.push({code:'output.ratio_unexpressible',severity:'warning',message});
  if(geometry?.target==='auto'&&geometry.ratio){
    const hint=`期望输出画面的宽高比为 ${geometry.ratio}。请尽量保持该比例。`;
    if(adapted.kind==='separated_inputs')adapted.prompt=`${adapted.prompt??''}\n\n${hint}`;
    else {
      const source=chain.blocks[0];
      if(source)adapted.blocks!.push({type:'text',text:hint,source_module_id:source.source_module_id,reference_id:source.reference_id,reference_type:source.reference_type});
    }
  }
  adapted.adjustments=diagnostics.filter(d=>d.severity==='warning').map(d=>d.message);
  const summary:PlanSummary={version:1,operation,requested_strategy:requested,actual_strategy:requested==='auto'?actual:requested,contract:contractFor(model),model_revision:model.revision,adapter_version:model.adapter_version??1,diagnostics};
  return {recipe,chain,adapted,geometry,summary};
}
