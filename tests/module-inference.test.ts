import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {ModuleRegistry} from '../src/core/modules.js';
import {seedModels} from '../src/core/models.js';
import {defaultParameters,type Recipe} from '../src/core/domain.js';
import {prepareModuleInference,executeModuleInference,applyAutomaticPromptSuggestion} from '../src/core/module-inference.js';
import {GeminiGenerator} from '../src/adapters/gemini-generator.js';
import {compileRecipe} from '../src/core/compiler.js';
import {commandSchema} from '../src/shared/commands.js';
import {automaticPromptTask,compositionDescriptionTask,styleDescriptionTask,inferenceInputError} from '../src/core/module-inference-tasks.js';
import {defaultModuleSettings} from '../src/core/module-settings.js';
import {getAutoPromptState} from '../src/core/auto-prompt.js';
import {modelFromPreset} from '../src/protocols/model-catalog.js';
import {promptRoles} from '../src/core/prompt-roles.js';

function fixture(){
  const registry=new ModuleRegistry(),subject=registry.create('subject'),neutral=registry.create('image_text'),prompt=registry.create('prompt'),disabled=registry.create('style');
  subject.asset_ids=['asset_a'];subject.user_instruction='不要改变标识。';neutral.asset_ids=['asset_b','asset_a'];neutral.user_instruction='白色背景';prompt.user_instruction='旧稿';disabled.enabled=false;disabled.asset_ids=['asset_secret'];disabled.user_instruction='不应发送';
  const recipe:Recipe={recipe_id:'recipe_test',schema_version:1,modules:[subject,neutral,disabled,prompt],model_config_id:'model_mock_native',core_parameters:defaultParameters};
  const model={...seedModels()[2],purpose:'understanding' as const,enabled:true,executable:true,model:'gemini-understanding',capabilities:{...seedModels()[2].capabilities,operations:['understand']}};
  return {registry,subject,neutral,prompt,recipe,model};
}

test('带生图预设的配方可用不同预设或无预设的理解模型，任务快照不污染原配方',()=>{
  for(const preset of ['gemini-3-1-pro',undefined]){
    const f=fixture();f.recipe.model_preset_id='nano-banana-pro';
    f.recipe.model_channels={'nano-banana-pro':f.recipe.model_config_id};
    const before=structuredClone(f.recipe),model={...modelFromPreset('gemini-3-1-pro','model_understanding','connection_test','custom-alias'),executable:true,preset_id:preset};
    for(const [moduleId,draft] of [[f.subject.module_id,''],[f.prompt.module_id,'优化这段描述']]){
      const prepared=prepareModuleInference(f.recipe,moduleId,draft,model,f.registry);
      assert.equal(prepared.job.recipe_snapshot.model_config_id,model.model_config_id);
      assert.equal(prepared.job.recipe_snapshot.model_preset_id,preset);
      assert.equal(prepared.job.model_snapshot.preset_id,preset);
      assert.equal(prepared.job.execution_plan?.operation,'understand');
      assert.deepEqual(f.recipe,before);
    }
  }
});
test('优化冻结未保存草稿和启用约束，图片按全局编号排列，不修改原配方',()=>{
  const f=fixture(),before=JSON.stringify(f.recipe),p=prepareModuleInference(f.recipe,f.prompt.module_id,'新的草稿',f.model,f.registry);
  const blocks=p.job.adapted_input.blocks!,text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
  assert.match(text,/新的草稿/);assert.match(text,/不要改变标识/);assert.ok(!text.includes('旧稿')&&!text.includes('不应发送'));
  assert.deepEqual(blocks.filter(b=>b.type==='image').map(b=>[b.asset_id,b.image_name]),[['asset_a','image_1'],['asset_b','image_2'],['asset_a','image_3']]);
  assert.equal(p.images_sent,3);assert.equal(JSON.stringify(f.recipe),before);
  f.recipe.modules[0].user_instruction='后续修改';assert.ok(!JSON.stringify(p.job).includes('后续修改'));
  const unsupported=f.registry.create('viewpoint');f.recipe.modules.push(unsupported);
  assert.throws(()=>prepareModuleInference(f.recipe,unsupported.module_id,'text',f.model,f.registry),/尚未配置推理任务/);
});

test('主体分析允许空文字，只发送当前主体图文并保留多图顺序，不混入其它模块',()=>{
  const f=fixture();f.subject.asset_ids=['asset_front','asset_side','asset_front'];f.subject.enabled=false;
  const before=JSON.stringify(f.recipe),p=prepareModuleInference(f.recipe,f.subject.module_id,'',f.model,f.registry);
  const blocks=p.job.chain_snapshot.blocks,text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
  assert.deepEqual(blocks.filter(b=>b.type==='image').map(b=>b.asset_id),['asset_front','asset_side','asset_front']);
  const context=JSON.parse(blocks[0].type==='text'?blocks[0].text.split('以下 JSON 是待处理内容：\n')[1]:'');
  assert.equal(context.length,1);assert.equal(context[0].role,'target');assert.equal(context[0].text,'');
  assert.equal(p.images_sent,3);assert.equal(p.job.stage,'分析主体特征');
  for(const excluded of ['白色背景','旧稿','不应发送','asset_b'])assert.ok(!text.includes(excluded));
  assert.match(text,/不推断不可见结构/);assert.match(text,/区分图片中的原始外观与用户要求的修改/);
  assert.equal(JSON.stringify(f.recipe),before);
});

test('主体分析必须有图片和看图能力，不能用仅文字授权绕过；图片上限仅计算任务上下文',()=>{
  const f=fixture(),task=f.registry.get('subject').inference_task!;
  const textModel={...f.model,capabilities:{...f.model.capabilities,max_images:0}};
  assert.match(inferenceInputError(task,'',1,0)!,/需要看图/);
  assert.throws(()=>prepareModuleInference(f.recipe,f.subject.module_id,'说明',textModel,f.registry,true),/需要看图/);
  const limited={...f.model,capabilities:{...f.model.capabilities,max_images:1}};
  assert.equal(prepareModuleInference(f.recipe,f.subject.module_id,'',limited,f.registry).images_sent,1);
  f.subject.asset_ids.push('asset_side');
  assert.throws(()=>prepareModuleInference(f.recipe,f.subject.module_id,'',limited,f.registry),/没有丢弃/);
  f.subject.asset_ids=[];
  assert.throws(()=>prepareModuleInference(f.recipe,f.subject.module_id,'已有描述',f.model,f.registry),/添加参考图片/);
});

test('新增模块只声明任务即可复用执行，接口允许空草稿且任务规则由后端决定',()=>{
  const f=fixture();
  f.registry.register({type:'detail',title:'细节',description:'局部细节',base_instruction:'',editor_kind:'image_collection',accepts_images:true,inference_task:{
    action_label:'描述细节',description:'当前局部图文',context_scope:'target',requires_text:false,requires_images:true,
    instruction:'只描述局部纹理。',output_instruction:'返回完整局部纹理说明。',
  }});
  const module=f.registry.create('detail');module.asset_ids=['asset_detail'];f.recipe.modules.push(module);
  const command=commandSchema.parse({type:'module:infer',request_id:'request_test',project_id:'project_test',module_id:module.module_id,model_config_id:f.model.model_config_id,text:'',allow_text_only:false});
  assert.equal(command.type,'module:infer');
  const p=prepareModuleInference(f.recipe,module.module_id,'',f.model,f.registry);
  assert.equal(p.job.stage,'描述细节');assert.equal(p.images_sent,1);
  const block=p.job.chain_snapshot.blocks[0];assert.equal(block.type,'text');if(block.type==='text')assert.match(block.text,/只描述局部纹理/);
  assert.throws(()=>prepareModuleInference(f.recipe,'missing_module','',f.model,f.registry),/不存在/);
});

test('主体经现有 Gemini 通道只请求文字，保留草稿，采用后才能进入生图链',async()=>{
  const f=fixture(),draft='把杯身改成白色，保留标识。',before=JSON.stringify(f.recipe);
  const p=prepareModuleInference(f.recipe,f.subject.module_id,draft,f.model,f.registry);
  const bytes=await sharp({create:{width:4,height:4,channels:3,background:'white'}}).png().toBuffer();let calls=0;
  const adapter=new GeminiGenerator(async(_url,init)=>{
    calls++;const body=JSON.parse(init!.body as string),parts=body.contents[0].parts;
    assert.deepEqual(body.generationConfig.responseModalities,['TEXT']);assert.equal(parts.filter((p:any)=>p.inlineData).length,1);
    assert.ok(JSON.stringify(parts).includes(draft));assert.ok(!JSON.stringify(parts).includes('白色背景'));
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'直筒杯身，杯盖略宽。杯身改成白色，保留标识。'}]}}]});
  });
  const suggestion=await executeModuleInference(adapter,{model:f.model,job:p.job,readImage:async id=>{assert.equal(id,'asset_a');return bytes;},resolveCredential:async()=>'test-key'},p,new AbortController().signal);
  assert.equal(calls,1);assert.equal(suggestion.original_text,draft);assert.equal(JSON.stringify(f.recipe),before);
  f.subject.user_instruction=suggestion.text;
  assert.ok(compileRecipe(f.recipe,f.registry).blocks.some(b=>b.type==='text'&&b.text===suggestion.text));
});

test('调用期间取消和意外图片输出均拒绝采用',async()=>{
  const f=fixture(),p=prepareModuleInference(f.recipe,f.subject.module_id,'',f.model,f.registry),controller=new AbortController();
  const context={model:f.model,job:p.job,readImage:async()=>Buffer.alloc(0),resolveCredential:async()=>''};
  await assert.rejects(executeModuleInference({execute:async()=>{controller.abort();return {images:[],text:'过期建议'};}},context,p,controller.signal),/取消/);
  await assert.rejects(executeModuleInference({execute:async()=>({images:[{bytes:Buffer.alloc(0),format:'png',width:1,height:1}],text:'意外图片'})},context,p,new AbortController().signal),/有效的文字/);
  assert.equal(f.subject.user_instruction,'不要改变标识。');
});
test('纯文字模型需明确同意；超出图片限制不丢图、不发送禁用素材',()=>{
  const f=fixture(),textModel={...f.model,capabilities:{...f.model.capabilities,max_images:0}};
  assert.throws(()=>prepareModuleInference(f.recipe,f.neutral.module_id,'draft',textModel,f.registry),/明确选择/);
  const p=prepareModuleInference(f.recipe,f.neutral.module_id,'draft',textModel,f.registry,true);
  assert.equal(p.images_sent,0);assert.ok(!p.job.adapted_input.blocks!.some(b=>b.type==='image'));
  assert.throws(()=>prepareModuleInference(f.recipe,f.prompt.module_id,'draft',{...f.model,capabilities:{...f.model.capabilities,max_images:2}},f.registry),/没有丢弃/);
  assert.throws(()=>prepareModuleInference(f.recipe,f.prompt.module_id,'   ',f.model,f.registry),/先填写/);
});
test('Gemini 优化请求发送上下文图片，只请求文字，返回建议且不自动应用',async()=>{
  const f=fixture(),p=prepareModuleInference(f.recipe,f.neutral.module_id,'更丰富的场景',f.model,f.registry),before=JSON.stringify(f.recipe);
  const bytes=await sharp({create:{width:4,height:4,channels:3,background:'white'}}).png().toBuffer();let calls=0;
  const adapter=new GeminiGenerator(async(_url,init)=>{calls++;const body=JSON.parse(init!.body as string);assert.equal(body.generationConfig.maxOutputTokens,16384);assert.deepEqual(body.generationConfig.responseModalities,['TEXT']);assert.equal(body.generationConfig.imageConfig,undefined);assert.equal(body.contents[0].parts.filter((b:any)=>b.inlineData).length,3);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'internal'},{text:'自然光下的简洁场景。'}]}}]});});
  const suggestion=await executeModuleInference(adapter,{model:f.model,job:p.job,readImage:async id=>{assert.ok(['asset_a','asset_b'].includes(id));return bytes;},resolveCredential:async()=>'test-key'},p,new AbortController().signal);
  assert.equal(suggestion.text,'自然光下的简洁场景。');assert.equal(suggestion.original_text,'更丰富的场景');assert.equal(calls,1);assert.equal(JSON.stringify(f.recipe),before);
});
test('取消、空结果、超长结果和网络失败不会自动重试或写入',async()=>{
  const f=fixture(),p=prepareModuleInference(f.recipe,f.prompt.module_id,'draft',f.model,f.registry),context={model:f.model,job:p.job,readImage:async()=>Buffer.alloc(0),resolveCredential:async()=>''};
  const aborted=new AbortController();aborted.abort();let calls=0;
  await assert.rejects(executeModuleInference({execute:async()=>{calls++;return {images:[],text:'x'};}},context,p,aborted.signal),/取消/);assert.equal(calls,0);
  for(const text of ['', 'x'.repeat(32001)])await assert.rejects(executeModuleInference({execute:async()=>({images:[],text})},context,p,new AbortController().signal),/有效的文字/);
  await assert.rejects(executeModuleInference({execute:async()=>{calls++;throw Error('network');}},context,p,new AbortController().signal),/network/);assert.equal(calls,1);assert.equal(f.prompt.user_instruction,'旧稿');
});

test('自动推理只接受启用的自动提示词目标，允许空白正文且不改变手动优化规则',()=>{
  const f=fixture();f.prompt.auto_prompt=true;f.prompt.user_instruction='';
  const command=commandSchema.parse({type:'module:infer',request_id:'request_auto',project_id:'project_test',module_id:f.prompt.module_id,model_config_id:f.model.model_config_id,text:'',allow_text_only:false,automatic:true});
  assert.equal(command.type,'module:infer');assert.equal(command.type==='module:infer'&&command.automatic,true);
  const before=structuredClone(f.recipe),p=prepareModuleInference(f.recipe,f.prompt.module_id,'',f.model,f.registry,false,undefined,{automatic:true});
  assert.equal(p.job.stage,automaticPromptTask.action_label);assert.equal(p.original_text,'');assert.deepEqual(f.recipe,before);
  assert.throws(()=>prepareModuleInference(f.recipe,f.prompt.module_id,'',f.model,f.registry),/先填写/);
  f.prompt.enabled=false;
  assert.throws(()=>prepareModuleInference(f.recipe,f.prompt.module_id,'',f.model,f.registry,false,undefined,{automatic:true}),/启用/);
  f.prompt.enabled=true;f.prompt.auto_prompt=false;
  assert.throws(()=>prepareModuleInference(f.recipe,f.prompt.module_id,'',f.model,f.registry,false,undefined,{automatic:true}),/启用/);
  assert.throws(()=>prepareModuleInference(f.recipe,f.subject.module_id,'',f.model,f.registry,false,undefined,{automatic:true}),/启用/);
});

test('自动全局上下文保留文字参考的清晰源图，构图与风格分别按提取语义限定',()=>{
  const f=fixture();f.prompt.auto_prompt=true;f.prompt.user_instruction='不要添加文字';
  const composition=f.registry.create('composition'),style=f.registry.create('style');
  composition.asset_ids=['asset_composition'];composition.reference_mode='text_only';composition.user_instruction='主体占画面三分之一';
  style.asset_ids=['asset_style'];style.reference_mode='text_only';style.user_instruction='保持自然光';
  f.recipe.modules.push(composition,style);
  const viewpoint=f.registry.create('viewpoint');viewpoint.tool_state={yaw:45,pitch:20,roll:0,projection:'perspective'};viewpoint.user_instruction='俯视';f.recipe.modules.push(viewpoint);
  const p=prepareModuleInference(f.recipe,f.prompt.module_id,f.prompt.user_instruction,f.model,f.registry,false,undefined,{automatic:true});
  const blocks=p.job.chain_snapshot.blocks,first=blocks[0];assert.equal(first.type,'text');if(first.type!=='text')return;
  const context=JSON.parse(first.text.split('以下 JSON 是待处理内容：\n')[1]);
  assert.deepEqual(blocks.filter(block=>block.type==='image').map(block=>block.asset_id),['asset_a','asset_b','asset_a','asset_composition','asset_style']);
  const compositionContext=context.find((module:any)=>module.reference_type==='composition');
  const styleContext=context.find((module:any)=>module.reference_type==='style');
  assert.equal(compositionContext.reference_mode,'text_only');assert.equal(compositionContext.base_instruction,compositionDescriptionTask.instruction);
  assert.equal(styleContext.reference_mode,'text_only');assert.equal(styleContext.base_instruction,styleDescriptionTask.instruction);
  assert.equal(compositionContext.numbered_instruction,undefined);assert.equal(styleContext.numbered_instruction,undefined);
  assert.equal(compositionContext.reference_scope,compositionDescriptionTask.instruction);assert.equal(styleContext.reference_scope,styleDescriptionTask.instruction);
  assert.deepEqual(context.find((module:any)=>module.reference_type==='viewpoint').tool_state,viewpoint.tool_state);
  assert.ok(!JSON.stringify(context).includes('不应发送'));assert.match(first.text,/not extraction instructions/);assert.match(first.text,/Do not use image_N references/);
  assert.deepEqual(compileRecipe(f.recipe,f.registry).blocks.filter(block=>block.type==='image').map(block=>block.asset_id),['asset_a','asset_b','asset_a']);
});

test('自动推理遇参考图必须用看图模型，即使允许纯文字也不会丢图',()=>{
  const f=fixture();f.prompt.auto_prompt=true;
  const model={...f.model,capabilities:{...f.model.capabilities,max_images:0}};
  assert.throws(()=>prepareModuleInference(f.recipe,f.prompt.module_id,'',model,f.registry,true,undefined,{automatic:true}),/读取参考图片/);
  for(const module of f.recipe.modules)module.asset_ids=[];
  const prepared=prepareModuleInference(f.recipe,f.prompt.module_id,'',model,f.registry,false,undefined,{automatic:true});
  assert.equal(prepared.images_sent,0);assert.equal(prepared.text_only,true);
});

test('构图与风格单独提取仅发送当前模块，文字参考模式也可提取',()=>{
  for(const [type,task] of [['composition',compositionDescriptionTask],['style',styleDescriptionTask]] as const){
    const f=fixture(),module=f.registry.create(type);module.asset_ids=['asset_reference'];module.reference_mode='text_only';f.recipe.modules.push(module);
    const before=structuredClone(f.recipe),p=prepareModuleInference(f.recipe,module.module_id,'',f.model,f.registry);
    assert.equal(p.job.stage,task.action_label);assert.equal(p.images_sent,1);
    assert.deepEqual(p.job.chain_snapshot.blocks.filter(block=>block.type==='image').map(block=>block.asset_id),['asset_reference']);
    const first=p.job.chain_snapshot.blocks[0];assert.equal(first.type,'text');if(first.type==='text'){
      assert.ok(first.text.includes(task.instruction));const context=JSON.parse(first.text.split('以下 JSON 是待处理内容：\n')[1]);assert.equal(context.length,1);assert.equal(context[0].role,'target');
    }
    assert.deepEqual(f.recipe,before);
    module.asset_ids=[];assert.throws(()=>prepareModuleInference(f.recipe,module.module_id,'已有文字',f.model,f.registry),/添加参考图片/);
  }
});

test('自动推理结果只回写目标文字和开始时的key，上游变化仍需更新且手改结果不需重推理',()=>{
  const f=fixture();f.prompt.auto_prompt=true;
  const state=getAutoPromptState(f.recipe,f.registry,defaultModuleSettings)!;
  f.subject.user_instruction='换成新要求';const before=structuredClone(f.recipe);
  const next=applyAutomaticPromptSuggestion(f.recipe,f.prompt.module_id,f.prompt.user_instruction,state.input_key,'完整场景描述');
  assert.deepEqual(f.recipe,before);assert.deepEqual(next.modules.slice(0,-1),before.modules.slice(0,-1));
  const target=next.modules.find(module=>module.module_id===f.prompt.module_id)!;
  assert.equal(target.user_instruction,'完整场景描述');assert.equal(target.auto_prompt_input_key,state.input_key);
  assert.equal(getAutoPromptState(next,f.registry,defaultModuleSettings)!.needs_inference,true);
  const current=getAutoPromptState(f.recipe,f.registry,defaultModuleSettings)!;
  const adopted=applyAutomaticPromptSuggestion(f.recipe,f.prompt.module_id,f.prompt.user_instruction,current.input_key,'用户可改的结果');
  adopted.modules.find(module=>module.module_id===f.prompt.module_id)!.user_instruction='用户调整过结果';
  assert.equal(getAutoPromptState(adopted,f.registry,defaultModuleSettings)!.needs_inference,false);
});

test('自动推理结束时，手改正文、关闭、禁用或删除目标均拒绝覆盖',()=>{
  for(const change of ['edit','off','disable','delete'] as const){
    const f=fixture();f.prompt.auto_prompt=true;f.prompt.auto_prompt_input_key='auto-v1:old';
    const expectedText=f.prompt.user_instruction;
    if(change==='edit')f.prompt.user_instruction='用户新文字';
    if(change==='off')f.prompt.auto_prompt=false;
    if(change==='disable')f.prompt.enabled=false;
    if(change==='delete')f.recipe.modules=f.recipe.modules.filter(module=>module.module_id!==f.prompt.module_id);
    const before=structuredClone(f.recipe);
    assert.throws(()=>applyAutomaticPromptSuggestion(f.recipe,f.prompt.module_id,expectedText,'auto-v1:new','迟到结果'),/未修改|未覆盖/);
    assert.deepEqual(f.recipe,before);
  }
});

test('自动推理执行只返回文字建议，执行器失败或取消保留原文且不自动重试',async()=>{
  const f=fixture();f.prompt.auto_prompt=true;f.prompt.auto_prompt_input_key='auto-v1:old';const before=structuredClone(f.recipe);
  const p=prepareModuleInference(f.recipe,f.prompt.module_id,'',f.model,f.registry,false,undefined,{automatic:true});
  const context={model:f.model,job:p.job,readImage:async()=>Buffer.alloc(0),resolveCredential:async()=>''};let calls=0;
  const suggestion=await executeModuleInference({execute:async()=>{calls++;return {images:[],text:'在产品上印上 image_1 文字。'};}},context,p,new AbortController().signal);
  assert.equal(suggestion.text,'在产品上印上 image_1 文字。');assert.equal(calls,1);assert.deepEqual(f.recipe,before);
  const controller=new AbortController();
  await assert.rejects(executeModuleInference({execute:async()=>{controller.abort();return {images:[],text:'迟到结果'};}},context,p,controller.signal),/取消/);
  await assert.rejects(executeModuleInference({execute:async()=>{calls++;throw Error('network');}},context,p,new AbortController().signal),/network/);
  assert.equal(calls,2);assert.deepEqual(f.recipe,before);
});

test('提示词的通用与陈列师角色同时用于自动和手动推理，不进入生图链',()=>{
  for(const role of promptRoles)for(const automatic of [false,true]){
    const f=fixture();f.prompt.auto_prompt=true;f.prompt.prompt_role=role.id;
    const before=structuredClone(f.recipe);
    const prepared=prepareModuleInference(f.recipe,f.prompt.module_id,'商品居中，右侧留白',f.model,f.registry,false,undefined,{automatic});
    const first=prepared.job.chain_snapshot.blocks[0];assert.equal(first.type,'text');if(first.type!=='text')return;
    assert.ok(first.text.includes(role.instruction));
    for(const other of promptRoles.filter(candidate=>candidate.id!==role.id))assert.ok(!first.text.includes(other.instruction));
    assert.equal(prepared.job.recipe_snapshot.modules.find(module=>module.module_id===f.prompt.module_id)!.prompt_role,role.id);
    assert.deepEqual(f.recipe,before);
    assert.ok(!compileRecipe(f.recipe,f.registry).blocks.some(block=>block.type==='text'&&block.text.includes(role.instruction)));
  }
});

test('手动推理采用未保存的角色草稿且仅返回建议，旧工程默认通用',async()=>{
  const f=fixture();delete f.prompt.prompt_role;
  const before=structuredClone(f.recipe),general=promptRoles.find(role=>role.id==='general')!,merchandiser=promptRoles.find(role=>role.id==='merchandiser')!;
  const legacy=prepareModuleInference(f.recipe,f.prompt.module_id,'已有草稿',f.model,f.registry);
  const first=legacy.job.chain_snapshot.blocks[0];assert.equal(first.type,'text');if(first.type==='text')assert.ok(first.text.includes(general.instruction));
  const prepared=prepareModuleInference(f.recipe,f.prompt.module_id,'商品居中，右侧留白',f.model,f.registry,false,undefined,{promptRole:'merchandiser'});
  const blocks=prepared.job.chain_snapshot.blocks;
  assert.ok(blocks.some(block=>block.type==='text'&&block.text.includes(merchandiser.instruction)));
  assert.equal(prepared.job.recipe_snapshot.modules.find(module=>module.module_id===f.prompt.module_id)!.prompt_role,'merchandiser');
  const suggestion=await executeModuleInference({execute:async()=>({images:[],text:'商品居中，左侧用低矮台座衬托，右侧留白。'})},
    {model:f.model,job:prepared.job,readImage:async()=>Buffer.alloc(0),resolveCredential:async()=>''},prepared,new AbortController().signal);
  assert.equal(suggestion.original_text,'商品居中，右侧留白');assert.deepEqual(f.recipe,before);
});

test('角色只接受内置值，非提示词任务不注入角色且自动任务不接受未保存角色',()=>{
  const f=fixture();
  const command={type:'module:infer',request_id:'request_role',project_id:'project_test',module_id:f.prompt.module_id,model_config_id:f.model.model_config_id,text:'草稿',allow_text_only:false,prompt_role:'merchandiser'};
  const parsed=commandSchema.parse(command);assert.equal(parsed.type==='module:infer'&&parsed.prompt_role,'merchandiser');
  assert.throws(()=>commandSchema.parse({...command,prompt_role:'custom-role'}));
  for(const module of [f.subject,f.neutral]){
    module.prompt_role='merchandiser';
    const prepared=prepareModuleInference(f.recipe,module.module_id,'草稿',f.model,f.registry);
    for(const role of promptRoles)assert.ok(!prepared.job.chain_snapshot.blocks.some(block=>block.type==='text'&&block.text.includes(role.instruction)));
    assert.throws(()=>prepareModuleInference(f.recipe,module.module_id,'草稿',f.model,f.registry,false,undefined,{promptRole:'merchandiser'}),/只有提示词模块/);
  }
  f.prompt.auto_prompt=true;
  assert.throws(()=>prepareModuleInference(f.recipe,f.prompt.module_id,'草稿',f.model,f.registry,false,undefined,{automatic:true,promptRole:'merchandiser'}),/已保存的角色/);
});

test('陈列师手动优化也收到仅描述参考的提取范围和生图路由',()=>{
  const f=fixture(),style=f.registry.create('style'),composition=f.registry.create('composition');
  style.asset_ids=['asset_style'];style.reference_mode='text_only';
  composition.asset_ids=['asset_composition'];composition.reference_mode='image_text';
  f.recipe.modules.push(style,composition);
  const prepared=prepareModuleInference(f.recipe,f.prompt.module_id,'商品居中，右侧留白',f.model,f.registry,false,undefined,{promptRole:'merchandiser'});
  const first=prepared.job.chain_snapshot.blocks[0];assert.equal(first.type,'text');if(first.type!=='text')return;
  const context=JSON.parse(first.text.split('以下 JSON 是待处理内容：\n')[1]);
  const styleContext=context.find((module:any)=>module.reference_type==='style'),compositionContext=context.find((module:any)=>module.reference_type==='composition');
  assert.equal(styleContext.reference_mode,'text_only');assert.equal(styleContext.reference_scope,styleDescriptionTask.instruction);
  assert.equal(styleContext.base_instruction,styleDescriptionTask.instruction);assert.equal(styleContext.numbered_instruction,undefined);
  assert.equal(compositionContext.reference_mode,'image_text');assert.equal(compositionContext.reference_scope,compositionDescriptionTask.instruction);
  assert.match(first.text,/text_only references will not reach the image generator/);
  assert.ok(prepared.job.chain_snapshot.blocks.some(block=>block.type==='image'&&block.asset_id==='asset_style'));
  assert.ok(!compileRecipe(f.recipe,f.registry).blocks.some(block=>block.type==='image'&&block.asset_id==='asset_style'));
});

test('仅描述上下文的手动提示词避免推理图片编号，保留画面文字且不改变其它任务规则',async()=>{
  const f=fixture(),style=f.registry.create('style');style.asset_ids=['asset_style'];style.reference_mode='text_only';f.recipe.modules.push(style);
  const draft='产品上显示 image_1 字样，不要添加其它文字。';
  const prepare=(moduleId:string)=>prepareModuleInference(f.recipe,moduleId,draft,f.model,f.registry);
  const instructions=(prepared:ReturnType<typeof prepare>)=>{const block=prepared.job.chain_snapshot.blocks[0];assert.equal(block.type,'text');return block.type==='text'?block.text.split('以下 JSON 是待处理内容：\n')[0]:'';};
  const prepared=prepare(f.prompt.module_id),text=instructions(prepared);
  assert.match(text,/不用推理输入的 image_N 标签作图片指代/);assert.match(text,/用户要求画面显示的 image_N 字样仍应保留/);
  assert.ok(!text.includes('手写 subject/image_N 引用'));
  const result=await executeModuleInference({execute:async()=>({images:[],text:draft})},{model:f.model,job:prepared.job,readImage:async()=>Buffer.alloc(0),resolveCredential:async()=>''},prepared,new AbortController().signal);
  assert.equal(result.text,draft);
  assert.match(instructions(prepare(f.neutral.module_id)),/手写 subject\/image_N 引用/);
  style.reference_mode='image_text';assert.match(instructions(prepare(f.prompt.module_id)),/手写 subject\/image_N 引用/);
  style.reference_mode='text_only';style.enabled=false;assert.match(instructions(prepare(f.prompt.module_id)),/手写 subject\/image_N 引用/);
});
