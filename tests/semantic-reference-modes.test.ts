import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptChain, compileRecipe } from '../src/core/compiler.js';
import { defaultParameters, moduleSchema, type Recipe } from '../src/core/domain.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { seedModels } from '../src/core/models.js';
import { defaultPromptConfig } from '../src/core/prompt-config.js';
import { prepareModuleInference } from '../src/core/module-inference.js';

function fixture(){
  const config=structuredClone(defaultPromptConfig);
  config.modules.subject={native_instruction:'SUBJECT_IMAGE_CORE {images}',numbered_instruction:'SUBJECT_NUMBERED_CORE {images}'};
  config.modules.composition={native_instruction:'COMPOSITION_IMAGE_CORE',numbered_instruction:'COMPOSITION_NUMBERED_CORE {images}'};
  config.modules.style={native_instruction:'STYLE_IMAGE_CORE',numbered_instruction:'STYLE_NUMBERED_CORE {images}'};
  config.modules.viewpoint={native_instruction:'VIEWPOINT_IMAGE_CORE {viewpoint}',numbered_instruction:'VIEWPOINT_NUMBERED_CORE {images} {viewpoint}'};
  const registry=new ModuleRegistry(undefined,config);
  const subject=registry.create('subject'),composition=registry.create('composition'),style=registry.create('style'),imageText=registry.create('image_text'),prompt=registry.create('prompt');
  subject.asset_ids=['asset_subject'];subject.reference_mode='text_only';
  composition.asset_ids=['asset_composition','asset_composition_other'];composition.user_instruction='主体居中，留出右侧文字空间。';
  style.asset_ids=['asset_style'];style.user_instruction='户外庭院与柔和光线。';
  imageText.asset_ids=['asset_extra'];imageText.user_instruction='额外参考';prompt.user_instruction='保持产品结构';
  const recipe:Recipe={recipe_id:'recipe_reference_modes',schema_version:1,modules:[subject,composition,style,imageText,prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  return{registry,recipe,subject,composition,style,imageText,prompt};
}

for(const strategy of ['interleaved','numbered_flat'] as const){
  test(`文字参考在 ${strategy} 生图请求中排除图片和核心语义，正文保留且编号连续`,()=>{
    const f=fixture();f.composition.reference_mode='text_only';f.style.reference_mode='text_only';
    const before=structuredClone(f.recipe),chain=compileRecipe(f.recipe,f.registry);
    const input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
    const ids=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='image').map(block=>block.asset_id):input.image_asset_ids;
    assert.deepEqual(ids,['asset_subject','asset_extra']);
    assert.deepEqual(chain.blocks.filter(block=>block.type==='image').map(block=>block.image_name),['image_1','image_2']);
    const sent=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join('\n'):input.prompt!;
    assert.match(sent,/主体居中，留出右侧文字空间。/);assert.match(sent,/户外庭院与柔和光线。/);
    assert.doesNotMatch(sent,/COMPOSITION_(?:IMAGE|NUMBERED)_CORE|STYLE_(?:IMAGE|NUMBERED)_CORE|image_3/);
    assert.ok(chain.blocks.some(block=>block.source_module_id===f.subject.module_id&&block.type==='image'));
    assert.deepEqual(f.recipe,before);
  });

  test(`自动提示词在 ${strategy} 中过滤四类额外要求，按参考模式保留图片与核心且编号连续`,()=>{
    for(const compositionMode of [undefined,'image_text','text_only'] as const)for(const styleMode of [undefined,'image_text','text_only'] as const){
      const f=fixture();f.prompt.auto_prompt=true;f.prompt.user_instruction='最终画面描述';
      f.composition.reference_mode=compositionMode;f.style.reference_mode=styleMode;f.subject.user_instruction='主体改成蓝色';
      const viewpoint=f.registry.create('viewpoint');viewpoint.user_instruction='从左侧观察';viewpoint.asset_ids=['asset_viewpoint'];
      const otherPrompt=f.registry.create('prompt');otherPrompt.user_instruction='其它提示词保持清晰';f.recipe.modules.push(viewpoint,otherPrompt);
      f.registry.register({type:'detail',title:'细节',description:'独立扩展模块',base_instruction:'DETAIL_CORE',editor_kind:'text',accepts_images:false});
      const detail=f.registry.create('detail');detail.user_instruction='独立扩展文字仍需直传';f.recipe.modules.push(detail);
      const before=structuredClone(f.recipe),chain=compileRecipe(f.recipe,f.registry),input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
      const ids=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='image').map(block=>block.asset_id):input.image_asset_ids;
      const expectedIds=['asset_subject',...(compositionMode!=='text_only'?f.composition.asset_ids:[]),...(styleMode!=='text_only'?f.style.asset_ids:[]),'asset_extra','asset_viewpoint'];
      assert.deepEqual(ids,expectedIds);assert.deepEqual(chain.blocks.filter(block=>block.type==='image').map(block=>block.image_name),expectedIds.map((_,index)=>`image_${index+1}`));
      const sent=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join('\n'):input.prompt!;
      for(const module of [f.imageText,f.prompt,otherPrompt,detail])assert.ok(sent.includes(module.user_instruction));
      for(const module of [f.subject,f.composition,f.style,viewpoint])assert.ok(!sent.includes(module.user_instruction));
      assert.ok(sent.includes(`SUBJECT_${strategy==='interleaved'?'IMAGE':'NUMBERED'}_CORE`));
      assert.ok(sent.includes(`VIEWPOINT_${strategy==='interleaved'?'IMAGE':'NUMBERED'}_CORE`));
      assert.doesNotMatch(sent,/\{viewpoint\}/);
      for(const [module,mode,core] of [[f.composition,compositionMode,'COMPOSITION'],[f.style,styleMode,'STYLE']] as const){
        if(mode==='text_only'){
          assert.ok(!sent.includes(module.user_instruction));
          assert.ok(chain.blocks.every(block=>block.source_module_id!==module.module_id));assert.ok(!sent.includes(`${core}_`));
        }else{
          assert.ok(sent.includes(`${core}_${strategy==='interleaved'?'IMAGE':'NUMBERED'}_CORE`));
          if(strategy==='numbered_flat')assert.ok(sent.includes(`${core}_NUMBERED_CORE ${module.asset_ids.map(id=>`image_${expectedIds.indexOf(id)+1}`).join(', ')}`));
        }
      }
      assert.deepEqual(f.recipe,before);
    }
  });

  test(`自动提示词的 ${strategy} 理解输入仍保留图文、缺省及仅描述模式的正文和全部图片`,()=>{
    for(const mode of [undefined,'image_text','text_only'] as const){
      const f=fixture();f.prompt.auto_prompt=true;f.composition.reference_mode=mode;f.style.reference_mode=mode;f.subject.user_instruction='主体改成蓝色';
      const viewpoint=f.registry.create('viewpoint');viewpoint.asset_ids=['asset_viewpoint'];viewpoint.user_instruction='从左侧观察';f.recipe.modules.push(viewpoint);
      const chain=compileRecipe(f.recipe,f.registry,{purpose:'understanding'}),input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
      const ids=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='image').map(block=>block.asset_id):input.image_asset_ids;
      const sent=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join('\n'):input.prompt!;
      const expectedIds=['asset_subject','asset_composition','asset_composition_other','asset_style','asset_extra','asset_viewpoint'];
      assert.deepEqual(ids,expectedIds);
      for(const module of [f.subject,f.composition,f.style,viewpoint,f.imageText])assert.ok(sent.includes(module.user_instruction));
      const model={...seedModels()[2],purpose:'understanding' as const,executable:true,generation_contract:{...seedModels()[2].generation_contract!,input_forms:[strategy]},capabilities:{...seedModels()[2].capabilities,operations:['understand']}};
      const prepared=prepareModuleInference(f.recipe,f.prompt.module_id,f.prompt.user_instruction,model,f.registry,false,undefined,{automatic:true});
      const first=prepared.job.chain_snapshot.blocks[0];assert.equal(first.type,'text');if(first.type!=='text')throw Error('missing inference context');
      const context=JSON.parse(first.text);
      for(const module of [f.subject,f.composition,f.style,viewpoint,f.imageText])assert.ok(context.references.some((reference:{requirements?:string})=>reference.requirements===module.user_instruction));
      assert.deepEqual(prepared.job.chain_snapshot.blocks.filter(block=>block.type==='image').map(block=>block.asset_id),expectedIds);
    }
  });

  test(`关闭、禁用或移除自动目标后 ${strategy} 恢复四类额外正文，参考图仍按原模式发送`,()=>{
    for(const change of ['off','disable','remove'] as const){
      const f=fixture();f.prompt.auto_prompt=true;f.composition.reference_mode='text_only';f.style.reference_mode='image_text';
      f.subject.user_instruction='主体改成蓝色';const viewpoint=f.registry.create('viewpoint');viewpoint.user_instruction='从左侧观察';f.recipe.modules.push(viewpoint);
      const manualPrompt=f.registry.create('prompt');manualPrompt.user_instruction='保留手动生成要求';f.recipe.modules.push(manualPrompt);
      const automatic=compileRecipe(f.recipe,f.registry);
      for(const module of [f.subject,f.composition,f.style,viewpoint])assert.ok(automatic.blocks.every(block=>block.type!=='text'||block.text!==module.user_instruction));
      if(change==='off')f.prompt.auto_prompt=false;
      if(change==='disable')f.prompt.enabled=false;
      if(change==='remove')f.recipe.modules=f.recipe.modules.filter(module=>module.module_id!==f.prompt.module_id);
      const before=structuredClone(f.recipe),chain=compileRecipe(f.recipe,f.registry),input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
      const sent=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join('\n'):input.prompt!;
      for(const module of [f.subject,f.composition,f.style,viewpoint,f.imageText,manualPrompt])assert.ok(sent.includes(module.user_instruction));
      assert.deepEqual(chain.blocks.filter(block=>block.type==='image').map(block=>block.asset_id),['asset_subject','asset_style','asset_extra']);
      assert.deepEqual(f.recipe,before);
    }
  });

  test(`自动目标为空或尚未成功时 ${strategy} 仍过滤四类额外正文且不隐式阻止编译`,()=>{
    for(const text of ['','尚未推理的手写草稿'])for(const previousKey of [undefined,'auto-v1:old']){
      const f=fixture();f.prompt.auto_prompt=true;f.prompt.user_instruction=text;f.prompt.auto_prompt_input_key=previousKey;
      f.composition.reference_mode='text_only';f.style.reference_mode='image_text';
      f.subject.user_instruction='主体改成蓝色';const viewpoint=f.registry.create('viewpoint');viewpoint.user_instruction='从左侧观察';f.recipe.modules.push(viewpoint);
      const chain=compileRecipe(f.recipe,f.registry),input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
      const sent=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join('\n'):input.prompt!;
      for(const module of [f.subject,f.composition,f.style,viewpoint])assert.ok(!sent.includes(module.user_instruction));
      assert.ok(chain.blocks.every(block=>block.source_module_id!==f.composition.module_id));
      assert.ok(chain.blocks.some(block=>block.type==='image'&&block.asset_id==='asset_style'));
      if(text)assert.ok(sent.includes(text));
      assert.equal(f.composition.user_instruction,'主体居中，留出右侧文字空间。');assert.equal(f.style.user_instruction,'户外庭院与柔和光线。');
    }
  });

  test(`${strategy} 手改最终正文后不重附原要求，重复参考图片保留原顺序`,()=>{
    const f=fixture();f.prompt.auto_prompt=true;f.subject.user_instruction='枕头平放，不要挡住床头造型';f.prompt.user_instruction='移走全部枕头，露出床头造型';
    f.subject.asset_ids=['asset_subject','asset_subject'];f.style.asset_ids=['asset_subject','asset_style'];
    const before=structuredClone(f.recipe),chain=compileRecipe(f.recipe,f.registry),input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
    const ids=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='image').map(block=>block.asset_id):input.image_asset_ids;
    assert.deepEqual(ids,['asset_subject','asset_subject','asset_composition','asset_composition_other','asset_subject','asset_style','asset_extra']);
    assert.deepEqual(chain.blocks.filter(block=>block.type==='image').map(block=>block.image_name),Array.from({length:7},(_,index)=>`image_${index+1}`));
    const sent=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join('\n'):input.prompt!;
    assert.ok(sent.includes(f.prompt.user_instruction));assert.ok(!sent.includes(f.subject.user_instruction));
    assert.ok(sent.includes(f.imageText.user_instruction));assert.deepEqual(f.recipe,before);
  });

  test(`${strategy} 无图片但有额外文字的四类模块保留有效核心，真正空模块不激活`,()=>{
    const f=fixture();f.prompt.auto_prompt=true;
    const viewpoint=f.registry.create('viewpoint');viewpoint.user_instruction='从左侧观察';viewpoint.tool_state={yaw:-45,pitch:-30,roll:0,projection:'perspective'};
    f.subject.user_instruction='主体改成蓝色';f.recipe.modules=[f.subject,f.composition,f.style,viewpoint,f.prompt];
    const references=[f.subject,f.composition,f.style,viewpoint];
    for(const module of references)module.asset_ids=[];
    const chain=compileRecipe(f.recipe,f.registry),input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
    const sent=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join('\n'):input.prompt!;
    for(const [module,core] of references.map((module,index)=>[module,['SUBJECT','COMPOSITION','STYLE','VIEWPOINT'][index]] as const)){
      assert.ok(chain.blocks.some(block=>block.source_module_id===module.module_id&&block.type==='text'&&block.text_role==='instruction'));
      assert.ok(sent.includes(core+'_IMAGE_CORE'));assert.ok(!sent.includes(module.user_instruction));
    }
    assert.match(sent,/Front-right three-quarter view, High-angle view/);assert.equal(chain.mode,'text_to_image');
    for(const module of references)module.user_instruction=' \n\t ';
    const empty=compileRecipe(f.recipe,f.registry);
    assert.ok(empty.blocks.every(block=>block.source_module_id===f.prompt.module_id));
  });

  test(`${strategy} 清空核心且无图片的自动参考不留下空标题，有图时仍保留参考图`,()=>{
    const f=fixture();f.prompt.auto_prompt=true;f.subject.user_instruction='仍送给推理的主体要求';f.subject.asset_ids=[];
    const config=structuredClone(f.registry.promptConfig);config.modules.subject={native_instruction:'',numbered_instruction:'ONLY_NUMBERED {images}'};
    const registry=new ModuleRegistry(undefined,config);
    f.recipe.modules=[f.subject,f.prompt];
    const empty=compileRecipe(f.recipe,registry);assert.ok(empty.blocks.every(block=>block.source_module_id===f.prompt.module_id));
    f.subject.asset_ids=['asset_subject'];config.modules.subject={native_instruction:'',numbered_instruction:''};
    const chain=compileRecipe(f.recipe,new ModuleRegistry(undefined,config)),input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
    const ids=input.kind==='native_blocks'?input.blocks!.filter(block=>block.type==='image').map(block=>block.asset_id):input.image_asset_ids;
    assert.deepEqual(ids,['asset_subject']);
    assert.ok(chain.blocks.every(block=>block.type!=='text'||block.text_role!=='instruction'));
    assert.ok(chain.blocks.every(block=>block.type!=='text'||block.text!==f.subject.user_instruction));
  });
}

test('缺省仍为图文参考，文字模块之后的图文参考使用实际发送图片编号',()=>{
  const f=fixture();f.composition.reference_mode='text_only';
  const chain=compileRecipe(f.recipe,f.registry),input=adaptChain(chain,seedModels()[1]);
  assert.deepEqual(input.image_asset_ids,['asset_subject','asset_style','asset_extra']);
  assert.match(input.prompt!,/STYLE_NUMBERED_CORE image_2/);assert.doesNotMatch(input.prompt!,/COMPOSITION_NUMBERED_CORE/);
  f.composition.reference_mode='image_text';
  assert.deepEqual(compileRecipe(f.recipe,f.registry).blocks.filter(block=>block.type==='image').map(block=>block.asset_id),['asset_subject','asset_composition','asset_composition_other','asset_style','asset_extra']);
});

test('理解链保留两种文字参考的图片、语义和连续编号',()=>{
  const f=fixture();f.composition.reference_mode='text_only';f.style.reference_mode='text_only';
  const chain=compileRecipe(f.recipe,f.registry,{purpose:'understanding'});
  assert.deepEqual(chain.blocks.filter(block=>block.type==='image').map(block=>block.image_name),['image_1','image_2','image_3','image_4','image_5']);
  const input=adaptChain(chain,seedModels()[1]);
  assert.match(input.prompt!,/COMPOSITION_NUMBERED_CORE image_2, image_3/);
  assert.match(input.prompt!,/STYLE_NUMBERED_CORE image_4/);
  assert.deepEqual(input.image_asset_ids,['asset_subject','asset_composition','asset_composition_other','asset_style','asset_extra']);
});

test('仅有图片的文字参考不生成空模块，移除全部参考后成为纯文字请求',()=>{
  const f=fixture();f.composition.reference_mode='text_only';f.composition.user_instruction='';
  f.style.reference_mode='text_only';f.recipe.modules=[f.composition,f.style,f.prompt];
  const chain=compileRecipe(f.recipe,f.registry);
  assert.equal(chain.mode,'text_to_image');assert.ok(chain.blocks.every(block=>block.type==='text'));
  assert.ok(chain.blocks.every(block=>block.source_module_id!==f.composition.module_id));
  assert.ok(chain.blocks.some(block=>block.source_module_id===f.style.module_id&&block.type==='text'&&block.text===f.style.user_instruction));
});

test('同一素材可同时用于主体和文字参考，按模块过滤而不误删主体图',()=>{
  const f=fixture();f.composition.asset_ids=['asset_subject'];f.composition.reference_mode='text_only';
  f.style.enabled=false;f.imageText.enabled=false;
  const images=compileRecipe(f.recipe,f.registry).blocks.filter(block=>block.type==='image');
  assert.equal(images.length,1);assert.equal(images[0].source_module_id,f.subject.module_id);assert.equal(images[0].asset_id,'asset_subject');
});

test('旧模块兼容新可选字段，复制自动提示词关闭自动目标并移除复用标记',()=>{
  const f=fixture();const old=moduleSchema.parse(f.prompt);
  assert.equal(old.auto_prompt,undefined);assert.equal(old.auto_prompt_input_key,undefined);assert.equal(old.reference_mode,undefined);
  f.prompt.auto_prompt=true;f.prompt.auto_prompt_input_key='auto-v1:'+'a'.repeat(64);f.prompt.user_instruction='已生成并编辑的内容';
  const copy=f.registry.copy(f.prompt);
  assert.equal(copy.auto_prompt,false);assert.equal(copy.auto_prompt_input_key,undefined);assert.equal(copy.user_instruction,f.prompt.user_instruction);
  assert.notEqual(copy.module_id,f.prompt.module_id);assert.equal(f.prompt.auto_prompt,true);assert.ok(f.prompt.auto_prompt_input_key);
  f.style.reference_mode='text_only';assert.equal(f.registry.copy(f.style).reference_mode,'text_only');
  assert.throws(()=>moduleSchema.parse({...f.prompt,auto_prompt_input_key:'x'.repeat(129)}));
});
