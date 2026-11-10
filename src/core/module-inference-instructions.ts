import { z } from 'zod';
import type { SemanticModule } from './domain.js';

const instruction=z.string().max(32000);
export const moduleInferenceInstructionsSchema=z.object({
  subject:instruction.optional(),composition:instruction.optional(),style:instruction.optional(),viewpoint:instruction.optional(),
}).strict();
export type ModuleInferenceInstructions=z.infer<typeof moduleInferenceInstructionsSchema>;

// These are understanding rules, never image-generation module instructions or
// project fields. An empty override deliberately disables the corresponding rule.
export const defaultModuleInferenceInstructions:Readonly<Required<ModuleInferenceInstructions>>={
  subject:'识别主体的大致类别、数量和当前状态，仅保留完成本次画面要求所必需的主体约束。有主体参考图时，图片会继续交给生图模型，不必逐项复述可见结构、材质或纹理；保留用户明确指定的身份、颜色、比例及修改要求，不编造不可见特征。',
  composition:'Extract only layout, framing, placement, relative scale, and spatial relationships from the reference images. Do not extract product identity or visual style. Preserve explicit user requirements.',
  style:'Extract only environment type, props, accessories, color palette, and lighting from the reference images. Ignore composition, object placement, relative scale, and spatial relationships. Preserve explicit user requirements.',
  viewpoint:'只确定相机观察方向与俯仰角度；有程序提供的当前角度时以该角度为准。不从视角示意图提取主体身份、颜色、材质、背景或风格。',
};

export function moduleInferenceInstruction(type:string,overrides:ModuleInferenceInstructions={}):string|undefined{
  if(!Object.hasOwn(defaultModuleInferenceInstructions,type))return undefined;
  const key=type as keyof ModuleInferenceInstructions;
  return overrides[key]??defaultModuleInferenceInstructions[key];
}

export function hasModuleInferenceInstruction(type:string){return Object.hasOwn(defaultModuleInferenceInstructions,type);}

// These describe reference purposes, not the application's module identities.
export const inferenceReferenceUses:Readonly<Record<string,string>>={
  subject:'主体参考',composition:'构图参考',style:'风格参考',viewpoint:'视角参考',image_text:'图文参考',prompt:'画面要求',
};

// Reuse the same participation boundary for request preparation and the auto
// prompt fingerprint. The target can have an empty draft; empty constraints do
// not participate, including image-only constraints when no images are sent.
export function participatingInferenceModules(modules:readonly SemanticModule[],targetId:string,scope:'enabled_modules'|'target',includeImages=true){
  return modules.filter(module=>module.enabled&&(module.module_id===targetId||
    scope==='enabled_modules'&&(module.user_instruction.trim().length>0||includeImages&&module.asset_ids.length>0)));
}

export function buildModuleInferenceReferenceRules(modules:readonly SemanticModule[],resolve:(type:string)=>string|undefined,includeImages=true):string{
  const participating=modules.filter(module=>hasModuleInferenceInstruction(module.reference_type)&&
    (module.user_instruction.trim().length>0||includeImages&&module.asset_ids.length>0));
  const sections=Object.keys(defaultModuleInferenceInstructions).flatMap(type=>{
    if(!participating.some(module=>module.reference_type===type))return [];
    const rule=resolve(type);
    return rule?.trim()?[`## ${inferenceReferenceUses[type]}\n${rule}`]:[];
  });
  return sections.join('\n\n');
}
