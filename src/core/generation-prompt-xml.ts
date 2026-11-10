import type { AdaptedInput, Block, CompiledChain } from './domain.js';

function escapeXml(value:string){
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// Versions 3 and 4 keep unescaped semantic blocks for editing and presentation.
// Version 4 uses XML only for numbered flat input; version 3 also used it natively.
// Group by module identity, never by type or asset ID (both may repeat).
export function generationXmlBlocks(chain:CompiledChain,variant:'native'|'numbered'):Block[]{
  if(!chain.blocks.length)return [];
  const blocks:Block[]=[];
  const text=(source:Block,value:string,text_role:'header'|'instruction'|'user'|'image_label'='header')=>{
    blocks.push({type:'text',text:value,text_role,source_module_id:source.source_module_id,reference_type:source.reference_type,reference_id:source.reference_id,model_name:source.model_name});
  };
  text(chain.blocks[0],'<generation_request>\n');
  if(chain.format_version===4&&variant==='numbered'&&chain.blocks.some(block=>block.type==='image')){
    text(chain.blocks[0],'<image_mapping>image_N refers to the Nth attached image (1-based), in attachment order. Image numbers are independent of module numbers.</image_mapping>\n');
  }
  let previous:Block|undefined;
  const closeModule=()=>{
    if(previous)text(previous,previous.reference_type==='prompt'?'\n</generation_prompt>\n':'</module>\n');
  };
  for(const block of chain.blocks){
    if(block.source_module_id!==previous?.source_module_id){
      closeModule();
      text(block,block.reference_type==='prompt'?'<generation_prompt>':`<module type="${escapeXml(block.reference_type)}" name="${escapeXml(block.model_name??block.reference_type)}">\n`);
    }
    previous=block;
    if(block.type==='image'){
      if(!block.image_name)throw new Error('结构化生图输入缺少参考图片编号。');
      text(block,`<image_ref id="${escapeXml(block.image_name)}"/>\n`,'image_label');
      blocks.push(structuredClone(block));
      continue;
    }
    // Legacy layout templates are kept in snapshots, but cannot open/close XML
    // or introduce an alternative image label in the new representation.
    if(block.text_role==='header'||block.text_role==='image_label')continue;
    const content=variant==='numbered'?(block.numbered_text??block.text):block.text;
    if(!content.trim())continue;
    if(block.reference_type==='prompt')text(block,escapeXml(content),'user');
    else {
      const tag=block.text_role==='instruction'?'reference_rules':'requirements';
      text(block,`<${tag}>${escapeXml(content)}</${tag}>\n`,block.text_role==='instruction'?'instruction':'user');
    }
  }
  closeModule();
  text(chain.blocks.at(-1)!,'</generation_request>');
  return blocks;
}

// Planning may already need a textual aspect-ratio hint. Keep that existing
// requirement inside the document without changing its wording or API fields.
// Custom strategies that do not use this envelope retain their original path.
export function appendGenerationXmlRequirement(input:AdaptedInput,requirement:string):boolean{
  const closing='</generation_request>',text=`<requirements>${escapeXml(requirement)}</requirements>\n`;
  if(input.kind==='separated_inputs'){
    if(!input.prompt?.startsWith('<generation_request>\n')||!input.prompt.endsWith(closing))return false;
    input.prompt=input.prompt.slice(0,-closing.length)+text+closing;
  }else{
    const first=input.blocks?.[0],last=input.blocks?.at(-1);
    if(first?.type!=='text'||first.text!=='<generation_request>\n'||last?.type!=='text'||last.text!==closing)return false;
    input.blocks!.splice(-1,0,{...last,text,text_role:'user'});
  }
  return true;
}
