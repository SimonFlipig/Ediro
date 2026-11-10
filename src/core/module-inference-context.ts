import type { Block, SemanticModule } from './domain.js';
import { hasModuleInferenceInstruction, inferenceReferenceUses } from './module-inference-instructions.js';
import { describeViewpoint } from '../shared/viewpoint.js';

export interface InferenceReference {
  use: string;
  name?: string;
  images?: string[];
  requirements?: string;
  image_use?: string;
  view?: string;
  guidance?: string[];
}

export interface InferenceContext {
  name?: string;
  draft?: string;
  guidance?: string[];
  references?: InferenceReference[];
}

function guidance(module:SemanticModule):string[]{
  return [...new Set([module.base_instruction,module.numbered_instruction]
    .filter((text):text is string=>typeof text==='string'&&text.trim().length>0))];
}

function customName(module:SemanticModule){
  if(!Object.hasOwn(inferenceReferenceUses,module.reference_type))return {name:module.model_name??module.reference_type};
  return Object.hasOwn(inferenceReferenceUses,module.reference_type)&&module.model_name&&module.model_name!==module.reference_type
    ?{name:module.model_name}:{};
}

function viewpointDescription(module:SemanticModule):string|undefined{
  if(module.reference_type!=='viewpoint'||!module.tool_state)return;
  const {tool_state:state}=module;
  const yaw=Number(state.yaw),pitch=Number(state.pitch),roll=Number(state.roll??0);
  if(!Number.isFinite(yaw)||!Number.isFinite(pitch)||!Number.isFinite(roll))return;
  const projection=state.projection==='perspective'?'perspective':'orthographic';
  const angle=describeViewpoint({yaw,pitch,roll,projection});
  return `当前观察方向：${angle.promptValue}（${angle.summaryZh}）。水平角 ${yaw}°，俯仰角 ${pitch}°，倾斜角 ${roll}°，${projection==='perspective'?'透视':'正交'}投影。`;
}

// Preserve each reference's scope and the compiler's actual image labels. IDs,
// raw tool state and empty editor fields stay in the internal snapshot only.
export function buildInferenceContext(modules:readonly SemanticModule[],targetId:string,images:readonly Extract<Block,{type:'image'}>[]):InferenceContext{
  const context:InferenceContext={},references:InferenceReference[]=[];
  for(const module of modules){
    if(module.module_id===targetId&&module.reference_type==='prompt'){
      Object.assign(context,customName(module));
      if(module.user_instruction.trim())context.draft=module.user_instruction;
      const instructions=guidance(module);
      if(instructions.length)context.guidance=instructions;
      continue;
    }
    const names=images.filter(image=>image.source_module_id===module.module_id).map(image=>{
      if(!image.image_name)throw new Error('推理参考图片缺少编号，无法对应文字要求。');
      return image.image_name;
    });
    const reference:InferenceReference={
      use:Object.hasOwn(inferenceReferenceUses,module.reference_type)?inferenceReferenceUses[module.reference_type]:'参考信息',
      ...customName(module),
      ...(names.length?{images:names}:{}),
      ...(module.user_instruction.trim()?{requirements:module.user_instruction}:{}),
    };
    if(names.length&&(module.reference_type==='composition'||module.reference_type==='style')){
      reference.image_use=module.reference_mode==='text_only'?'仅用于提取文字要求，不作为生图参考。':'作为生图参考。';
    }
    const view=viewpointDescription(module);
    if(view)reference.view=view;
    if(!hasModuleInferenceInstruction(module.reference_type)){
      const instructions=guidance(module);
      if(instructions.length)reference.guidance=instructions;
    }
    references.push(reference);
  }
  if(references.length)context.references=references;
  return context;
}
