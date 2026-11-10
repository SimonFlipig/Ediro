import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {GeminiGenerator} from '../src/adapters/gemini-generator.js';
import {ImagesGenerator} from '../src/adapters/images-generator.js';
import {ProjectRepository} from '../src/adapters/project-repository.js';
import {ModelLibrary} from '../src/core/models.js';
import {Workspace} from '../src/core/workspace.js';
import {modelForEnrollment} from '../src/protocols/model-catalog.js';
import type {Parameters} from '../src/core/domain.js';

for(const fixture of [
  {family:'nano',adapter:new GeminiGenerator().description,variant:'nano-banana-2.1',replacement:'nano-banana-pro',quality:'standard',thinking:'medium'},
  {family:'gpt-image',adapter:new ImagesGenerator().description,variant:'gpt-image-2-5-sunburst',replacement:'gpt-image-2',quality:'max',thinking:undefined},
] as const)test(`${fixture.family} generic variant and independent parameters remain frozen through queue and project reload`,{timeout:15_000},async()=>{
  const id='model_variant_queue',connectionId='connection_variant_queue';
  const original=modelForEnrollment(fixture.family,fixture.adapter.adapter_id,id,connectionId,'private-variant-route');
  original.model_variant_override=fixture.variant;original.defaults.quality=fixture.quality;
  if(fixture.thinking)original.defaults.extensions![original.adapter_id].thinking_level=fixture.thinking;
  const {endpoint,executable,...entry}=original;
  const peer=structuredClone(entry);peer.model_config_id='model_variant_peer';peer.model='private-peer-route';
  const library=new ModelLibrary({schema_version:3,connections:[{connection_id:connectionId,title:'fixture',endpoint:'https://variant.invalid',enabled:true,revision:1,credential_ref:'credential_fixture'}],models:[entry,peer],assignments:{generation_default:id}},async()=>{},{has:async()=>true,set:async()=>{}},[fixture.adapter]);
  const before=library.snapshot();library.resolve(id);await library.list();assert.deepEqual(library.snapshot(),before,'reading variant capabilities never rewrites persisted defaults');
  const root=path.join(process.cwd(),'.local','model-variant-snapshot-tests');await mkdir(root,{recursive:true});
  const repository=new ProjectRepository(await mkdtemp(path.join(root,'case-')));
  let release!:()=>void,started!:()=>void,finished!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;}),completed=new Promise<void>(resolve=>{finished=resolve;});
  let observed:{variant?:string;parameters:Parameters}|undefined;
  const workspace=new Workspace(library,{execute:async({model,job})=>{
    started();await gate;
    observed={variant:model.model_variant_override,parameters:structuredClone(job.recipe_snapshot.core_parameters)};
    throw new Error('variant-fixture-stop');
  }});
  workspace.onChange=async()=>{if(workspace.project?.jobs[0]?.status==='failed')finished();};
  await workspace.create(repository,'Variant snapshot');
  const recipe=structuredClone(workspace.project!.recipe);recipe.modules.at(-1)!.user_instruction='绘制一个白色杯子';await workspace.saveRecipe(recipe);
  await workspace.enqueue(false);await began;
  const queued=structuredClone(workspace.project!.jobs[0]);
  try{
    const saved=library.snapshot().models.find(model=>model.model_config_id===id)!;
    const defaults=structuredClone(saved.defaults);defaults.quality=fixture.family==='nano'?'standard':'auto';
    delete defaults.extensions?.[saved.adapter_id]?.thinking_level;
    await library.saveModel({...saved,model_variant_override:fixture.replacement,defaults});
  }finally{release();}
  await completed;await workspace.flush();
  const loaded=await repository.load(),job=loaded.jobs[0];
  assert.equal(observed?.variant,fixture.variant);
  assert.deepEqual(observed?.parameters,queued.recipe_snapshot.core_parameters);
  assert.equal(job.model_snapshot.model_variant_override,fixture.variant);
  assert.equal(job.model_snapshot.model,'private-variant-route');
  assert.deepEqual(job.recipe_snapshot.core_parameters,queued.recipe_snapshot.core_parameters);
  assert.deepEqual(job.execution_plan,queued.execution_plan);
  assert.equal(job.recipe_snapshot.core_parameters.quality,fixture.quality);
  assert.equal(job.recipe_snapshot.core_parameters.extensions?.[original.adapter_id]?.thinking_level,fixture.thinking);
  assert.equal(library.resolve(id).model_variant_override,fixture.replacement);
  assert.deepEqual(library.snapshot().models.find(model=>model.model_config_id===peer.model_config_id),before.models.find(model=>model.model_config_id===peer.model_config_id),'another entry remains byte-for-byte independent');
  assert.match(job.error??'',/variant-fixture-stop/);
});
