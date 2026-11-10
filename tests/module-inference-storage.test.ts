import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {DocumentRepository} from '../src/adapters/document-repository.js';
import {MockGenerator} from '../src/adapters/mock-generator.js';
import {loadPromptSettings,savePromptSettings,promptSettingsFilename} from '../src/adapters/prompt-config-repository.js';
import {Workspace} from '../src/core/workspace.js';
import {ModelLibrary,seedModels} from '../src/core/models.js';
import {ModuleRegistry} from '../src/core/modules.js';
import {createPromptSettings} from '../src/core/prompt-settings.js';
import {prepareModuleInference,applyAutomaticPromptSuggestion} from '../src/core/module-inference.js';
import {getAutoPromptState} from '../src/core/auto-prompt.js';
import {defaultModuleSettings} from '../src/core/module-settings.js';

test('四模块推理规则和预设仅保存在程序设置；实际生图、历史请求及 ediro 容器不携带推理配置',async()=>{
  const root=path.join(process.cwd(),'.local','test-inference-storage');
  await mkdir(root,{recursive:true});
  const base=await mkdtemp(path.join(root,'case-')),runtime=path.join(base,'runtime');
  const types=['subject','composition','style','viewpoint'] as const;
  const settings=createPromptSettings();
  settings.inference_instructions=Object.fromEntries(types.map(type=>[type,`PRIVATE_INFERENCE_RULE_${type.toUpperCase()}_SENTINEL`]));
  settings.presets=types.map(module=>({id:`private_inference_${module}`,name:`PRIVATE_PRESET_NAME_${module}`,kind:'inference' as const,module,instruction:settings.inference_instructions![module]}));
  settings.selected_presets=Object.fromEntries(types.map(type=>[`inference:${type}`,`private_inference_${type}`]));
  const saved=await savePromptSettings(runtime,settings);
  const registry=new ModuleRegistry(undefined,saved.config,saved.customizations.roles,saved.settings.inference_instructions);
  const repo=await DocumentRepository.prepare(path.join(base,'generation-only.ediro'),path.join(base,'cache'));
  const workspace=new Workspace(new ModelLibrary(seedModels(),async()=>{},{has:async()=>false,set:async()=>{}}),new MockGenerator(1),registry);
  try{
    await workspace.create(repo,'推理配置隔离测试');
    const source=path.join(base,'source.png');
    await writeFile(source,await sharp({create:{width:24,height:20,channels:3,background:'#779988'}}).png().toBuffer());
    const subject=workspace.project!.recipe.modules[0];
    await workspace.importFiles([source],subject.module_id);
    await workspace.addModule('viewpoint');
    const recipe=structuredClone(workspace.project!.recipe),assetId=recipe.modules[0].asset_ids[0];
    for(const module of recipe.modules){
      if(module.reference_type!=='prompt')module.asset_ids=[assetId];
      if(module.reference_type==='style')module.reference_mode='text_only';
    }
    const prompt=recipe.modules.find(module=>module.reference_type==='prompt')!;
    prompt.auto_prompt=true;
    await workspace.saveRecipe(recipe);
    const model={...seedModels()[2],purpose:'understanding' as const,executable:true,capabilities:{...seedModels()[2].capabilities,operations:['understand']}};
    const prepared=prepareModuleInference(recipe,prompt.module_id,'',model,registry,false,defaultModuleSettings,{automatic:true});
    for(const value of Object.values(settings.inference_instructions!))assert.ok(JSON.stringify(prepared.job.adapted_input).includes(value));
    assert.equal(workspace.project!.jobs.length,0,'临时推理计划不进入工程历史');
    const finalText='采用的生图正文：保留商品，使用清晰的图文分区。';
    workspace.project!.recipe=applyAutomaticPromptSuggestion(workspace.project!.recipe,prompt.module_id,'',getAutoPromptState(recipe,registry,defaultModuleSettings)!.input_key,finalText);
    await workspace.persist();
    await workspace.serial(()=>workspace.enqueue(false));
    for(let attempt=0;attempt<500;attempt++){
      if(await workspace.serial(async()=>workspace.project!.jobs.every(job=>['succeeded','failed','cancelled'].includes(job.status))))break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(workspace.project!.jobs[0].status,'succeeded',workspace.project!.jobs[0].error);
    const project=await repo.load(),serialized=JSON.stringify(project);
    assert.ok(serialized.includes(finalText));
    for(const marker of ['PRIVATE_INFERENCE_RULE_','PRIVATE_PRESET_NAME_','private_inference_','inference_instructions','inference:'])assert.ok(!serialized.includes(marker),marker);
    const request=await repo.loadModelInput(project.jobs[0].task_id);
    assert.ok(request,'真实生图 mock 请求已记录');
    assert.ok(!JSON.stringify(request).includes('PRIVATE_INFERENCE_RULE_'));
    const database=new DatabaseSync(repo.filename,{readOnly:true});
    try{
      const entries=database.prepare('SELECT name FROM entries').all();
      assert.ok(!JSON.stringify(entries).includes('inference'));
      for(const row of database.prepare('SELECT bytes FROM blobs').all()){
        const bytes=Buffer.from(row.bytes as Uint8Array);
        assert.ok(!bytes.includes(Buffer.from('PRIVATE_INFERENCE_RULE_')));
        assert.ok(!bytes.includes(Buffer.from('PRIVATE_PRESET_NAME_')));
      }
    }finally{database.close();}
    assert.deepEqual((await loadPromptSettings(runtime)).settings,settings);
    assert.ok((await readFile(path.join(runtime,promptSettingsFilename),'utf8')).includes('PRIVATE_INFERENCE_RULE_'));
  }finally{await workspace.flush();await repo.close();}
});
