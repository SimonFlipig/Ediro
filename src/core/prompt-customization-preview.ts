import { compileRecipe, defaultInputStrategies } from './compiler.js';
import { defaultParameters, type Block, type Recipe } from './domain.js';
import { ModuleRegistry } from './modules.js';
import { normalizePromptConfig, type PromptConfig } from './prompt-config.js';
import { releasePromptConfig } from './release-prompt-config.js';
import { customizableModuleTypeSchema, promptCustomizationsSchema, type CustomizableModuleType, type ModuleInstructionOverrides } from './prompt-customization.js';

export interface InstructionPreviewOptions {
  imageCount?:number;
  toolState?:Record<string,unknown>;
  config?:PromptConfig;
}
export interface InstructionPreview { native:Block[]; numbered:string; images:string[] }

// Each expression previews exactly the text supplied by the caller (including
// a displayed factory default). It never borrows another field or module.
export function previewModuleInstructions(type:CustomizableModuleType,instructions:ModuleInstructionOverrides,options:InstructionPreviewOptions={}):InstructionPreview{
  customizableModuleTypeSchema.parse(type);
  const entry=promptCustomizationsSchema.parse({version:1,modules:{[type]:instructions},roles:{}}).modules[type]!;
  const imageCount=options.imageCount??1;
  if(!Number.isInteger(imageCount)||imageCount<1||imageCount>16)throw new Error('预览图片数量需为 1～16。');
  const images=Array.from({length:imageCount},(_,index)=>`image_${index+1}`);
  const compile=(expression:string)=>{
    const config=normalizePromptConfig(options.config??releasePromptConfig);
    // Only formatting is inherited; instruction text comes entirely from the
    // supplied expression rather than from the active configuration.
    config.modules={
      [type]:{...config.modules[type],header:false,native_instruction:expression,numbered_instruction:expression},
      prompt:{header:false,native_instruction:'',numbered_instruction:''},
    };
    config.image_label='';
    const registry=new ModuleRegistry(undefined,config),module=registry.create(type),prompt=registry.create('prompt');
    module.module_id='mod_instruction_preview';module.reference_id='ref_instruction_preview';
    prompt.module_id='mod_preview_prompt';prompt.reference_id='ref_preview_prompt';
    module.asset_ids=images.map((_,index)=>`asset_preview_${index+1}`);
    if(type==='viewpoint'&&options.toolState)module.tool_state=registry.validateToolState(type,{...module.tool_state,...options.toolState});
    const recipe:Recipe={schema_version:1,recipe_id:'recipe_instruction_preview',modules:[module,prompt],model_config_id:'model_instruction_preview',core_parameters:structuredClone(defaultParameters)};
    // This editor previews just the selected expression, not a full generation
    // request or its structural envelope.
    return compileRecipe(recipe,registry,{purpose:'understanding'});
  };
  const native=entry.native_instruction?.trim()?defaultInputStrategies.get('interleaved').compile(compile(entry.native_instruction)).blocks??[]:[];
  const numbered=entry.numbered_instruction?.trim()?defaultInputStrategies.get('numbered_flat').compile(compile(entry.numbered_instruction)).prompt??'':'';
  return {native,numbered,images:numbered?images:[]};
}
