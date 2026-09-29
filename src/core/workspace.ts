import { newId, recipeSchema, type Job, type ModelConfig, type Project, type Recipe } from './domain.js';
import { ModuleRegistry } from './modules.js';
import { ModelLibrary } from './models.js';
import type { ProjectStorePort, CloudExecutionPort, ExecutionResult } from './ports.js';
import { normalizeParameters } from './generation-parameters.js';
import { planExecution } from './execution-plan.js';
import { selectWorkflowModel,snapshotParameters } from './model-settings.js';
import {bindHistoricalRecipe,historicalPreset} from './historical-model.js';
import { modelIdentity } from '../protocols/model-catalog.js';
import { maskDraftSchema,maskStrokesSchema,sameMaskStrokes,currentMaskFeather,MASK_FEATHER_VERSION,type MaskDraft,type MaskMode,type MaskPixelsPort,type MaskStroke } from './mask.js';
import {maskGuidance,planMaskRequest} from './mask-request.js';
import {validateImagesUpload} from './image-limits.js';

// Repository and executor are injected ports. No window/UI dependencies.
export class Workspace {
  project: Project | null = null;
  repository: ProjectStorePort | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pumping = false;
  private active = new Map<string, AbortController>();
  private configs = new Map<string, ModelConfig>();
  onChange: () => Promise<void> = async () => {};
  private saveTimer?:ReturnType<typeof setTimeout>;
  saveState:'saved'|'pending'|'saving'|'error'='saved';
  saveError?:string;
  constructor(readonly models: ModelLibrary, private executor: CloudExecutionPort,readonly registry=new ModuleRegistry(),private maskPixels?:MaskPixelsPort,private autosaveDelay=0) {}
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => undefined);
    return task;
  }
  requireProject() {
    if (!this.project || !this.repository) throw new Error('工作台尚未初始化，请稍后重试。');
    return this.project;
  }
  assertSwitchable() {
    if (this.project?.jobs.some(j => ['queued','preparing','running','post_processing'].includes(j.status))) throw new Error('请先等待当前任务结束或取消任务，再切换项目。');
  }
  async create(repository: ProjectStorePort, name: string) {
    this.assertSwitchable();
    await this.flush();
    const now = new Date().toISOString();
    const project: Project = { schema_version: 3, project_id: newId('project'), name, created_at: now, updated_at: now,
      recipe: { recipe_id: newId('recipe'), schema_version: 1, input_strategy:'auto', prompt_config: structuredClone(this.registry.promptConfig), modules: ['subject','composition','style','prompt'].map(type => this.registry.create(type)), model_config_id: this.models.defaultModel(), core_parameters: snapshotParameters(this.models.resolve(this.models.defaultModel()).defaults,this.models.resolve(this.models.defaultModel())) },
      assets: [], jobs: [], revisions: [] };
    await repository.create(project);
    this.repository = repository; this.project = project;
  }
  async open(repository: ProjectStorePort) {
    this.assertSwitchable();
    await this.flush();
    const project = await repository.load();
    project.recipe = await this.restoreRecipeBinding(this.registry.resolveRecipe(project.recipe),project.jobs);
    let recovered = false;
    project.jobs.forEach(j => {
      if (['queued','preparing','running','post_processing'].includes(j.status)) {
        j.status = 'failed'; j.stage = '应用中断'; j.error = '上次运行已中断。为避免重复计费，没有自动重试。'; j.finished_at = new Date().toISOString(); recovered = true;
      }
    });
    for(const job of project.jobs)if(job.status==='failed'&&!job.recoverable_result){
      try{await repository.pendingResult(job.task_id);job.recoverable_result=true;recovered=true;}catch{/* No staged result to recover. */}
    }
    if (recovered) await repository.save(project);
    this.repository = repository; this.project = project;
  }
  async flush(){if(this.saveState!=='saved')await this.persist();}
  acceptSavedCopy(){clearTimeout(this.saveTimer);this.saveTimer=undefined;this.saveState='saved';this.saveError=undefined;}
  async persist(immediate=true) {
    clearTimeout(this.saveTimer);this.saveTimer=undefined;
    if(this.repository?.transient)immediate=true;
    if(!immediate&&this.autosaveDelay>0){
      this.saveState='pending';
      this.saveTimer=setTimeout(()=>{void this.serial(async()=>{try{await this.persist();}catch{/* Error and unsaved edits remain visible; no silent retry. */}await this.onChange();}).catch(()=>{});},this.autosaveDelay);
      this.saveTimer.unref();return;
    }
    const p = this.requireProject(), previousTime=p.updated_at; p.updated_at = new Date().toISOString();
    this.saveState='saving';
    try { await this.repository!.save(p);this.saveState='saved';this.saveError=undefined; }
    catch(e){p.updated_at=previousTime;this.saveState='error';this.saveError=e instanceof Error?e.message:'工程保存失败';throw e;}
  }
  async saveRecipe(input: Recipe) {
    const p = this.requireProject(); const next = recipeSchema.parse(input);
    if (next.recipe_id !== p.recipe.recipe_id) throw new Error('配方身份不匹配。');
    const existing = new Map(p.recipe.modules.map(m => [m.module_id, m]));
    for (const m of next.modules) {
      const old = existing.get(m.module_id);
      if (!old) throw new Error('新增或复制模块必须通过模块库。');
      if (m.reference_type !== old.reference_type || m.reference_id !== old.reference_id || m.base_instruction !== old.base_instruction || m.numbered_instruction!==old.numbered_instruction||m.model_name!==old.model_name) throw new Error('模块类型、参考 ID 和基础语义不可由界面修改。');
      const d = this.registry.get(m.reference_type);
      if (!d.accepts_images && m.asset_ids.length) throw new Error('提示词模块只支持文本。');
      m.asset_ids.forEach(id => { if (!p.assets.some(a => a.asset_id === id)) throw new Error('引用的素材不存在。'); });
    }
    let selected:ModelConfig|undefined;
    try{selected=this.models.resolve(next.model_config_id);}catch(error){if(next.model_config_id!==p.recipe.model_config_id)throw error;}
    if(selected&&(!next.model_preset_id||next.model_preset_id===selected.preset_id)){
      next.core_parameters=normalizeParameters(next.core_parameters,selected);
      if(selected.preset_id)next.model_preset_id=selected.preset_id;else delete next.model_preset_id;
      next.model_parameters={...next.model_parameters,[modelIdentity(selected)]:structuredClone(next.core_parameters)};
    }
    const previous = p.recipe;
    p.recipe = this.registry.resolveRecipe(next);
    try { await this.persist(false); } catch (e) { p.recipe = previous; throw e; }
  }
  async selectModel(id:string){
    const recipe=this.requireProject().recipe;
    if(this.models.resolve(id).purpose==='understanding')throw new Error('工作台请选择生图模型。');
    let previous:ModelConfig|undefined;try{previous=this.models.resolve(recipe.model_config_id);}catch{/* removed channel */}
    const selected=this.models.resolve(id),preset=historicalPreset(recipe,this.requireProject().jobs);
    const next=selectWorkflowModel(recipe,selected,previous);
    if(!previous&&preset&&preset===selected.preset_id)next.core_parameters=structuredClone(recipe.core_parameters);
    await this.saveRecipe(next);
  }
  async resetParameters(){const recipe=structuredClone(this.requireProject().recipe),model=this.models.resolve(recipe.model_config_id);recipe.core_parameters=snapshotParameters(model.defaults,model);await this.saveRecipe(recipe);}
  async hideMaterial(assetId: string) {
    const p=this.requireProject(),asset=p.assets.find(a=>a.asset_id===assetId&&a.kind==='import');
    if(!asset)throw new Error('工作素材不存在。');
    const previous=asset.hidden_from_materials;asset.hidden_from_materials=true;
    try{await this.persist(false);}catch(e){asset.hidden_from_materials=previous;throw e;}
  }
  private async commitRecipe(next: Recipe) {
    const p = this.requireProject(), previous = p.recipe;
    p.recipe = next;
    try { await this.persist(false); } catch (e) { p.recipe = previous; throw e; }
  }
  async addModule(type: string, beforeModuleId?: string) {
    const p = this.requireProject();
    if (p.recipe.modules.length >= 40) throw new Error('第一阶段最多使用 40 个模块。');
    const index = beforeModuleId ? p.recipe.modules.findIndex(m => m.module_id === beforeModuleId) : p.recipe.modules.length;
    if (index < 0) throw new Error('插入位置的模块不存在。');
    const next = structuredClone(p.recipe);
    next.modules.splice(index, 0, this.registry.create(type)); await this.commitRecipe(next);
  }
  async copyModule(id: string) {
    const p = this.requireProject(), index = p.recipe.modules.findIndex(m => m.module_id === id);
    if (index < 0) throw new Error('模块不存在。');
    if (p.recipe.modules.length >= 40) throw new Error('第一阶段最多使用 40 个模块。');
    const next = structuredClone(p.recipe);
    next.modules.splice(index + 1, 0, this.registry.copy(p.recipe.modules[index])); await this.commitRecipe(next);
  }
  async changeReferenceType(id: string, type: string) {
    const p = this.requireProject(), old = p.recipe.modules.find(m => m.module_id === id);
    if (!old) throw new Error('模块不存在。');
    const previous = this.registry.get(old.reference_type), definition = this.registry.get(type);
    if (previous.editor_kind !== 'image_collection' || definition.editor_kind !== 'image_collection') throw new Error('仅语义参考模块可以切换参考类别。');
    if (old.reference_type === type) return;
    const next = structuredClone(p.recipe), module = next.modules.find(m => m.module_id === id)!;
    module.model_name=definition.model_name??definition.type;
    module.reference_type = type; module.reference_id = newId(type); module.base_instruction = definition.base_instruction;
    if(definition.numbered_instruction)module.numbered_instruction=definition.numbered_instruction;else delete module.numbered_instruction;
    if (module.title === previous.title) module.title = definition.title;
    await this.commitRecipe(next);
  }
  async relinkAsset(id: string, filename: string) {
    const p = this.requireProject(), index = p.assets.findIndex(a => a.asset_id === id);
    if (index < 0) throw new Error('素材不存在。');
    const replacement = await this.repository!.relinkImage(p.assets[index], filename), previous = p.assets;
    p.assets = [...p.assets]; p.assets[index] = replacement;
    try { await this.persist(false); } catch (e) { p.assets = previous; throw e; }
  }
  async saveToolReference(id: string, bytes: Buffer, state: Record<string,unknown>, instruction: string) {
    const p = this.requireProject(), old = p.recipe.modules.find(m => m.module_id === id);
    if (!old || this.registry.get(old.reference_type).editor_kind !== 'generated_reference') throw new Error('该模块不是功能参考模块。');
    state=this.registry.validateToolState(old.reference_type,state);
    const asset = await this.repository!.saveInternalImage(bytes, '视角参考.png');
    const previousAssets = p.assets, previousRecipe = p.recipe;
    p.assets = [...p.assets, asset]; p.recipe = structuredClone(p.recipe);
    const module = p.recipe.modules.find(m => m.module_id === id)!;
    module.asset_ids = [asset.asset_id]; module.tool_state = { ...state }; module.user_instruction = instruction;
    try { await this.persist(false); } catch (e) { p.assets = previousAssets; p.recipe = previousRecipe; throw e; }
  }
  async importFiles(files: string[], moduleId?: string) {
    const p = this.requireProject(), m = moduleId ? p.recipe.modules.find(m => m.module_id === moduleId) : undefined;
    if (moduleId && !m) throw new Error('模块不存在。');
    if (m && !this.registry.get(m.reference_type).accepts_images) throw new Error('提示词模块不接受图片。');
    if (m && this.registry.get(m.reference_type).editor_kind === 'generated_reference') throw new Error('请使用功能参考工具生成图片，或拖到语义参考模块。');
    if (files.length > 64 || (m && m.asset_ids.length + files.length > 64)) throw new Error('单模块最多暂存 64 个图片引用。');
    // Keep selection/insertion order, including deliberate repeated references.
    const previousAssets = p.assets, nextAssets = structuredClone(p.assets), nextRecipe = structuredClone(p.recipe);
    const nextModule = m ? nextRecipe.modules.find(item => item.module_id === m.module_id)! : undefined;
    for (const file of files) {
      const a = await this.repository!.importImage(file);
      const existing=nextAssets.find(old=>old.asset_id===a.asset_id);
      if (!existing) nextAssets.push(a);else existing.hidden_from_materials=false;
      if (nextModule) nextModule.asset_ids.push(a.asset_id);
    }
    const previousRecipe = p.recipe;
    const previousName = p.name;
    if(p.name==='未命名工作' && nextAssets.some(a=>a.kind==='import'))p.name=nextAssets.find(a=>a.kind==='import')!.name.replace(/\.[^.]+$/,'').slice(0,100)||'未命名工作';
    p.assets = nextAssets; p.recipe = nextRecipe;
    try { await this.persist(false); } catch (e) { p.assets = previousAssets; p.recipe = previousRecipe; p.name = previousName; throw e; }
  }
  async enqueue(allowDegradation: boolean) {
    const p = this.requireProject();
    if (p.jobs.length >= 1000) throw new Error('第一阶段最多保留 1000 个任务。');
    const model = await this.models.execution(p.recipe.model_config_id);
    if(model.purpose!=='generation')throw new Error('请选择生图用途的模型。');
    const plan=planExecution(p.recipe,p.assets,model,this.registry);
    const {recipe:resolvedRecipe,chain,adapted,geometry:output_geometry}=plan;
    if (!chain.blocks.some(b => b.type === 'text' && b.text.trim())) throw new Error('请填写生成提示词。');
    if (adapted.adjustments.length && !allowDegradation) throw new Error('需要确认接口降级后才能运行。');
    const { model_config_id, title, provider, model: actualModel, adapter_id, revision, kind,preset_id,images_compatibility,gemini_compatibility } = model;
    const job: Job = { task_id: newId('task'), status: 'queued', stage: '等待执行', progress: 0, created_at: new Date().toISOString(),
      execution_plan:plan.summary, recipe_snapshot: resolvedRecipe, chain_snapshot: structuredClone(chain),output_geometry, model_snapshot: { model_config_id, title, provider, model: actualModel, adapter_id, revision, kind,...(preset_id?{preset_id}:{}),...(images_compatibility?{images_compatibility:structuredClone(images_compatibility)}:{}),...(gemini_compatibility?{gemini_compatibility:structuredClone(gemini_compatibility)}:{}) }, adapted_input: adapted, output_asset_ids: [] };
    p.jobs.push(job); this.configs.set(job.task_id, structuredClone(model));
    try { await this.persist(); } catch (e) { p.jobs.pop(); this.configs.delete(job.task_id); throw e; }
    queueMicrotask(() => void this.pump().catch(async () => { /* Job failures are recorded by pump. */ }));
  }
  async retry(projectId:string,id:string){
    const p=this.requireProject();if(p.project_id!==projectId)throw new Error('工程已切换，请回到原工程重试。');
    const previous=p.jobs.find(job=>job.task_id===id);
    if(!previous||previous.status!=='failed')throw new Error('只能重试失败的任务。');
    if(previous.recoverable_result){await this.recoverResult(id);return;}
    if(previous.mask_edit?.raw_asset_ids.length){const edit=previous.mask_edit;await this.reprocessMask(projectId,id,edit.draft.mode,edit.draft.feather,edit.composite_strokes);return;}
    if(p.jobs.length>=1000)throw new Error('当前工作任务数量已达上限。');
    const model=await this.models.execution(previous.model_snapshot.model_config_id),snapshot=previous.model_snapshot;
    if(model.revision!==snapshot.revision||model.model!==snapshot.model||model.adapter_id!==snapshot.adapter_id)throw new Error('此任务的模型配置已改变，请复用历史输入并确认模型后重新生成。');
    const job=structuredClone(previous);
    job.task_id=newId('task');job.status='queued';job.stage='等待重试';job.progress=0;job.created_at=new Date().toISOString();job.output_asset_ids=[];
    delete job.finished_at;delete job.error;delete job.execution_summary;delete job.recoverable_result;
    if(job.mask_edit){job.mask_edit.raw_asset_ids=[];job.mask_edit.variants=[];}
    p.jobs.push(job);this.configs.set(job.task_id,structuredClone(model));
    try{await this.persist();}catch(error){p.jobs.pop();this.configs.delete(job.task_id);throw error;}
    queueMicrotask(()=>void this.pump().catch(()=>{}));
  }
  async saveMaskDraft(projectId:string,input:MaskDraft){
    const p=this.requireProject();if(p.project_id!==projectId)throw new Error('工作记录已切换，请重新进入局部编辑。');
    const draft=maskDraftSchema.parse(input),asset=p.assets.find(a=>a.asset_id===draft.source_asset_id);
    if(!asset||asset.width!==draft.width||asset.height!==draft.height)throw new Error('编辑底图不存在或尺寸已改变。');
    const previous=p.mask_drafts;
    const others=(previous??[]).filter(d=>d.source_asset_id!==draft.source_asset_id);
    if(others.length>=20)throw new Error('当前工作最多保留 20 张图片的编辑草稿，请新建工作。');
    p.mask_drafts=[...others,structuredClone(draft)];
    try{await this.persist(false);}catch(e){p.mask_drafts=previous;throw e;}
  }
  async enqueueMask(projectId:string,input:MaskDraft){
    await this.saveMaskDraft(projectId,input);
    const p=this.requireProject(),draft=maskDraftSchema.parse(input),repository=this.repository!;
    if(!this.maskPixels)throw new Error('蒙版处理器未安装。');
    if(p.jobs.length>=1000)throw new Error('当前工作任务数量已达上限。');
    const model=await this.models.execution(draft.model_config_id);
    if(!draft.instruction.trim())throw new Error('请填写局部编辑指令。');
    const plan=planMaskRequest(draft,model),{contract,parameters,method,strategy}=plan,planned=plan.crop;
    const crop=method==='native'&&planned.x===0&&planned.y===0&&planned.width===draft.width&&planned.height===draft.height?undefined:planned;
    const original=p.assets.find(a=>a.asset_id===draft.source_asset_id)!;
    const prepared=await this.maskPixels.prepare(await repository.readAsset(original),draft,crop);
    const requestBytes=prepared.requestSource??prepared.source;
    if(model.adapter_id==='openai-images')validateImagesUpload(Math.max(requestBytes.length,prepared.mask.length),requestBytes.length+prepared.mask.length+Buffer.byteLength(draft.instruction),model.images_compatibility);
    const source=await repository.saveInternalImage(prepared.source,'局部编辑底图.png');
    const mask=await repository.saveInternalImage(prepared.mask,'局部编辑蒙版.png');
    const requestSource=crop?await repository.saveInternalImage(requestBytes,'局部编辑送入范围.png'):source;
    const guide=method==='guided'?await repository.saveInternalImage(await this.maskPixels.guidance(prepared.mask),'黑白区域图.png'):undefined;
    const module=this.registry.create('prompt');module.user_instruction=draft.instruction;
    const recipe:Recipe={recipe_id:newId('recipe'),schema_version:1,modules:[module],model_config_id:model.model_config_id,core_parameters:parameters,input_strategy:strategy};
    const origin={source_module_id:module.module_id,reference_type:'mask_edit',reference_id:module.reference_id};
    const blocks:Job['chain_snapshot']['blocks']=guide?[
      {type:'image',asset_id:requestSource.asset_id,...origin},{type:'image',asset_id:guide.asset_id,...origin},
      {type:'text',text:maskGuidance.instruction(draft.instruction),...origin},
    ]:[{type:'image',asset_id:requestSource.asset_id,...origin},{type:'text',text:draft.instruction,...origin}];
    const adapted:Job['adapted_input']=strategy==='interleaved'?{kind:'native_blocks',blocks:structuredClone(blocks),adjustments:[]}:{kind:'separated_inputs',image_asset_ids:[requestSource.asset_id,...(guide?[guide.asset_id]:[])],prompt:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n\n'),adjustments:[]};
    const {model_config_id,title,provider,model:actualModel,adapter_id,revision,kind,preset_id,images_compatibility,gemini_compatibility}=model;
    const job:Job={task_id:newId('task'),status:'queued',stage:'等待局部编辑',progress:0,created_at:new Date().toISOString(),
      recipe_snapshot:recipe,chain_snapshot:{blocks,mode:'reference_generation'},adapted_input:adapted,
      model_snapshot:{model_config_id,title,provider,model:actualModel,adapter_id,revision,kind,...(preset_id?{preset_id}:{}),images_compatibility,gemini_compatibility},output_asset_ids:[],
      mask_edit:{main_recipe_snapshot:structuredClone(p.recipe),draft:structuredClone(draft),method,source_snapshot_id:source.asset_id,mask_asset_id:mask.asset_id,...(crop?{crop,request_source_id:requestSource.asset_id}:{}),...(guide?{guide_asset_id:guide.asset_id}:{}),parent_revision_id:p.revisions.find(r=>r.asset_id===original.asset_id)?.revision_id,raw_asset_ids:[],variants:[]},
      execution_plan:{version:1,operation:method==='guided'?'guidedMaskEdit':'nativeMaskEdit',requested_strategy:strategy,actual_strategy:strategy,contract,model_revision:revision,adapter_version:model.adapter_version??1,diagnostics:[]},
      output_geometry:plan.geometry,
    };
    const previousAssets=p.assets;p.assets=[...p.assets,source,mask,...(crop?[requestSource]:[]),...(guide?[guide]:[])];p.jobs.push(job);this.configs.set(job.task_id,structuredClone(model));
    try{await this.persist();}catch(e){p.assets=previousAssets;p.jobs.pop();this.configs.delete(job.task_id);throw e;}
    queueMicrotask(()=>void this.pump());
  }
  async saveCompositeMask(projectId:string,taskId:string,strokes:MaskStroke[]){
    const p=this.requireProject();if(p.project_id!==projectId)throw new Error('工作记录已切换。');
    const edit=p.jobs.find(j=>j.task_id===taskId)?.mask_edit;
    if(!edit?.raw_asset_ids.length)throw new Error('请等待模型返回图片后再调整合成蒙版。');
    const previous=edit.composite_strokes;edit.composite_strokes=maskStrokesSchema.parse(strokes);
    try{await this.persist(false);}catch(e){edit.composite_strokes=previous;throw e;}
  }
  async reprocessMask(projectId:string,taskId:string,mode:MaskMode,feather:number,compositeStrokes?:MaskStroke[]){
    const p=this.requireProject();if(p.project_id!==projectId)throw new Error('工作记录已切换。');
    const job=p.jobs.find(j=>j.task_id===taskId);
    if(!job?.mask_edit?.raw_asset_ids.length||!['succeeded','failed'].includes(job.status))throw new Error('请等待模型返回图片后再处理。');
    try{
      const strokes=maskStrokesSchema.parse(compositeStrokes??job.mask_edit.composite_strokes??job.mask_edit.draft.strokes);
      const assetId=await this.saveMaskVariant(job,mode,feather,strokes);
      if(mode==='strict')job.mask_edit.composite_strokes=structuredClone(strokes);
      job.status='succeeded';job.stage='结果版本已保存';job.progress=100;job.finished_at??=new Date().toISOString();delete job.error;
      await this.repository!.saveOutputRecords(p,job);job.recoverable_result=false;await this.persist();
      await this.repository!.clearPendingResult(job.task_id).catch(()=>{});return assetId;
    }catch(e){job.status='failed';job.error='结果保存未完成，请重新确认保存；原始返回图仍保留，不会再次调用模型。';await this.persist().catch(()=>{});throw e;}
  }
  async previewMask(projectId:string,taskId:string,mode:MaskMode,feather:number,compositeStrokes?:MaskStroke[]){
    const p=this.requireProject();if(p.project_id!==projectId)throw new Error('工作记录已切换。');
    const job=p.jobs.find(j=>j.task_id===taskId);
    if(!job?.mask_edit?.raw_asset_ids.length||!['succeeded','failed'].includes(job.status))throw new Error('请等待模型返回图片后再预览。');
    const strokes=maskStrokesSchema.parse(compositeStrokes??job.mask_edit.composite_strokes??job.mask_edit.draft.strokes);
    const {bytes,format}=await this.renderMaskVariant(job,mode,feather,strokes);
    return `data:image/${format};base64,${bytes.toString('base64')}`;
  }
  private async renderMaskVariant(job:Job,mode:MaskMode,feather:number,strokes:MaskStroke[]){
    const p=this.requireProject(),edit=job.mask_edit!,repo=this.repository!;
    const read=(id:string)=>{const asset=p.assets.find(a=>a.asset_id===id);if(!asset)throw new Error('局部编辑素材缺失。');return repo.readAsset(asset);};
    const raw=p.assets.find(a=>a.asset_id===edit.raw_asset_ids[0]);if(!raw)throw new Error('模型原始返回图缺失。');
    const mask=edit.crop?await this.maskPixels!.rasterize(edit.draft.width,edit.draft.height,strokes):mode==='natural'?undefined:sameMaskStrokes(strokes,edit.draft.strokes)?await read(edit.mask_asset_id):await this.maskPixels!.rasterize(edit.draft.width,edit.draft.height,strokes);
    const generated=await read(raw.asset_id);
    const aligned=edit.method==='guided'?await this.maskPixels!.alignGuidedResult(generated,edit.crop!.width,edit.crop!.height):generated;
    const bytes=mode==='natural'&&!edit.crop?aligned:await this.maskPixels!.compose(await read(edit.source_snapshot_id),mask!,aligned,feather,edit.crop,mode);
    const format=mode==='strict'||edit.crop?'png':raw.mime_type.split('/')[1] as 'png'|'jpeg'|'webp';
    return {bytes,format};
  }
  private async saveMaskVariant(job:Job,mode:MaskMode,feather:number,strokes:MaskStroke[]){
    const p=this.requireProject(),edit=job.mask_edit!,repo=this.repository!;
    if(mode==='natural')feather=0;
    const cached=edit.variants.find(v=>currentMaskFeather(v)&&v.mode===mode&&v.feather===feather&&(mode==='natural'||sameMaskStrokes(v.composite_strokes??edit.draft.strokes,strokes))&&p.assets.some(a=>a.asset_id===v.asset_id&&!a.removed_result));
    if(cached){const asset=p.assets.find(a=>a.asset_id===cached.asset_id)!;await repo.readAsset(asset);asset.hidden_from_results=false;if(!job.output_asset_ids.includes(asset.asset_id))job.output_asset_ids.push(asset.asset_id);return asset.asset_id;}
    const {bytes,format}=await this.renderMaskVariant(job,mode,feather,strokes);
    const asset=await repo.saveOutput(bytes,mode==='strict'?'局部修改.png':'自然融合.png',format);
    p.assets.push(asset);job.output_asset_ids.push(asset.asset_id);edit.variants.push({asset_id:asset.asset_id,mode,feather,...(mode==='strict'?{composite_strokes:structuredClone(strokes),...(feather?{feather_version:MASK_FEATHER_VERSION}:{})}:{})});
    p.revisions.push({revision_id:newId('revision'),asset_id:asset.asset_id,parent_revision_id:edit.parent_revision_id,task_id:job.task_id,created_at:asset.created_at});
    return asset.asset_id;
  }
  async cancel(id: string) {
    const job = this.requireProject().jobs.find(j => j.task_id === id);
    if (!job) throw new Error('任务不存在。');
    if (['succeeded','failed','cancelled'].includes(job.status)) return;
    this.active.get(id)?.abort();
    job.status = 'cancelled'; job.stage = '已取消'; job.finished_at = new Date().toISOString();
    this.configs.delete(id); await this.persist();
  }
  private async restoreRecipeBinding(recipe:Recipe,jobs:Job[]){
    const preset=historicalPreset(recipe,jobs),preferred=preset?this.project?.recipe.model_channels?.[preset]:undefined;
    return bindHistoricalRecipe(recipe,jobs,await this.models.list(),[preferred,this.models.defaultModel()]);
  }
  async restoreResult(projectId:string,assetId:string) {
    const p=this.requireProject();
    if(p.project_id!==projectId)throw new Error('工作记录已切换，请重新选择结果版本。');
    const asset=p.assets.find(a=>a.asset_id===assetId&&a.kind==='output'&&!a.removed_result&&!a.hidden_from_results);
    const job=p.jobs.find(j=>j.output_asset_ids.includes(assetId));
    if(!asset||!job)throw new Error('该结果没有可恢复的生成记录。');
    const recipe=this.registry.resolveRecipe(job.mask_edit?.main_recipe_snapshot??job.recipe_snapshot);
    const restored=await this.restoreRecipeBinding(recipe,[...p.jobs,job]);
    // Switch current work only. Historical task and variant snapshots stay intact.
    await this.commitRecipe(restored);
  }
  async restore(id: string) {
    const p = this.requireProject(), job = p.jobs.find(j => j.task_id === id);
    if (!job) throw new Error('历史任务不存在。');
    if(job.mask_edit){await this.saveMaskDraft(p.project_id,job.mask_edit.draft);return;}
    const recipe = structuredClone(job.recipe_snapshot);
    const restored=await this.restoreRecipeBinding(recipe,[...p.jobs,job]);
    // Reusing a historical recipe creates current work; the job stays immutable.
    await this.commitRecipe(this.registry.resolveRecipe(restored));
  }
  async recoverResult(id:string){
    this.assertSwitchable();const job=this.requireProject().jobs.find(j=>j.task_id===id);if(!job||job.status!=='failed')throw new Error('只能恢复保存失败或中断的任务产物。');
    const result=await this.repository!.pendingResult(id);await this.finishResult(job,this.repository!,result);
  }
  private async finishResult(job:Job,repository:ProjectStorePort,result:ExecutionResult){
    if(!result.images.length)throw new Error('模型没有返回可保存的图片。');
    const p=this.requireProject();
    if(job.mask_edit){
      if(!job.mask_edit.raw_asset_ids.length){
        const raw=await repository.saveInternalImage(result.images[0].bytes,'模型原始返回图','internal');
        p.assets.push(raw);job.mask_edit.raw_asset_ids.push(raw.asset_id);await this.persist();
      }
    }
    for(let i=job.mask_edit?result.images.length:job.output_asset_ids.length;i<result.images.length;i++){
      const {bytes,format}=result.images[i];const asset=await repository.saveOutput(bytes,`${job.model_snapshot.kind==='mock'?'模拟结果':'生成结果'}-${job.task_id.slice(-6)}-${i+1}.${format}`,format);
      p.assets.push(asset);job.output_asset_ids.push(asset.asset_id);p.revisions.push({revision_id:newId('revision'),asset_id:asset.asset_id,task_id:job.task_id,created_at:asset.created_at});
    }
    job.status='succeeded';job.progress=100;job.stage=job.mask_edit?'模型已返回，预览后确认保存':job.model_snapshot.kind==='mock'?'模拟生成完成':'生成完成';job.finished_at=new Date().toISOString();delete job.error;
    job.recoverable_result=false;
    try{await repository.saveOutputRecords(p,job);await this.persist();}catch(error){job.recoverable_result=true;job.status='failed';job.stage='产物保存失败，可恢复本地结果';job.error='产物保存未完成，请恢复本地结果；不要重新生成。';throw error;}
    await repository.clearPendingResult(job.task_id).catch(()=>{});await this.onChange();
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    let storageHealthy = true;
    try {
      while (true) {
        const context = await this.serial(async () => {
          const job = this.project?.jobs.find(j => j.status === 'queued');
          if (!job) return null;
          const model = this.configs.get(job.task_id);
          if (!model) throw new Error('缺少固定的模型执行配置。');
          const controller = new AbortController(); this.active.set(job.task_id, controller);
          job.status = 'preparing'; job.stage = '准备输入'; job.progress = 10;
          await this.persist(); await this.onChange();
          return { job, model, controller, repository: this.repository! };
        });
        if (!context) break;
        const { job, model, controller, repository } = context;
        try {
          const allowedImages = new Set(job.chain_snapshot.blocks.filter(b => b.type === 'image').map(b => b.asset_id));
          if(job.mask_edit){allowedImages.add(job.mask_edit.source_snapshot_id);allowedImages.add(job.mask_edit.mask_asset_id);}
          const readImage = async (assetId: string) => {
            if (!allowedImages.has(assetId)) throw new Error('执行器只能读取本次任务的参考图。');
            if (controller.signal.aborted) throw new Error('任务已取消。');
            const asset = this.requireProject().assets.find(a => a.asset_id === assetId);
            if (!asset) throw new Error('任务参考图不存在。');
            return repository.readAsset(asset);
          };
          for (const assetId of allowedImages) await readImage(assetId);
          const result = await this.executor.execute({ job: structuredClone(job), model, readImage, resolveCredential:()=>this.models.credential(model),recordModelInput:input=>repository.saveModelInput(job.task_id,input) }, controller.signal, (stage, progress) => this.serial(async () => {
            if (job.status === 'cancelled') return;
            job.status = 'running'; job.stage = stage; job.progress = progress;
            await this.persist(); await this.onChange();
          }));
          if(controller.signal.aborted)continue;
          if(!result.images.length)throw new Error('模型没有返回可保存的图片。');
          job.execution_summary={adapter_version:model.adapter_version??1,capabilities:structuredClone(model.capabilities),...(result.text?{text:result.text}:{}),...(result.request_id?{request_id:result.request_id}:{}),...(result.usage?{usage:result.usage}:{}),fee:'unknown',actual_formats:result.images.map(i=>i.format)};
          await repository.stageResult(job,result);
          job.recoverable_result=true;
          await this.serial(async () => {
            if (job.status === 'cancelled' || controller.signal.aborted) return;
            job.status = 'post_processing'; job.stage = '保存结果与版本'; job.progress = 90;
            await this.persist(); await this.onChange();
          });
          await this.serial(async () => {
            if (job.status === 'cancelled' || controller.signal.aborted) return;
            await this.finishResult(job,repository,result);
          });
        } catch (error) {
          await this.serial(async () => {
            if (job.status !== 'cancelled') { job.status = 'failed'; job.error = error instanceof Error ? error.message : '任务执行失败'; job.stage = '执行失败'; job.finished_at = new Date().toISOString(); }
            await this.persist(); await this.onChange();
          });
        } finally { this.active.delete(job.task_id); this.configs.delete(job.task_id); }
      }
    } catch (error) {
      storageHealthy = false;
      // A failing disk must not trigger an infinite queue/retry loop.
      await this.serial(async () => {
        for (const job of this.project?.jobs ?? []) if (['queued','preparing','running','post_processing'].includes(job.status)) {
          this.active.get(job.task_id)?.abort(); this.configs.delete(job.task_id);
          job.status = 'failed'; job.stage = '任务存储失败'; job.error = error instanceof Error ? error.message : '无法保存任务'; job.finished_at = new Date().toISOString();
        }
        try { await this.persist(); } catch { /* Keep the failure visible in memory; no automatic rerun. */ }
        try { await this.onChange(); } catch { /* Window may already be closed. */ }
      });
    } finally {
      this.pumping = false;
      if (storageHealthy && this.project?.jobs.some(j => j.status === 'queued')) queueMicrotask(() => void this.pump());
    }
  }
  async shutdown() {
    this.active.forEach(controller => controller.abort());
    await this.serial(async () => {
      if (!this.project) return;
      let cancelled=false;
      for (const job of this.project.jobs) if (['queued','preparing','running','post_processing'].includes(job.status)) {
        job.status = 'cancelled'; job.stage = '应用关闭，任务终止'; job.finished_at = new Date().toISOString();
        cancelled=true;
      }
      if(cancelled)await this.persist();else await this.flush();
    });
  }
}
