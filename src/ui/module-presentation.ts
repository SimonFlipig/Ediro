import type { Block, ModuleDefinition, SemanticModule } from '../core/domain.js';

// Only the visual representation changes. The original chain and saved input
// retain the exact core instruction, so display copy cannot reach the model.
export function describeInputBlock(block:Block,module:SemanticModule|undefined,definition:ModuleDefinition|undefined):string {
  if(block.type!=='text')return '';
  if(block.text_role==='instruction')return `${block.model_name??block.reference_type}:\n${definition?.description??'按模块功能使用参考信息。'}`;
  if(block.text_role==='user')return module?.user_instruction??'用户填写的内容';
  if(block.text_role==='header')return module?.title??definition?.title??'创作模块';
  if(block.text_role==='image_label')return '参考图片';
  // Older/unrecognized compiled blocks can contain private tuning text too.
  // Only display a legacy block verbatim when it is the user's own input.
  if(module?.user_instruction&&block.text===module.user_instruction)return module.user_instruction;
  return definition?.description??'按模块功能使用参考信息。';
}
