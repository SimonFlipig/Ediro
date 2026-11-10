import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {ProjectRepository,outputRecordSchema,projectFilename} from '../src/adapters/project-repository.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {ModuleRegistry} from '../src/core/modules.js';
import {Workspace} from '../src/core/workspace.js';
import type {AdaptedInput,Block,CompiledChain,Job} from '../src/core/domain.js';
import {defaultPromptConfig} from '../src/core/prompt-config.js';

const instruction='  保持 <产品> 的结构 & 标识。\n';
const requirement='  画面显示 "A & B <新品>"。\n保留原始换行。  ';

async function settle(workspace:Workspace){
  for(let attempt=0;attempt<200;attempt++){
    if(await workspace.serial(async()=>workspace.project!.jobs.every(job=>job.status==='failed')))return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('快照模拟任务等待超时');
}

// These are saved request fixtures, deliberately independent of today's compiler.
function snapshots(version:2|3|4|undefined,kind:AdaptedInput['kind'],subject:{module_id:string;reference_id:string},prompt:{module_id:string;reference_id:string},assetIds:string[]):{chain:CompiledChain;adapted:AdaptedInput}{
  const subjectMeta={source_module_id:subject.module_id,reference_type:'subject',reference_id:subject.reference_id,model_name:'产品 & 标识'};
  const promptMeta={source_module_id:prompt.module_id,reference_type:'prompt',reference_id:prompt.reference_id,model_name:'prompt'};
  const images:Block[]=assetIds.map((asset_id,index)=>({type:'image',asset_id,image_name:`image_${index+1}`,...subjectMeta}));
  const semantic=version===3||version===4;
  const semanticBlocks:Block[]=[{type:'text',text:semantic?instruction:`subject:\n${instruction}`,numbered_text:'冻结编号规则 image_1, image_2。',text_role:'instruction',...subjectMeta},...images,{type:'text',text:requirement,text_role:'user',...promptMeta}];
  const chain:CompiledChain={...(version===undefined?{}:{format_version:version}),blocks:semanticBlocks,mode:'reference_generation',...(version===2?{prompt_config:{version:1,revision:'frozen-old-layout',module_header:'{module}:',image_label:'{image}',image_separator:', ',text_separator:'\n\n',modules:{}}}:semantic?{prompt_config:structuredClone(defaultPromptConfig)}:{})};
  const xmlInstruction='<instruction>  保持 &lt;产品&gt; 的结构 &amp; 标识。\n</instruction>';
  const xmlRequirements='<requirements>  画面显示 "A &amp; B &lt;新品&gt;"。\n保留原始换行。  </requirements>';
  const nativeBlocks:Block[]=version===3?[
    {type:'text',text:`<module type="subject">${xmlInstruction}<image ref="image_1">`,text_role:'instruction',...subjectMeta},images[0],
    {type:'text',text:'</image><image ref="image_2">',text_role:'image_label',...subjectMeta},images[1],
    {type:'text',text:'</image></module>',text_role:'image_label',...subjectMeta},
    {type:'text',text:`<module type="prompt">${xmlRequirements}</module>`,text_role:'user',...promptMeta},
  ]:version===4?[
    {type:'text',text:`## 1. 产品 & 标识\n\n${instruction}`,text_role:'instruction',...subjectMeta},...images,
    {type:'text',text:`\n\n## 2. prompt\n\n${requirement}`,text_role:'user',...promptMeta},
  ]:structuredClone(semanticBlocks);
  const flat=semantic?`<module type="subject">${xmlInstruction}<image ref="image_1"/><image ref="image_2"/></module>\n<module type="prompt">${xmlRequirements}</module>`:`subject:\n冻结编号规则 image_1, image_2。\n\n${requirement}`;
  const adapted:AdaptedInput=kind==='native_blocks'?{kind,blocks:nativeBlocks,adjustments:[]}:{kind,prompt:flat,image_asset_ids:[...assetIds],adjustments:[]};
  return {chain,adapted};
}

for(const version of [4,3,2,undefined] as const)for(const kind of ['native_blocks','separated_inputs'] as const){
  test(`格式 ${version??'缺省'} 的 ${kind} 历史保存、加载与重试保留冻结输入`,{timeout:15_000},async()=>{
    const base=path.resolve('.local/test-projects');await mkdir(base,{recursive:true});
    const repository=new ProjectRepository(await mkdtemp(path.join(base,'snapshot-')));
    const library=new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}});
    const observed:Job[]=[];
    const workspace=new Workspace(library,{execute:async({job})=>{observed.push(structuredClone(job));throw new Error('snapshot-fixture-stop');}});
    await workspace.create(repository,'快照兼容');
    try{
      const project=workspace.project!,subject=workspace.registry.create('subject'),prompt=workspace.registry.create('prompt');
      const png=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).png().toBuffer();
      const first=await repository.saveInternalImage(png,'第一张'),second=await repository.saveInternalImage(png,'第二张');
      project.assets.push(first,second);subject.asset_ids=[second.asset_id,first.asset_id];prompt.user_instruction=requirement;
      project.recipe.modules=[subject,prompt];project.recipe.model_config_id='model_mock_native';
      const model=await library.execution(project.recipe.model_config_id);
      const {model_config_id,title,provider,model:actualModel,adapter_id,revision,kind:modelKind}=model;
      const {chain,adapted}=snapshots(version,kind,subject,prompt,subject.asset_ids);
      const history:Job={task_id:'task_frozen_snapshot',status:'failed',stage:'历史失败',progress:10,created_at:'2026-10-27T00:00:00Z',finished_at:'2026-10-27T00:01:00Z',error:'历史错误',recipe_snapshot:structuredClone(project.recipe),chain_snapshot:chain,adapted_input:adapted,model_snapshot:{model_config_id,title,provider,model:actualModel,adapter_id,revision,kind:modelKind},output_asset_ids:[]};
      project.jobs.push(history);await workspace.persist();

      const manifest=JSON.parse(await readFile(path.join(repository.directory,projectFilename),'utf8'));
      const loaded=await repository.load();
      assert.deepEqual(manifest.jobs[0],history);
      assert.deepEqual(loaded.jobs[0],history);
      assert.deepEqual(outputRecordSchema.parse({format:'ediro-output',version:1,output_asset_id:first.asset_id,project:loaded}).project.jobs[0],history);
      assert.equal(Object.hasOwn(loaded.jobs[0].chain_snapshot,'format_version'),version!==undefined);
      assert.equal(Object.hasOwn(loaded.jobs[0].chain_snapshot,'system_instruction'),false);
      assert.equal(Object.hasOwn(loaded.jobs[0].adapted_input,'system_instruction'),false);
      if(version===3||version===4){
        assert.equal(loaded.jobs[0].chain_snapshot.blocks[0].type==='text'&&loaded.jobs[0].chain_snapshot.blocks[0].text,instruction);
        assert.equal(loaded.jobs[0].chain_snapshot.blocks.filter(block=>block.type==='text').at(-1)!.text,requirement);
        const sent=kind==='native_blocks'?loaded.jobs[0].adapted_input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join(''):loaded.jobs[0].adapted_input.prompt!;
        if(version===4&&kind==='native_blocks'){
          assert.match(sent,/^## 1\. 产品 & 标识/);assert.match(sent,/## 2\. prompt/);
          assert.ok(sent.includes(instruction));assert.ok(sent.includes(requirement));
          assert.doesNotMatch(sent,/&amp;|&lt;|<module/);
        }else {
          assert.match(sent,/&lt;产品&gt;/);assert.match(sent,/&amp; B &lt;新品&gt;/);assert.doesNotMatch(sent,/&amp;lt;/);
        }
      }

      // Reopening resolves current editing defaults, but retry must never rebuild the saved request.
      workspace.registry=new ModuleRegistry(undefined,{...structuredClone(defaultPromptConfig),revision:'changed-after-save',modules:{subject:{native_instruction:'新版规则，不应进入历史重试',numbered_instruction:'新版编号 {images}'},prompt:{header:false}}});
      await workspace.open(repository);
      assert.equal(workspace.project!.recipe.modules[0].base_instruction,'新版规则，不应进入历史重试');
      const current=structuredClone(workspace.project!.recipe);current.modules.at(-1)!.user_instruction='重开后编辑的新正文';await workspace.saveRecipe(current);
      await workspace.serial(()=>workspace.retry(workspace.project!.project_id,history.task_id));
      await settle(workspace);
      assert.equal(observed.length,1);
      assert.deepEqual(observed[0].chain_snapshot,history.chain_snapshot);
      assert.deepEqual(observed[0].adapted_input,history.adapted_input);
      assert.deepEqual(observed[0].recipe_snapshot,history.recipe_snapshot);
      assert.deepEqual(workspace.project!.jobs[0],history);
      assert.equal(workspace.project!.recipe.modules.at(-1)!.user_instruction,'重开后编辑的新正文');
      const retried=(await repository.load()).jobs[1];
      assert.equal(retried.status,'failed');assert.match(retried.error!,/snapshot-fixture-stop/);
      assert.deepEqual(retried.chain_snapshot,history.chain_snapshot);assert.deepEqual(retried.adapted_input,history.adapted_input);
    }finally{await workspace.shutdown();}
  });
}

for(const strategy of ['interleaved','numbered_flat'] as const)test(`32000 字符用户原文经 ${strategy} 编译、适配及保存加载不截断，原始块上限不扩大`,{timeout:15_000},async()=>{
  const base=path.resolve('.local/test-projects');await mkdir(base,{recursive:true});
  const repository=new ProjectRepository(await mkdtemp(path.join(base,'snapshot-escape-')));
  const library=new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}});
  let executed:Job|undefined;
  const workspace=new Workspace(library,{execute:async({job})=>{executed=structuredClone(job);throw new Error('snapshot-fixture-stop');}});
  await workspace.create(repository,'图文与 XML 长正文边界');
  try{
    const original='&'.repeat(32000),recipe=structuredClone(workspace.project!.recipe);
    recipe.modules=recipe.modules.filter(module=>module.reference_type==='prompt');recipe.modules[0].user_instruction=original;
    recipe.model_config_id='model_mock_native';recipe.input_strategy=strategy;await workspace.saveRecipe(recipe);
    // enqueue exercises the actual compileRecipe -> adaptChain -> project save path.
    await workspace.enqueue(false);await settle(workspace);
    const loaded=await repository.load(),job=loaded.jobs[0];
    assert.equal(job.chain_snapshot.format_version,4);assert.equal(job.adapted_input.kind,strategy==='interleaved'?'native_blocks':'separated_inputs');
    assert.equal(job.recipe_snapshot.modules[0].user_instruction,original);
    assert.equal(job.chain_snapshot.blocks.filter(block=>block.type==='text').find(block=>block.text_role==='user')?.text,original);
    const requestText=job.adapted_input.kind==='native_blocks'?job.adapted_input.blocks!.filter(block=>block.type==='text').map(block=>block.text).join(''):job.adapted_input.prompt!;
    assert.ok(requestText.includes((strategy==='interleaved'?'&':'&amp;').repeat(32000)));
    if(strategy==='interleaved'){
      assert.match(requestText,/^## 1\. prompt/);assert.doesNotMatch(requestText,/<generation_prompt>|&amp;/);
    }else assert.match(requestText,/<generation_prompt>/);
    assert.deepEqual(job.adapted_input,executed!.adapted_input);
    assert.deepEqual(job.chain_snapshot,executed!.chain_snapshot);

    const oversizedRaw=structuredClone(loaded);
    const rawBlock=oversizedRaw.jobs[0].chain_snapshot.blocks.find(block=>block.type==='text')!;
    rawBlock.text='x'.repeat(64001);await assert.rejects(()=>repository.save(oversizedRaw));
    const oversizedNumbered=structuredClone(loaded);
    const rawNumberedBlock=oversizedNumbered.jobs[0].chain_snapshot.blocks.find(block=>block.type==='text')!;
    rawNumberedBlock.numbered_text='x'.repeat(64001);await assert.rejects(()=>repository.save(oversizedNumbered));
    if(strategy==='interleaved'){
      const oversizedAdapted=structuredClone(loaded);
      const adaptedBlock=oversizedAdapted.jobs[0].adapted_input.blocks!.find(block=>block.type==='text')!;
      adaptedBlock.numbered_text='x'.repeat(64001);await assert.rejects(()=>repository.save(oversizedAdapted));
    }
    assert.deepEqual((await repository.load()).jobs[0],job);
  }finally{await workspace.shutdown();}
});
