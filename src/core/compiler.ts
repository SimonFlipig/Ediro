import { recipeSchema, type AdaptedInput, type CompiledChain, type ModelConfig, type Recipe } from './domain.js';
import { ModuleRegistry } from './modules.js';
import { parseRatio } from './output-geometry.js';
import { validateGenerationParameters } from './generation-parameters.js';
import { contractFor } from './generation-parameters.js';
import type { InputStrategy } from './generation-contract.js';
import { renderPromptTemplate } from './prompt-config.js';
import { describeViewpoint } from '../shared/viewpoint.js';

function viewpointPromptValue(type:string,state:Record<string,unknown>|undefined){
  if(type!=='viewpoint'||!state)return '';
  const yaw=Number(state.yaw),pitch=Number(state.pitch);
  if(!Number.isFinite(yaw)||!Number.isFinite(pitch))return '';
  return describeViewpoint({yaw,pitch,roll:Number.isFinite(Number(state.roll))?Number(state.roll):0,projection:state.projection==='perspective'?'perspective':'orthographic'}).promptValue;
}

export function compileRecipe(input: Recipe, registry = new ModuleRegistry()): CompiledChain {
  const recipe = registry.resolveRecipe(recipeSchema.parse(input));
  const blocks: CompiledChain['blocks'] = [];
  const config=registry.promptConfig;let imageNumber=0,moduleNumber=0;
  for (const m of recipe.modules) {
    if (!m.enabled) continue;
    const definition = registry.get(m.reference_type);
    if (!definition.accepts_images && m.asset_ids.length) throw new Error(`${m.title} 不接受参考图片。`);
    if(!m.asset_ids.length&&!m.user_instruction.trim())continue;
    moduleNumber++;
    const names=m.asset_ids.map(()=>`image_${++imageNumber}`),images=names.join(config.image_separator),modelName=m.model_name??m.reference_type;
    const meta = { source_module_id: m.module_id, reference_type: m.reference_type, reference_id: m.reference_id,model_name:modelName };
    const header=config.modules[m.reference_type]?.header===false?'':renderPromptTemplate(config.module_header,{module:modelName,images,module_number:String(moduleNumber)});
    const viewpoint=viewpointPromptValue(m.reference_type,m.tool_state);
    if((m.base_instruction.includes('{viewpoint}')||m.numbered_instruction?.includes('{viewpoint}'))&&!viewpoint)throw new Error('视角模块缺少有效角度，无法展开 {viewpoint}。');
    const templateValues={images,viewpoint};
    const native=renderPromptTemplate(m.base_instruction,templateValues),numbered=names.length?renderPromptTemplate(m.numbered_instruction??m.base_instruction,templateValues):native;
    if (m.reference_type !== 'prompt' && m.base_instruction.trim()) {
      if (!m.asset_ids.length && !m.user_instruction.trim()) continue;
      blocks.push({ type: 'text',text_role:'instruction',text:[header,native].filter(Boolean).join(config.intra_module_separator),numbered_text:[header,numbered].filter(Boolean).join(config.intra_module_separator),...meta });
    }else if(header){
      blocks.push({type:'text',text_role:'header',text:header,...meta});
    }
    m.asset_ids.forEach((asset_id,index) => {const name=names[index],label=renderPromptTemplate(config.image_label,{image:name});if(label)blocks.push({type:'text',text_role:'image_label',text:label,...meta});blocks.push({ type: 'image', asset_id,image_name:name, ...meta });});
    if (m.user_instruction.trim()) blocks.push({ type: 'text',text_role:'user', text: m.user_instruction, ...meta });
  }
  return { format_version:2,prompt_config:structuredClone(config),blocks, mode: blocks.some(b => b.type === 'image') ? 'reference_generation' : 'text_to_image' };
}

export interface InputStrategyDefinition {
  id:string;title:string;form:'interleaved'|'numbered_flat';
  compile:(chain:CompiledChain)=>AdaptedInput;
}
export class InputStrategyRegistry {
  private definitions=new Map<string,InputStrategyDefinition>();
  register(definition:InputStrategyDefinition){
    if(definition.id==='auto'||!/^[a-z][a-z0-9_]{0,63}$/.test(definition.id)||this.definitions.has(definition.id))throw new Error('组合策略身份无效或重复。');
    this.definitions.set(definition.id,definition);return this;
  }
  list(){return [...this.definitions.values()].map(({compile,...description})=>description);}
  get(id:string){const d=this.definitions.get(id);if(!d)throw new Error('提示词组合策略未安装：'+id);return d;}
}
export function adaptChain(chain: CompiledChain, model: ModelConfig, strategy?:InputStrategy,registry=defaultInputStrategies): AdaptedInput {
  const images = chain.blocks.filter(b => b.type === 'image');
  if (images.length > model.capabilities.max_images) throw new Error(`当前模型最多接收 ${model.capabilities.max_images} 图片，当前为 ${images.length} ；请调整参考模块。`);
  if (!strategy && model.capabilities.interleaving === 'mediated') throw new Error('此接口需要主模型中介，第一阶段尚未接入，不能冒充原生图文混排。');
  const forms=contractFor(model).input_forms;
  const requested=strategy??(model.capabilities.interleaving==='native'?'interleaved':'numbered_flat');
  const actual=requested==='auto'?(forms.includes('interleaved')?'interleaved':'numbered_flat'):requested;
  const definition=registry.get(actual);
  if(!forms.includes(definition.form))throw new Error('当前模型不支持所选提示词组合方式，请显式选择编号拍平或按能力选择。');
  const input=definition.compile(structuredClone(chain));
  if((input.kind==='native_blocks'?'interleaved':'numbered_flat')!==definition.form)throw new Error('组合策略输出不符合声明。');
  const outputImages=input.kind==='native_blocks'?(input.blocks??[]).filter(b=>b.type==='image').map(b=>b.asset_id):input.image_asset_ids??[];
  if(JSON.stringify(outputImages)!==JSON.stringify(images.map(b=>b.asset_id)))throw new Error('组合策略不得丢弃、重排或去重参考图片。');
  return input;
}

function numberedInput(chain:CompiledChain):AdaptedInput {
  const images=chain.blocks.filter(b=>b.type==='image');
  if(chain.format_version===2){
    const config=chain.prompt_config;
    let prompt='';
    if(config?.version===2){
      let previousModule:string|undefined;
      for(const block of chain.blocks){
        if(block.type!=='text')continue;
        if(previousModule!==undefined)prompt+=previousModule===block.source_module_id?config.intra_module_separator:config.inter_module_separator;
        prompt+=block.numbered_text??block.text;
        previousModule=block.source_module_id;
      }
    }else{
      // Replaying a legacy compiled snapshot must preserve its original spacing.
      prompt=chain.blocks.filter(b=>b.type==='text').map(b=>b.numbered_text??b.text).join(config?.text_separator??'\n\n');
    }
    return {kind:'separated_inputs',prompt,image_asset_ids:images.map(b=>b.asset_id),adjustments:['此接口单独发送图片集合；image_N 与上传图片顺序一一对应，文字保持模块顺序。']};
  }
  const imageNumbers=new Map<string,number[]>();
  images.forEach((image,index)=>{const numbers=imageNumbers.get(image.source_module_id)??[];numbers.push(index+1);imageNumbers.set(image.source_module_id,numbers);});
  const described=new Set<string>();
  const modulesWithText=new Set(chain.blocks.filter(b=>b.type==='text').map(b=>b.source_module_id));
  const prompt = chain.blocks.flatMap(block=>{
    const numbers=imageNumbers.get(block.source_module_id);
    if(block.type==='image'){
      if(block.reference_type!=='image_text'||modulesWithText.has(block.source_module_id)||described.has(block.source_module_id))return [];
      described.add(block.source_module_id);
      return [numbers!.map(number=>`第 ${number} 输入图片`).join('、')+'。'];
    }
    if(!numbers)return [block.text];
    const label=numbers.map(number=>`第 ${number} 输入图片`).join('、');
    if(block.reference_type==='image_text')return [`${label}对应说明：${block.text}`];
    const first=!described.has(block.source_module_id);described.add(block.source_module_id);
    return [first&&block.numbered_text?block.numbered_text.replace('{images}',label):`${label}${first?'用于':'的补充要求：'}${block.text}`];
  }).join('\n\n');
  return { kind: 'separated_inputs', prompt, image_asset_ids: images.map(b => b.asset_id),
    adjustments: ['此接口不支持原生图文混排：将按原顺序保留文字与图片编号，并单独发送图片集合。没有丢弃图片。'] };
}

export const defaultInputStrategies=new InputStrategyRegistry()
  .register({id:'interleaved',title:'保持图文顺序',form:'interleaved',compile:chain=>({kind:'native_blocks',blocks:structuredClone(chain.blocks),adjustments:[]})})
  .register({id:'numbered_flat',title:'编号拍平',form:'numbered_flat',compile:numberedInput});

export function validateParameters(recipe: Recipe, model: ModelConfig) {
  validateGenerationParameters(recipe.core_parameters,model);
  if(model.purpose==='understanding')return;
  const p = recipe.core_parameters, c = model.capabilities;
  if ((p.aspect_ratio!=='auto'&&!c.aspect_ratios.includes(p.aspect_ratio)&&!parseRatio(p.aspect_ratio)) || !c.formats.includes(p.output_format) || p.count > c.max_count) {
    throw new Error('当前参数与所选模型不兼容；请使用该模型支持的选项。');
  }
}
