import type { Block, CompiledChain } from './domain.js';

// New generation requests keep module order and nearby image references explicit.
// Only adjacent text within one module is joined; images never move or deduplicate.
export function generationMarkdownBlocks(chain:CompiledChain):Block[]{
  const blocks:Block[]=[];
  let previous:Block|undefined,moduleNumber=0;
  const text=(source:Block,value:string,text_role:'header'|'instruction'|'user'|'image_label')=>{
    const last=blocks.at(-1);
    if(last?.type==='text'&&last.source_module_id===source.source_module_id){
      last.text+=value;
      return;
    }
    blocks.push({type:'text',text:value,text_role,source_module_id:source.source_module_id,reference_type:source.reference_type,reference_id:source.reference_id,model_name:source.model_name});
  };
  let hasContent=false;
  for(const block of chain.blocks){
    if(block.source_module_id!==previous?.source_module_id){
      text(block,`${previous?'\n\n':''}## ${++moduleNumber}. ${block.model_name??block.reference_type}\n\n`,'header');
      hasContent=false;
    }
    previous=block;
    if(block.type==='image'){
      if(!block.image_name)throw new Error('图文生图输入缺少参考图片编号。');
      text(block,`${hasContent?'\n\n':''}${block.image_name}:\n`,'image_label');
      blocks.push(structuredClone(block));
      hasContent=true;
      continue;
    }
    // Layout belongs to this representation; semantic text remains verbatim.
    if(block.text_role==='header'||block.text_role==='image_label'||!block.text.trim())continue;
    text(block,`${hasContent?'\n\n':''}${block.text}`,block.text_role??'user');
    hasContent=true;
  }
  return blocks;
}
