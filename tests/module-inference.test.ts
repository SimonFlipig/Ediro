import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {ModuleRegistry} from '../src/core/modules.js';
import {seedModels} from '../src/core/models.js';
import {defaultParameters,type Recipe} from '../src/core/domain.js';
import {prepareModuleInference,executeModuleInference} from '../src/core/module-inference.js';
import {GeminiGenerator} from '../src/adapters/gemini-generator.js';
import {compileRecipe} from '../src/core/compiler.js';
import {commandSchema} from '../src/shared/commands.js';
import {inferenceInputError} from '../src/core/module-inference-tasks.js';
import {modelFromPreset} from '../src/protocols/model-catalog.js';

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
  assert.throws(()=>prepareModuleInference(f.recipe,f.recipe.modules[2].module_id,'text',f.model,f.registry),/尚未配置推理任务/);
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
