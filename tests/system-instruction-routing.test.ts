import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionRegistry } from '../src/adapters/execution-registry.js';
import type { CloudExecutionContext } from '../src/core/ports.js';
import type { AdapterDescription } from '../src/core/model-library.js';
import { seedModels } from '../src/core/models.js';
import { contractFor, validateGenerationParameters } from '../src/core/generation-parameters.js';
import { chatProfile } from '../src/protocols/chat-profile.js';
import sharp from 'sharp';
import { ChatCompletionsAdapter } from '../src/adapters/chat-completions.js';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { compileRecipe } from '../src/core/compiler.js';
import { prepareModuleInference, executeModuleInference } from '../src/core/module-inference.js';
import type { Recipe } from '../src/core/domain.js';
import { MAX_SYSTEM_INSTRUCTION_CHARS } from '../src/core/domain.js';
import { buildModuleInferenceReferenceRules } from '../src/core/module-inference-instructions.js';
import { buildPromptSystemInstruction } from '../src/core/module-inference-tasks.js';

function context():CloudExecutionContext{
  const model={...seedModels()[2],adapter_id:'test-understanding',purpose:'understanding' as const};
  const recipe={recipe_id:'recipe_system',schema_version:1 as const,modules:[],model_config_id:model.model_config_id,core_parameters:model.defaults};
  return {model,job:{task_id:'task_system',status:'running',stage:'test',progress:0,created_at:'2026-10-27',recipe_snapshot:recipe,
    chain_snapshot:{blocks:[],mode:'text_to_image'},adapted_input:{kind:'separated_inputs',prompt:'本次用户要求',system_instruction:'  已冻结的角色原文\n',adjustments:[]},
    model_snapshot:{model_config_id:model.model_config_id,title:model.title,model:model.model,provider:model.provider,adapter_id:model.adapter_id,kind:model.kind,revision:model.revision},output_asset_ids:[]},
    readImage:async()=>{throw Error('Unexpected image read');},resolveCredential:async()=>{throw Error('Unexpected credential read');}};
}
function description():AdapterDescription{return {adapter_id:'test-understanding',version:1,title:'test',kind:'cloud',installed:true,purposes:['understanding'],requires_credential:false,supports_probe:false,interleaving:['native','separated'],operations:['understand'],parameters:[]};}

test('未声明系统指令能力的适配器在执行前拒绝，不合并到 user',()=>{
  const c=context(),before=structuredClone(c.job);let calls=0;
  const registry=new ExecutionRegistry().register({description:description(),execute:async()=>{calls++;return {images:[],text:'unexpected'};}});
  assert.throws(()=>registry.execute(c,new AbortController().signal,async()=>{}),/未声明系统指令支持/);
  assert.equal(calls,0);assert.deepEqual(c.job,before);
});

test('系统文字原样进入声明支持的推理适配器；旧请求缺字段仍可执行',async()=>{
  const c=context(),seen:CloudExecutionContext[]=[];
  const registry=new ExecutionRegistry().register({description:{...description(),supports_system_instruction:true},execute:async input=>{seen.push(input);return {images:[],text:'done'};}});
  await registry.execute(c,new AbortController().signal,async()=>{});
  assert.equal(seen[0],c);assert.equal(seen[0].job.adapted_input.system_instruction,'  已冻结的角色原文\n');
  const legacy=context();delete legacy.job.adapted_input.system_instruction;
  const oldRegistry=new ExecutionRegistry().register({description:description(),execute:async input=>{assert.equal(input.job.adapted_input.system_instruction,undefined);return {images:[],text:'legacy'};}});
  assert.equal((await oldRegistry.execute(legacy,new AbortController().signal,async()=>{})).text,'legacy');
});

test('生图与无效系统文字在执行前拒绝，不能被适配器忽略',()=>{
  let calls=0;const registry=new ExecutionRegistry().register({description:{...description(),supports_system_instruction:true},execute:async()=>{calls++;return {images:[]};}});
  const generation=context();generation.model.purpose='generation';
  assert.throws(()=>registry.execute(generation,new AbortController().signal,async()=>{}),/不能发送到生图链路/);
  for(const invalid of ['x'.repeat(MAX_SYSTEM_INSTRUCTION_CHARS+1),{role:'bad'}]){
    const c=context();c.job.adapted_input.system_instruction=invalid as string;
    assert.throws(()=>registry.execute(c,new AbortController().signal,async()=>{}),new RegExp(`${MAX_SYSTEM_INSTRUCTION_CHARS} 字符`));
  }
  assert.equal(calls,0);
});

test('旧 Chat 契约补充可选消息角色，不覆盖原参数或渠道限制',()=>{
  const model=context().model;model.adapter_id='openai-chat-completions';model.generation_contract=structuredClone(chatProfile);
  model.generation_contract.fields=model.generation_contract.fields.filter(field=>field.key!=='instruction_role');
  model.generation_contract.fields.find(field=>field.key==='temperature')!.maximum=1;
  model.defaults={version:2,aspect_ratio:'auto',quality:'standard',output_format:'png',count:1,resolution:{mode:'default'},extensions:{'openai-chat-completions':{instruction_role:'developer'}}};
  const before=structuredClone(model),contract=contractFor(model);
  assert.deepEqual(contract.fields.find(field=>field.key==='instruction_role')!.values,['system','developer']);
  assert.equal(contract.fields.find(field=>field.key==='temperature')!.maximum,1);
  assert.doesNotThrow(()=>validateGenerationParameters(model.defaults,model));
  assert.deepEqual(model,before);
  model.capabilities.parameter_limits={instruction_role:{values:['system']}};
  assert.deepEqual(contractFor(model).fields.find(field=>field.key==='instruction_role')!.values,['system']);
  assert.throws(()=>validateGenerationParameters(model.defaults,model),/不支持该选项/);
  model.capabilities.parameter_limits={instruction_role:{enabled:false}};
  assert.equal(contractFor(model).fields.some(field=>field.key==='instruction_role'),false);
});

test('两角色经实际推理准备与双协议执行共用冻结 system，自动不含旧正文，手动正文只在 user',async()=>{
  const png=await sharp({create:{width:8,height:8,channels:3,background:'#fff'}}).png().toBuffer();
  const systems=new Map<string,string>();
  for(const protocol of ['chat','gemini'])for(const role of ['general','merchandiser'] as const)for(const automatic of [false,true]){
    const roleText=`  自定义${role}：遵守用户要求，只完善场景。\n`;
    const registry=new ModuleRegistry(undefined,undefined,{[role]:roleText});
    const subject=registry.create('subject'),prompt=registry.create('prompt');
    subject.module_id='mod_subject_flow';prompt.module_id='mod_prompt_flow';
    subject.asset_ids=['asset_subject'];subject.user_instruction='主体保持白色';
    prompt.prompt_role=role;prompt.auto_prompt=true;prompt.user_instruction='原有场景正文';
    let sent:any,calls=0;const read:string[]=[];
    const request:typeof fetch=async(_url,init)=>{
      calls++;sent=JSON.parse(init!.body as string);
      return protocol==='chat'
        ?Response.json({choices:[{finish_reason:'stop',message:{content:'保持白色商品，柔和侧光。'}}]})
        :Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'保持白色商品，柔和侧光。'}]}}]});
    };
    const adapter=protocol==='chat'?new ChatCompletionsAdapter(request):new GeminiGenerator(request);
    const model={...context().model,enabled:true,executable:true,adapter_id:adapter.description.adapter_id,generation_contract:adapter.description.generation_contract,
      capabilities:{...context().model.capabilities,operations:['understand']},defaults:{version:2 as const,aspect_ratio:'auto',quality:'standard',output_format:'png' as const,count:1,resolution:{mode:'default' as const}},endpoint:'https://unit.test'};
    const recipe:Recipe={recipe_id:'recipe_role_flow',schema_version:1,modules:[subject,prompt],model_config_id:model.model_config_id,core_parameters:model.defaults,input_strategy:automatic?'numbered_flat':'interleaved'};
    const before=structuredClone(recipe);
    const prepared=prepareModuleInference(recipe,prompt.module_id,prompt.user_instruction,model,registry,false,undefined,{automatic});
    registry.roleInstructions[role]='之后修改的角色不得进入已准备的请求';
    const suggestion=await executeModuleInference(new ExecutionRegistry().register(adapter),{model,job:prepared.job,readImage:async id=>{read.push(id);return png;},resolveCredential:async()=>'test-only'},prepared,new AbortController().signal);
    const user=protocol==='chat'?sent.messages.find((message:any)=>message.role==='user'):sent.contents[0];
    const system=protocol==='chat'?sent.messages[0].content:sent.systemInstruction.parts[0].text;
    assert.equal(system,buildPromptSystemInstruction(roleText,buildModuleInferenceReferenceRules([subject],type=>registry.inferenceInstruction(type))));assert.ok(!JSON.stringify(user).includes('自定义'+role));
    const key=protocol+role;
    if(systems.has(key))assert.equal(system,systems.get(key),'automatic/manual share the same system, regardless of input strategy');
    else systems.set(key,system);
    assert.equal(JSON.stringify(user).includes('原有场景正文'),!automatic);
    assert.ok(!system.includes('原有场景正文'));assert.ok(!JSON.stringify(user).includes('Write the final image-generation prompt'));
    assert.ok(JSON.stringify(user).includes('主体保持白色'));
    assert.equal(protocol==='chat'?user.content.filter((part:any)=>part.type==='image_url').length:user.parts.filter((part:any)=>part.inlineData).length,1);
    assert.deepEqual(read,['asset_subject']);assert.equal(calls,1);
    assert.equal(suggestion.text,'保持白色商品，柔和侧光。');assert.deepEqual(recipe,before);
    const generation=compileRecipe(recipe,registry);
    assert.equal(generation.system_instruction,undefined);assert.ok(!JSON.stringify(generation.blocks).includes('自定义'+role));
  }
});
