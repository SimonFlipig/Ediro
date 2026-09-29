import { newId, type ModuleDefinition, type SemanticModule, type Recipe } from './domain.js';
import { fieldError } from './generation-parameters.js';
import { semanticPrompts } from './semantic-prompts.js';
import { promptOptimizationTask, subjectAnalysisTask } from './module-inference-tasks.js';
import { defaultPromptConfig,promptConfigSchema,normalizePromptConfig,type PromptConfig,type CurrentPromptConfig } from './prompt-config.js';

export const defaultDefinitions: ModuleDefinition[] = [
  { type: 'image_text', title: '图文', description: '图片与文字，无预设语义', base_instruction: '', editor_kind: 'image_collection', accepts_images: true, inference_task: promptOptimizationTask },
  { type: 'subject', title: '主体', description: '商品结构与身份', base_instruction: '保持主体结构、颜色和比例。', editor_kind: 'image_collection', accepts_images: true, inference_task: subjectAnalysisTask },
  { type: 'composition', title: '构图', description: '布局与空间关系', base_instruction: '参考画面布局、主体位置与空间关系。', editor_kind: 'image_collection', accepts_images: true },
  { type: 'style', title: '风格', description: '色调与光影表现', base_instruction: '参考视觉风格、色调与光影表现。', editor_kind: 'image_collection', accepts_images: true },
  { type: 'prompt', title: '提示词', description: '最终生成要求', base_instruction: '', editor_kind: 'text', accepts_images: false, inference_task: promptOptimizationTask },
  { type: 'viewpoint', title: '视角控制', description: '交互立方体生成角度参考', base_instruction: '参考立方体所示的观察方向与俯仰角度，保持主体结构。', editor_kind: 'generated_reference', accepts_images: true, tool_fields:[{key:'yaw',title:'水平角度',kind:'number',minimum:-180,maximum:180,required:true},{key:'pitch',title:'俯仰角度',kind:'number',minimum:-90,maximum:90,required:true},{key:'roll',title:'倾斜角度',kind:'number',minimum:-180,maximum:180,required:true},{key:'projection',title:'投影',kind:'select',values:['orthographic','perspective']}], default_tool_state: { yaw: 30, pitch: -20, roll: 0 } },
];

export class ModuleRegistry {
  readonly promptConfig:CurrentPromptConfig;
  private definitions = new Map<string, ModuleDefinition>();
  constructor(definitions = defaultDefinitions.map(d=>semanticPrompts[d.type]?{...d,description:semanticPrompts[d.type].description,base_instruction:semanticPrompts[d.type].native,numbered_instruction:semanticPrompts[d.type].numbered}:d),config:PromptConfig=defaultPromptConfig) { this.promptConfig=normalizePromptConfig(config);definitions.forEach(d => this.register(d)); }
  register(definition: ModuleDefinition) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(definition.type) || this.definitions.has(definition.type)) throw new Error('模块类型非法或已注册。');
    if(definition.numbered_instruction!==undefined)promptConfigSchema.parse({...defaultPromptConfig,modules:{[definition.type]:{numbered_instruction:definition.numbered_instruction}}});
    this.definitions.set(definition.type, structuredClone(definition));
  }
  get(type: string) {
    const definition = this.definitions.get(type);
    if (!definition) throw new Error(`模块类型 ${type} 当前未安装，不能静默忽略。`);
    const result=structuredClone(definition),options=this.promptConfig.modules[type];
    result.model_name=options?.model_name??result.model_name??type;
    if(options?.native_instruction!==undefined)result.base_instruction=options.native_instruction;
    if(options?.numbered_instruction!==undefined)result.numbered_instruction=options.numbered_instruction;
    return result;
  }
  list() { return [...this.definitions.keys()].map(type=>this.get(type)); }
  resolveRecipe(recipe: Recipe): Recipe {
    const next = structuredClone(recipe);
    next.prompt_config=structuredClone(this.promptConfig);
    for (const module of next.modules) {
      const definition = this.get(module.reference_type);
      module.base_instruction = definition.base_instruction;
      const options=this.promptConfig.modules[module.reference_type];
      module.model_name=options?.model_name??definition.model_name??definition.type;
      if(options?.native_instruction!==undefined)module.base_instruction=options.native_instruction;
      if (definition.numbered_instruction !== undefined) module.numbered_instruction = definition.numbered_instruction;
      else delete module.numbered_instruction;
      if(options?.numbered_instruction!==undefined)module.numbered_instruction=options.numbered_instruction;
    }
    return next;
  }
  create(type: string): SemanticModule {
    const d = this.get(type);
    return { module_id: newId('mod'), reference_type: d.type, reference_id: newId(d.type), title: d.title,
      model_name:this.promptConfig.modules[type]?.model_name??d.model_name??d.type,
      enabled: true, base_instruction: d.base_instruction, user_instruction: '', asset_ids: [],
      ...(d.numbered_instruction?{numbered_instruction:d.numbered_instruction}:{}),
      ...(d.default_tool_state ? { tool_state: structuredClone(d.default_tool_state) } : {}) };
  }
  validateToolState(type:string,state:Record<string,unknown>){
    const fields=this.get(type).tool_fields;
    if(!fields)throw new Error('参考工具未声明状态格式。');
    if(Object.keys(state).some(k=>!fields.some(f=>f.key===k)))throw new Error('参考工具包含未知状态字段。');
    for(const field of fields){const error=fieldError(field,state[field.key],'');if(error)throw new Error(error);}
    return structuredClone(state);
  }
  copy(module: SemanticModule): SemanticModule {
    return { ...structuredClone(module), module_id: newId('mod'), reference_id: newId(module.reference_type) };
  }
}
