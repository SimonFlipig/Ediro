import test from 'node:test';
import assert from 'node:assert/strict';
import {Workspace} from '../src/core/workspace.js';
import {ModuleRegistry} from '../src/core/modules.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {releasePromptConfig} from '../src/core/release-prompt-config.js';
import type {CurrentPromptConfig} from '../src/core/prompt-config.js';
import type {Job,Project} from '../src/core/domain.js';
import type {ProjectStorePort} from '../src/core/ports.js';
import {synchronizeInputPreview} from '../src/ui/input-preview.js';
import {planExecution} from '../src/core/execution-plan.js';

async function fixture(config:CurrentPromptConfig){
  let saved:Project|undefined;
  const observed:Job[]=[],registry=new ModuleRegistry(undefined,config);
  const library=new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}});
  const repository={directory:'.',transient:true,
    create:async(project:Project)=>{saved=structuredClone(project);},
    save:async(project:Project)=>{saved=structuredClone(project);},
    readAsset:async()=>Buffer.from('in-memory-reference'),
  } as ProjectStorePort;
  const workspace=new Workspace(library,{execute:async({job})=>{observed.push(structuredClone(job));throw new Error('local-test-executor-reached');}},registry);
  await workspace.create(repository,'提示词一致性');
  const preview=async()=>synchronizeInputPreview({project:structuredClone(workspace.project!),chain:null,adaptation:null,
    models:await library.list(),module_definitions:registry.list(),prompt_config:config,assets:[],project_location:null});
  return {workspace,registry,observed,preview,saved:()=>saved!};
}

async function settle(workspace:Workspace){
  for(let attempt=0;attempt<100;attempt++){
    if(await workspace.serial(async()=>workspace.project!.jobs.every(job=>job.status==='failed')))return;
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  throw new Error('本地执行器等待超时');
}

for(const scenario of ['create','add','change-type'] as const){
  test(`显式空编号指令在 ${scenario} 后经界面预览和普通编辑仍可保存`,async()=>{
    const config=structuredClone(releasePromptConfig);
    config.modules.subject.numbered_instruction='';config.modules.style.numbered_instruction='';
    const f=await fixture(config),w=f.workspace;
    try{
      let module=w.project!.recipe.modules.find(m=>m.reference_type==='subject')!;
      if(scenario==='add'){await w.addModule('subject');module=w.project!.recipe.modules.at(-1)!;}
      if(scenario==='change-type'){await w.changeReferenceType(module.module_id,'style');module=w.project!.recipe.modules.find(m=>m.module_id===module.module_id)!;}
      assert.equal(module.numbered_instruction,'');
      const view=await f.preview(),recipe=view.project!.recipe;
      assert.equal(recipe.modules.find(m=>m.module_id===module.module_id)!.numbered_instruction,'');
      recipe.modules.find(m=>m.reference_type==='prompt')!.user_instruction='普通正文编辑';
      await w.saveRecipe(recipe);
      assert.equal(f.saved().recipe.modules.find(m=>m.module_id===module.module_id)!.numbered_instruction,'');
      assert.equal(f.saved().recipe.modules.find(m=>m.reference_type==='prompt')!.user_instruction,'普通正文编辑');
      const tampered=structuredClone(w.project!.recipe);
      tampered.modules.find(m=>m.module_id===module.module_id)!.numbered_instruction='界面擅自改写核心规则';
      await assert.rejects(()=>w.saveRecipe(tampered),/基础语义不可由界面修改/);
      assert.equal(w.project!.recipe.modules.find(m=>m.module_id===module.module_id)!.numbered_instruction,'');
    }finally{await w.shutdown();}
  });
}

test('编号指令缺省仍沿用定义，显式空值与无编号定义保持区别',()=>{
  const config=structuredClone(releasePromptConfig);delete config.modules.subject.numbered_instruction;
  const defaults=new ModuleRegistry(undefined,config),inherited=defaults.create('subject');
  assert.ok(inherited.numbered_instruction?.trim());assert.equal(inherited.numbered_instruction,defaults.get('subject').numbered_instruction);
  assert.equal(Object.hasOwn(defaults.create('image_text'),'numbered_instruction'),false);
  config.modules.subject.numbered_instruction='';
  const empty=new ModuleRegistry(undefined,config).create('subject');
  assert.equal(Object.hasOwn(empty,'numbered_instruction'),true);assert.equal(empty.numbered_instruction,'');
});

const expressions=[
  {name:'仅编号规则',native:'',numbered:'Preserve structure of {images}.',user:'',nativeValid:false,flatValid:true,label:''},
  {name:'仅原生规则',native:'保留参考商品结构。',numbered:'',user:'',nativeValid:true,flatValid:false,label:''},
  {name:'只有标题图片标签和空白',native:' \n',numbered:' \n',user:'',nativeValid:false,flatValid:false,label:'图像占位 {image}'},
  {name:'只有正文',native:'',numbered:'',user:'保留包装上的 A&B 标识。',nativeValid:true,flatValid:true,label:''},
] as const;

for(const expression of expressions)for(const strategy of ['interleaved','numbered_flat'] as const){
  test(`${strategy} 入队按有效表达校验：${expression.name}`,async()=>{
    const config=structuredClone(releasePromptConfig);
    config.modules.subject.native_instruction=expression.native;config.modules.subject.numbered_instruction=expression.numbered;config.image_label=expression.label;
    const f=await fixture(config),w=f.workspace;
    try{
      const recipe=structuredClone(w.project!.recipe),subject=recipe.modules.find(m=>m.reference_type==='subject')!,prompt=recipe.modules.find(m=>m.reference_type==='prompt')!;
      w.project!.assets.push({asset_id:'asset_reference',name:'内存参考图',location:{type:'managed',relative_path:'input/reference.png'},thumbnail_path:'thumb.webp',width:100,height:100,mime_type:'image/png',created_at:'2026-10-27T00:00:00Z',kind:'import'});
      subject.asset_ids=['asset_reference'];prompt.user_instruction=expression.user;
      recipe.modules=[subject,prompt];recipe.input_strategy=strategy;recipe.core_parameters.aspect_ratio='1:1';
      await w.saveRecipe(recipe);
      const plan=planExecution(recipe,w.project!.assets,w.models.resolve(recipe.model_config_id),f.registry);
      const sent=plan.adapted.kind==='native_blocks'?plan.adapted.blocks!.filter(b=>b.type==='text').map(b=>b.text).join(''):plan.adapted.prompt!;
      assert.ok(sent.trim(),'structural Markdown/XML is present even when meaningful text is empty');
      const valid=strategy==='interleaved'?expression.nativeValid:expression.flatValid;
      if(!valid){
        await assert.rejects(()=>w.enqueue(false),/请填写生成提示词/);
        assert.equal(w.project!.jobs.length,0);assert.equal(f.observed.length,0);
      }else{
        await w.serial(()=>w.enqueue(false));await settle(w);
        assert.equal(f.observed.length,1);assert.equal(w.project!.jobs.length,1);
        assert.match(w.project!.jobs[0].error!,/local-test-executor-reached/);
        assert.deepEqual(f.observed[0].adapted_input,plan.adapted);
        if(expression.name==='仅编号规则')assert.match(sent,/<reference_rules>Preserve structure of image_1\.<\/reference_rules>/);
      }
    }finally{await w.shutdown();}
  });
}
