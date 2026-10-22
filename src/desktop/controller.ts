import { dialog, shell, type BrowserWindow } from 'electron';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import { planExecution } from '../core/execution-plan.js';
import { newId } from '../core/domain.js';
import { ModelLibrary } from '../core/models.js';
import { Workspace } from '../core/workspace.js';
import { ProjectRepository, atomicJson, projectFilename } from '../adapters/project-repository.js';
import { MockGenerator } from '../adapters/mock-generator.js';
import { openModelLibrary,modelLibraryFilename } from '../adapters/model-library-repository.js';
import { ExecutionRegistry } from '../adapters/execution-registry.js';
import { loadPromptSettings,savePromptCustomizations,importPromptCustomizations,exportPromptCustomizations } from '../adapters/prompt-config-repository.js';
import { emptyPromptCustomizations, type PromptCustomizations } from '../core/prompt-customization.js';
import { loadModuleSettings,saveModuleSettings } from '../adapters/module-settings-repository.js';
import { loadGenerationTimings } from '../adapters/generation-timing-repository.js';
import { ReferencePreprocessor } from '../adapters/reference-preprocessor.js';
import { resizeReferenceImage } from '../adapters/reference-image.js';
import {localImageModelStatus,prepareLocalImageModel,type LocalImageModelKind} from '../adapters/local-image-models.js';
import { ModuleRegistry } from '../core/modules.js';
import {prepareModuleInference,executeModuleInference,applyAutomaticPromptSuggestion} from '../core/module-inference.js';
import {getAutoPromptState} from '../core/auto-prompt.js';
import { GeminiGenerator } from '../adapters/gemini-generator.js';
import { ImagesGenerator } from '../adapters/images-generator.js';
import { ChatCompletionsAdapter } from '../adapters/chat-completions.js';
import { MaskPixels } from '../adapters/mask-pixels.js';
import { commandSchema } from '../shared/commands.js';
import type { ApiResponse, WorkspaceView } from '../shared/api.js';
import { EncryptedSecretStore } from './secret-store.js';
import { ModelTests,modelTestSchema,type ModelTestRecord } from '../core/model-tests.js';
import {ProjectLibrary} from '../adapters/project-library.js';
import {DocumentLibrary,type DocumentOutputMatch} from '../adapters/document-library.js';
import {DocumentRepository} from '../adapters/document-repository.js';
import {DraftRepository} from '../adapters/draft-repository.js';
import {outputFilename} from '../core/output-name.js';
import {inspectDocumentTarget,sameDocumentFile} from '../adapters/document-save-target.js';

export class DesktopController {
  private promptCustomizations:PromptCustomizations=structuredClone(emptyPromptCustomizations);
  private showMessage:(options:import('electron').MessageBoxOptions)=>Promise<{response:number}>;
  private inferences=new Map<string,AbortController>();
  private referenceDownloads=new Map<LocalImageModelKind,AbortController>();
  private referenceDownloadTasks=new Set<Promise<void>>();
  private referencePreviews=new Map<string,AbortController>();
  private token = newId('session');
  private hiddenRecords=new Set<string>();
  readonly projects:ProjectLibrary;
  readonly documents:DocumentLibrary;
  private currentRecordId?:string;
  private needsRegistration=false;
  private draft?:DraftRepository;
  private get outputDirectory(){return this.projects.outputDirectory;}
  private repository(directory:string){return this.projects.repository(directory);}
  private cancelReferencePreviews(){for(const preview of this.referencePreviews.values())preview.abort();}
  private constructor(readonly workspace: Workspace, private window: () => BrowserWindow, private runtimeDirectory: string, private executors:ExecutionRegistry,readonly modelTests:ModelTests,showMessage?: (options:import('electron').MessageBoxOptions)=>Promise<{response:number}>,projectRoot=path.resolve(runtimeDirectory,'..','..'),private referencePreprocessor=new ReferencePreprocessor(runtimeDirectory)) {this.showMessage=showMessage??(options=>dialog.showMessageBox(window(),options));this.projects=new ProjectLibrary(projectRoot,runtimeDirectory);this.documents=new DocumentLibrary(runtimeDirectory);}
  async shutdown(){for(const task of this.inferences.values())task.abort();for(const task of this.referenceDownloads.values())task.abort();this.cancelReferencePreviews();this.modelTests.shutdown();await this.workspace.shutdown();await this.referencePreprocessor.close();await Promise.allSettled([...this.referenceDownloadTasks]);if(this.workspace.repository instanceof DraftRepository)await this.workspace.repository.close();await this.documents.releaseExcept(undefined);}
  assertReadyForUpdate(){
    if(this.inferences.size||this.modelTests.list().some(test=>test.status==='running')||this.workspace.project?.jobs.some(job=>['queued','preparing','running','post_processing'].includes(job.status)))throw new Error('请等待生成、推理或模型测试结束后再重启升级。');
  }
  private async rememberWorkspace() {
    const repo=this.workspace.repository as ProjectRepository;
    if(repo instanceof DraftRepository){this.currentRecordId=undefined;await this.documents.releaseExcept(undefined);return;}
    if(this.draft){await this.draft.close();this.draft=undefined;}
    await repo.consolidateOutputs(this.workspace.requireProject());
    this.currentRecordId=repo instanceof DocumentRepository?await this.documents.register(repo,this.workspace.requireProject().name,this.workspace.requireProject()):path.basename(repo.directory);
    if(this.hiddenRecords.delete(this.currentRecordId))await atomicJson(path.join(this.runtimeDirectory,'removed-workspaces.json'),[...this.hiddenRecords]);
    await atomicJson(path.join(this.runtimeDirectory,'active-workspace.json'),repo instanceof DocumentRepository?{file:repo.filename}:{directory:repo.directory});
    await this.documents.releaseExcept(repo);this.needsRegistration=false;
  }
  private async newWorkspace(name: string) {
    this.cancelReferencePreviews();
    this.workspace.assertSwitchable();await this.workspace.flush();
    const previous=this.workspace.repository;
    const repository=new DraftRepository(path.join(this.runtimeDirectory,'draft-cache'),this.projects.directory,this.documents.cacheRoot,repo=>{this.workspace.repository=repo;this.needsRegistration=true;});
    this.draft=repository;
    try{await this.workspace.create(repository,name);}catch(error){await repository.close();throw error;}
    await this.rememberWorkspace();
    if(previous instanceof DraftRepository)await previous.close();
    this.token = newId('session');
  }
  private async recentWorkspaces() {
    const legacy=(await this.projects.list(this.hiddenRecords)).map(record=>({...record,preview_url:record.cover_asset_id?`ediro-asset://asset/${record.cover_asset_id}?token=${this.token}&thumbnail=1&workspace=${record.id}`:undefined}));
    const documents=(await this.documents.list(this.hiddenRecords)).map(record=>({...record,preview_url:'cover_asset_id' in record&&record.cover_asset_id?`ediro-asset://asset/${record.cover_asset_id}?token=${this.token}&thumbnail=1&workspace=${record.id}`:undefined}));
    return [...legacy,...documents].sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
  }
  async refreshState() {
    await this.workspace.serial(async()=>{const w=this.window();if(!w.isDestroyed())w.webContents.send('ediro:state',await this.view());});
  }
  static async create(runtimeDirectory: string, window: () => BrowserWindow,options?:{showMessage?:(options:import('electron').MessageBoxOptions)=>Promise<{response:number}>;deferStartup?:boolean;projectRoot?:string}) {
    const file = path.join(runtimeDirectory, modelLibraryFilename);
    const configs = await openModelLibrary(runtimeDirectory);
    const preprocessing=new ReferencePreprocessor(runtimeDirectory);
    const executors=new ExecutionRegistry((bytes,settings,signal)=>preprocessing.process(bytes,settings,signal)).register(new MockGenerator()).register(new GeminiGenerator()).register(new ImagesGenerator()).register(new ChatCompletionsAdapter());
    const descriptions=executors.descriptions();
    descriptions.push({adapter_id:'local-pending',version:1,title:'本地引擎 · 待选型',kind:'local',installed:false,purposes:['generation'],requires_credential:false,supports_probe:false,interleaving:['native'],operations:[],parameters:[]});
    const library = new ModelLibrary(configs, data => atomicJson(file, data), new EncryptedSecretStore(path.join(runtimeDirectory, 'credentials')),descriptions);
    const testFile=path.join(runtimeDirectory,'model-tests.v1.json');let testRecords:ModelTestRecord[];
    try{testRecords=z.array(modelTestSchema).max(200).parse(JSON.parse(await readFile(testFile,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('模型测试记录无效，不会静默清除。');testRecords=[];}
    const modelTests=new ModelTests(testRecords,records=>atomicJson(testFile,records),executors,model=>library.credential(model));await modelTests.recover();
    const prompts=await loadPromptSettings(runtimeDirectory);
    const controller = new DesktopController(new Workspace(library, executors,new ModuleRegistry(undefined,prompts.config,prompts.customizations.roles),new MaskPixels(),2000), window, runtimeDirectory,executors,modelTests,options?.showMessage,options?.projectRoot,preprocessing);
    controller.promptCustomizations=prompts.customizations;
    controller.workspace.moduleSettings=await loadModuleSettings(runtimeDirectory);
    controller.workspace.generationTimings=await loadGenerationTimings(runtimeDirectory);
    await controller.documents.initialize();
    try{controller.hiddenRecords=new Set(z.array(z.string().regex(/^(work-[a-zA-Z0-9]{6}|file-[a-f0-9]{12})$/)).parse(JSON.parse(await readFile(path.join(runtimeDirectory,'removed-workspaces.json'),'utf8'))));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('已移除工作记录列表无效。');}
    await controller.projects.migrate(undefined,controller.hiddenRecords);
    await controller.newWorkspace('未命名工作');
    controller.workspace.onChange = async () => {
      const w = window(); if (!w.isDestroyed()) w.webContents.send('ediro:state', await controller.view());
    };
    if(!options?.deferStartup)await controller.showStartupNotices();
    return controller;
  }
  async showStartupNotices(){
    await this.offerRecovery();await this.workspace.onChange();
  }
  private async offerRecovery(){
    const candidates=await DocumentRepository.recoverable(this.documents.cacheRoot);
    for(const candidate of candidates){
      const choice=await this.showMessage({type:'warning',buttons:['稍后处理','恢复并另存为'],defaultId:1,cancelId:0,message:'发现上次未能写回工程的本地内容',detail:`原工程：${candidate.filename}\n恢复会创建新工程，原文件不会被覆盖。`});
      if(choice.response!==1)continue;
      const selected=await dialog.showSaveDialog(this.window(),{title:'恢复未保存内容',defaultPath:path.basename(candidate.filename,'.ediro')+'_恢复.ediro',filters:[{name:'Ediro 工程',extensions:['ediro']}]});
      if(selected.canceled||!selected.filePath)continue;
      try{
        const source=new ProjectRepository(candidate.directory),project=await source.load();
        const repo=await DocumentRepository.saveAs(source,project,selected.filePath,this.documents.cacheRoot);
        await this.workspace.open(repo);await this.rememberWorkspace();
        await atomicJson(path.join(candidate.directory,'recovery.json'),{filename:candidate.filename,dirty:false,recovered_to:repo.filename});
      }catch(error){await this.showMessage({type:'error',message:'恢复尚未完成，本地内容已保留。',detail:error instanceof Error?error.message:'请稍后重试。'});}
    }
  }
  async view(): Promise<WorkspaceView> {
    const workspace = this.workspace, project = workspace.project ? structuredClone(workspace.project) : null;
    const reference_models:NonNullable<WorkspaceView['reference_models']>=await localImageModelStatus(this.runtimeDirectory);
    for(const kind of this.referenceDownloads.keys())reference_models[kind]='downloading';
    let chain = null, adaptation = null, adaptation_error;
    if (project) {
      try { const plan=planExecution(project.recipe,project.assets,workspace.models.resolve(project.recipe.model_config_id),workspace.registry);chain=plan.chain;adaptation=plan.adapted; }
      catch (e) { adaptation_error = e instanceof Error ? e.message : '配方无法编译'; }
    }
    let auto_prompt:WorkspaceView['auto_prompt'];
    if(project)try{auto_prompt=getAutoPromptState(project.recipe,workspace.registry,workspace.moduleSettings,project.assets);}
    catch(error){adaptation_error??=error instanceof Error?error.message:'自动提示词条件无法读取。';}
    return { project,prompt_customizations:structuredClone(this.promptCustomizations),generation_timings:structuredClone(Object.fromEntries(workspace.generationTimingByTask)),reference_models,module_settings:structuredClone(workspace.moduleSettings),auto_prompt,prompt_config:structuredClone(workspace.registry.promptConfig), models: await workspace.models.list(),model_tests:this.modelTests.list(),connections:await workspace.models.connections(),adapters:workspace.models.adapters,assignments:workspace.models.effectiveAssignments(), module_definitions: workspace.registry.list(), chain, adaptation, adaptation_error,
      project_location: workspace.repository instanceof DraftRepository?null:workspace.repository instanceof DocumentRepository?workspace.repository.filename:workspace.repository?.directory ?? null,
      project_record_id:this.currentRecordId,project_format:workspace.repository instanceof DraftRepository?'draft':workspace.repository instanceof DocumentRepository?'ediro':'legacy',project_storage_version:workspace.repository instanceof DocumentRepository?workspace.repository.storageVersion:undefined,save_state:workspace.saveState,save_error:workspace.saveError,
      recent_workspaces: await this.recentWorkspaces(),
      assets: await Promise.all((project?.assets ?? []).map(async a => ({ ...a, source_status: await (workspace.repository as ProjectRepository).sourceStatus(a), preview_url: `ediro-asset://asset/${a.asset_id}?token=${this.token}&thumbnail=1`, original_url: `ediro-asset://asset/${a.asset_id}?token=${this.token}` }))) };
  }
  async assetPath(urlString: string) {
    const url = new URL(urlString);
    if (url.hostname !== 'asset' || url.searchParams.get('token') !== this.token) throw new Error('素材访问未授权。');
    const id = url.pathname.slice(1);
    const recordId=url.searchParams.get('workspace');
    if(recordId){if(url.searchParams.get('thumbnail')!=='1'||this.hiddenRecords.has(recordId))throw new Error('只能读取项目封面。');return recordId.startsWith('file-')?this.documents.cover(recordId,id):this.projects.cover(recordId,id);}
    const asset = this.workspace.project?.assets.find(a => a.asset_id === id);
    if (!asset || !this.workspace.repository) throw new Error('素材不存在。');
    return (this.workspace.repository as ProjectRepository).resolveAssetPath(asset, url.searchParams.get('thumbnail') === '1');
  }
  async execute(raw: unknown): Promise<ApiResponse> {
    try {
      // Validate at the privileged boundary; never trust renderer objects.
      const command = commandSchema.parse(raw);
      if(command.type==='reference:cancel-preview'){this.referencePreviews.get(command.request_id)?.abort();return {ok:true};}
      if(['project:create','project:open','workspace:resume','workspace:remove'].includes(command.type))this.cancelReferencePreviews();
      if(command.type==='reference-model:prepare'){
        if(this.referenceDownloads.has(command.kind))return {ok:true};
        const download=new AbortController();this.referenceDownloads.set(command.kind,download);
        const operation=(async()=>{
          await this.refreshState();
          await prepareLocalImageModel(this.runtimeDirectory,command.kind,download.signal);
        })();
        this.referenceDownloadTasks.add(operation);
        try{await operation;}finally{this.referenceDownloadTasks.delete(operation);this.referenceDownloads.delete(command.kind);if(!download.signal.aborted)await this.refreshState();}
        return {ok:true};
      }
      if(command.type==='reference:preview'){
        if(this.referencePreviews.has(command.request_id))throw new Error('预览请求编号重复，请重新预览。');
        const preview=new AbortController();this.referencePreviews.set(command.request_id,preview);
        try{
        const input=await this.workspace.serial(async()=>{
          if(preview.signal.aborted)throw new Error('预览已取消。');
          const project=this.workspace.requireProject();
          if(project.project_id!==command.project_id)throw new Error('工作记录已切换，请重新打开模块。');
          const module=project.recipe.modules.find(module=>(!command.module_id||module.module_id===command.module_id)&&module.reference_type===command.reference_type&&module.asset_ids.includes(command.asset_id));
          if(!module)throw new Error('参考图已从当前模块移除。');
          const asset=project.assets.find(asset=>asset.asset_id===command.asset_id);
          if(!asset)throw new Error('参考图不存在。');
          return {bytes:await this.workspace.repository!.readAsset(asset),settings:structuredClone(command.settings??module.reference_settings??this.workspace.moduleSettings[command.reference_type])};
        });
        const clear=await resizeReferenceImage(input.bytes,input.settings.max_edge);
        const result=await this.referencePreprocessor.process(clear,input.settings,preview.signal);
        const {format}=await sharp(result).metadata();
        if(preview.signal.aborted)throw new Error('预览已取消。');
        return {ok:true,reference_preview:`data:image/${format};base64,${result.toString('base64')}`};
        }finally{if(this.referencePreviews.get(command.request_id)===preview)this.referencePreviews.delete(command.request_id);}
      }
      if(command.type==='module:cancel-inference'){this.inferences.get(command.request_id)?.abort();return {ok:true};}
      if(command.type==='module:infer'){
        if(this.inferences.size)throw new Error('已有模块推理正在运行，请等待或取消。');
        const controller=new AbortController();this.inferences.set(command.request_id,controller);
        try{
          const prepared=await this.workspace.serial(async()=>{
            if(controller.signal.aborted)throw new Error('推理已取消。');
            const project=this.workspace.requireProject();if(project.project_id!==command.project_id)throw new Error('工作记录已切换，请重新打开编辑窗口。');
            await this.workspace.flush();
            const model=structuredClone(await this.workspace.models.execution(command.model_config_id));
            const automatic=command.automatic?getAutoPromptState(project.recipe,this.workspace.registry,this.workspace.moduleSettings,project.assets):undefined;
            if(command.automatic&&automatic?.module_id!==command.module_id)throw new Error('当前模块不是已启用的自动提示词目标。');
            const originalText=project.recipe.modules.find(module=>module.module_id===command.module_id)?.user_instruction;
            if(command.automatic&&command.text!==originalText)throw new Error('当前提示词文字已变化，请重新开始自动推理。');
            const plan=prepareModuleInference(project.recipe,command.module_id,command.text,model,this.workspace.registry,command.allow_text_only,this.workspace.moduleSettings,{automatic:command.automatic,promptRole:command.prompt_role});
            const repository=this.workspace.repository!,assets=structuredClone(project.assets);
            const ids=new Set(plan.job.adapted_input.blocks?.filter(b=>b.type==='image').map(b=>b.asset_id)??plan.job.adapted_input.image_asset_ids??[]);
            return {plan,project,automatic,originalText,context:{model,job:plan.job,readImage:async(id:string)=>{const asset=assets.find(a=>a.asset_id===id);if(!ids.has(id)||!asset)throw new Error('推理请求不能读取上下文之外的素材。');return repository.readAsset(asset);},resolveCredential:()=>this.workspace.models.credential(model)}};
          });
          const suggestion=await executeModuleInference(this.executors,prepared.context,prepared.plan,controller.signal);
          if(prepared.automatic)return await this.workspace.serial(async()=>{
            if(controller.signal.aborted)throw new Error('推理已取消，原文未修改。');
            const project=this.workspace.requireProject();
            if(project!==prepared.project||project.project_id!==command.project_id)throw new Error('工作记录已切换，推理结果未写入。');
            const current=getAutoPromptState(project.recipe,this.workspace.registry,this.workspace.moduleSettings,project.assets);
            if(current?.module_id!==command.module_id)throw new Error('自动提示词目标已改变，原文未修改。');
            const previous=project.recipe;
            project.recipe=applyAutomaticPromptSuggestion(previous,command.module_id,prepared.originalText!,prepared.automatic!.input_key,suggestion.text);
            try{await this.workspace.persist();}catch(error){project.recipe=previous;throw error;}
            return {ok:true,suggestion,state:await this.view()};
          });
          return {ok:true,suggestion};
        }finally{this.inferences.delete(command.request_id);}
      }
      if(command.type==='model:test'){
        const model=await this.workspace.serial(()=>this.workspace.models.execution(command.model_config_id));
        await this.modelTests.run(model);
        return this.workspace.serial(async()=>({ok:true,state:await this.view()}));
      }
      return await this.workspace.serial(async () => {
        const w = this.window();
        let selected_asset_id:string|undefined;
        switch (command.type) {
          case 'prompt-customizations:save':{
            const prompts=await savePromptCustomizations(this.runtimeDirectory,command.customizations);
            // Enqueued jobs and in-flight inference already own their snapshots.
            this.workspace.registry=new ModuleRegistry(undefined,prompts.config,prompts.customizations.roles);
            this.promptCustomizations=prompts.customizations;
            if(this.workspace.project)this.workspace.project.recipe=this.workspace.registry.resolveRecipe(this.workspace.project.recipe);
            break;
          }
          case 'prompt-customizations:import':{
            const selected=await dialog.showOpenDialog(w,{title:'导入自定义指令',properties:['openFile'],filters:[{name:'Ediro 自定义指令',extensions:['json']}]});
            if(selected.canceled||!selected.filePaths[0])return {ok:true,cancelled:true};
            return {ok:true,prompt_customizations:await importPromptCustomizations(selected.filePaths[0])};
          }
          case 'prompt-customizations:export':{
            const selected=await dialog.showSaveDialog(w,{title:'导出自定义指令',defaultPath:'Ediro-自定义指令.json',filters:[{name:'Ediro 自定义指令',extensions:['json']}],properties:['showOverwriteConfirmation']});
            if(selected.canceled||!selected.filePath)return {ok:true,cancelled:true};
            await exportPromptCustomizations(selected.filePath,command.customizations);
            return {ok:true};
          }
          case 'module-settings:save':this.workspace.moduleSettings=await saveModuleSettings(this.runtimeDirectory,command.settings);break;
          case 'mask:save-composite':await this.workspace.saveCompositeMask(command.project_id,command.task_id,command.strokes);break;
          case 'mask:save-draft':await this.workspace.saveMaskDraft(command.project_id,command.draft);break;
          case 'mask:preview':return {ok:true,mask_preview:await this.workspace.previewMask(command.project_id,command.task_id,command.mode,command.feather,command.composite_strokes)};
          case 'mask:start':await this.workspace.enqueueMask(command.project_id,command.draft);break;
          case 'mask:reprocess':{const selected_asset_id=await this.workspace.reprocessMask(command.project_id,command.task_id,command.mode,command.feather,command.composite_strokes);return {ok:true,state:await this.view(),selected_asset_id};}
          case 'job:model-input':{
            if(!this.workspace.requireProject().jobs.some(j=>j.task_id===command.task_id))throw new Error('任务不存在。');
            return {ok:true,model_input:await this.workspace.repository!.loadModelInput(command.task_id)};
          }
          case 'model:accept-test':await this.workspace.models.acceptTest(this.modelTests.successful(command.test_id));break;
          case 'job:recover-result':await this.workspace.recoverResult(command.task_id);break;
          case 'connection:save':await this.workspace.models.saveConnection(command.connection,command.secret,command.clear_credential);break;
          case 'connection:delete':await this.workspace.models.deleteConnection(command.connection_id);break;
          case 'model:save':await this.workspace.models.saveModel(command.model);break;
          case 'model:delete':await this.workspace.models.deleteModel(command.model_config_id);break;
          case 'model:assign':await this.workspace.models.assign(command.purpose,command.model_config_id);break;
          case 'connection:probe':{
            const c=this.workspace.models.snapshot().connections.find(c=>c.connection_id===command.connection_id);
            if(!c||!c.enabled||!c.credential_ref)throw new Error('请先保存并启用连接，配置 API Key。');
            const key=await this.workspace.models.credential(c);
            const discovered_models=await this.executors.probe(command.adapter_id,c.endpoint,key,AbortSignal.timeout(30_000));
            return {ok:true,state:await this.view(),discovered_models};
          }
          case 'asset:hide':await this.workspace.hideMaterial(command.asset_id);break;
          case 'result:trash':{
            const embedded=this.workspace.repository instanceof DocumentRepository;
            const confirmation=await this.showMessage({type:'warning',buttons:['取消',embedded?'移除结果':'移到回收站'],defaultId:0,cancelId:0,message:embedded?'从结果列表移除此版本？':'将此生成结果及其恢复记录移到回收站？',detail:embedded?'工程内保留历史图片和模块引用，不删除已导出的图片。':'模块内的引用保留；引用此结果的位置会标记图片缺失。其他版本和源素材不受影响。'});
            if(confirmation.response!==1)return {ok:true,cancelled:true};
            await (this.workspace.repository as ProjectRepository).trashResult(this.workspace.requireProject(),command.asset_id,filename=>shell.trashItem(filename));break;
          }
          case 'workspace:rename':{
            if(this.hiddenRecords.has(command.id))throw new Error('项目记录已移除。');
            if(this.currentRecordId===command.id){
              const project=this.workspace.requireProject(),previous=project.name;project.name=command.name;
              try{await this.workspace.persist();await this.rememberWorkspace();}catch(e){project.name=previous;throw e;}
            }else if(command.id.startsWith('file-'))await this.documents.rename(command.id,command.name);else await this.projects.rename(command.id,command.name);
            break;
          }
          case 'workspace:remove':{
            this.workspace.assertSwitchable();if(this.inferences.size)throw new Error('请先等待或取消当前模块分析，再删除项目。');
            const records=await this.recentWorkspaces(),record=records.find(r=>r.id===command.id);if(!record)throw new Error('工作记录不存在。');
            const document=command.id.startsWith('file-'),current=this.currentRecordId===command.id;
            const resolveTarget=()=>document?this.documents.trashTarget(command.id):this.projects.trashTarget(command.id);
            const target=await resolveTarget();
            const confirmation=await this.showMessage({type:'warning',buttons:['取消',target.missing?'清理记录':'移到回收站'],defaultId:0,cancelId:0,
              message:target.missing?`「${record.title}」的工程文件已不存在，清理此记录？`:`将项目「${record.title}」移到系统回收站？`,
              detail:`${target.filename}\n\n${target.missing?'不会删除其他文件。':document?'将移动这个 .ediro 文件及其中的素材、结果和历史。导出的图片和其他工程保留，可从系统回收站还原。':'将移动这个旧项目文件夹。外部素材、input、output 和迁移备份保留，可从系统回收站还原。'}${current?'\n当前编辑会先保存，随后切换到新工作。':''}`});
            if(confirmation.response!==1)return {ok:true,cancelled:true};
            const previous=new Set(this.hiddenRecords),originalRepository=this.workspace.repository;let hidden=false;
            try{
              if(current)await this.newWorkspace('未命名工作');
              if(document)await this.documents.release(command.id);
              // Validate again after the confirmation and project switch.
              const checked=await resolveTarget();
              const next=new Set(previous);next.add(command.id);
              await atomicJson(path.join(this.runtimeDirectory,'removed-workspaces.json'),[...next]);this.hiddenRecords=next;hidden=true;
              if(!checked.missing)await shell.trashItem(checked.filename);
            }catch(error){
              let recoveryError='';
              if(hidden){this.hiddenRecords=previous;try{await atomicJson(path.join(this.runtimeDirectory,'removed-workspaces.json'),[...previous]);}catch{recoveryError='项目入口恢复失败，请通过“打开工程”重新打开。';}}
              if(current&&this.workspace.repository!==originalRepository){try{await this.workspace.open(document?await this.documents.forId(command.id):this.projects.forId(command.id));await this.rememberWorkspace();this.token=newId('session');}catch{recoveryError+='当前工作未能切回，请通过“打开工程”重新打开。';}}
              return {ok:false,error:`删除未完成：${error instanceof Error?error.message:'回收站操作失败。'}${recoveryError}`,state:await this.view()};
            }
            if(document)await this.documents.discardDeletedCache(command.id);
            break;
          }
          case 'output:folder':await mkdir(this.outputDirectory,{recursive:true});{const error=await shell.openPath(this.outputDirectory);if(error)throw new Error(error);}break;
          case 'output:open':{
            const selected=await dialog.showOpenDialog(w,{title:'从产出恢复工作',defaultPath:this.outputDirectory,properties:['openFile'],filters:[{name:'Ediro 生成图片',extensions:['png','jpeg','jpg','webp']}]});
            if(selected.canceled)return {ok:true,cancelled:true};selected_asset_id=await this.recover(selected.filePaths[0]);if(!selected_asset_id)return {ok:true,cancelled:true};break;
          }
          case 'state': break;
          case 'project:save':await this.workspace.flush();break;
          case 'project:create': {
            await this.newWorkspace(command.name); break;
          }
          case 'project:open': {
            const selected = await dialog.showOpenDialog(w, { title: '打开工程', properties: ['openFile'], filters: [{ name: 'Ediro 工程', extensions: ['ediro'] },{name:'旧目录工程',extensions:['json']}] });
            if (selected.canceled) return { ok: true, cancelled: true };
            await this.openProjectFile(selected.filePaths[0]);break;
          }
          case 'workspace:resume': {
            if(this.hiddenRecords.has(command.id))throw new Error('此工作记录已移除，请从产出恢复。');
            await this.workspace.open(command.id.startsWith('file-')?await this.documents.forId(command.id):this.projects.forId(command.id));
            await this.rememberWorkspace(); this.token=newId('session'); break;
          }
          case 'recipe:save': await this.workspace.saveRecipe(command.recipe); break;
          case 'recipe:select-model': await this.workspace.selectModel(command.model_config_id);break;
          case 'recipe:reset-parameters': await this.workspace.resetParameters();break;
          case 'module:add': await this.workspace.addModule(command.reference_type, command.before_module_id); break;
          case 'module:copy': await this.workspace.copyModule(command.module_id); break;
          case 'module:reference-type': await this.workspace.changeReferenceType(command.module_id,command.reference_type); break;
          case 'module:tool': await this.workspace.saveToolReference(command.module_id,Buffer.from(command.png_base64,'base64'),command.state,command.instruction); break;
          case 'assets:drop': selected_asset_id=await this.importOrRecover(command.paths,command.module_id); break;
          case 'asset:relink': {
            const selected = await dialog.showOpenDialog(w,{title:'重新定位同一份源图片',properties:['openFile'],filters:[{name:'图片',extensions:['png','jpg','jpeg','webp']}]});
            if(selected.canceled)return {ok:true,cancelled:true};
            await this.workspace.relinkAsset(command.asset_id,selected.filePaths[0]); break;
          }
          case 'project:package': {
            this.workspace.assertSwitchable();
            const name=this.workspace.requireProject().name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
            const selected=await dialog.showSaveDialog(w,{title:'工程另存为 · 保存后切换到目标工程',defaultPath:`${name}.ediro`,filters:[{name:'Ediro 工程',extensions:['ediro']}],properties:['showOverwriteConfirmation']});
            if(selected.canceled||!selected.filePath)return {ok:true,cancelled:true};
            const source=this.workspace.repository as ProjectRepository;
            if(source instanceof DocumentRepository&&await sameDocumentFile(source.filename,selected.filePath)){
              await this.workspace.persist();await this.rememberWorkspace();break;
            }
            // A successful native Save dialog includes confirmation for an
            // existing target. Capture it now and reject later intervening writes.
            const overwrite=await inspectDocumentTarget(selected.filePath);
            // Save As also rescues in-memory edits if the old document is unwritable.
            const repo=await DocumentRepository.saveAs(source,this.workspace.requireProject(),selected.filePath,this.documents.cacheRoot,{overwrite});
            this.workspace.acceptSavedCopy();await this.workspace.open(repo);await this.rememberWorkspace();this.token=newId('session');
            await this.workspace.onChange();
            const saved=await this.showMessage({message:'保存成功',detail:`${overwrite?'已覆盖保存并切换到目标工程。':'已另存为并切换到新工程。'}\n${repo.filename}`,buttons:['打开目录','知道了'],defaultId:1,cancelId:1});
            if(saved.response===0)shell.showItemInFolder(repo.filename);break;
          }
          case 'assets:import': {
            this.workspace.requireProject();
            const selected = await dialog.showOpenDialog(w, { title: '导入参考图片 · 保持选择顺序', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png','jpg','jpeg','webp'] }] });
            if (selected.canceled) return { ok: true, cancelled: true };
            selected_asset_id=await this.importOrRecover(selected.filePaths, command.module_id); break;
          }
          case 'model:update': await this.workspace.models.update(command.model_config_id, { title: command.title, endpoint: command.endpoint, enabled: command.enabled }, command.secret); break;
          case 'job:retry':await this.workspace.retry(command.project_id,command.task_id);break;
          case 'job:start': await this.workspace.enqueue(command.allow_degradation); break;
          case 'job:cancel': await this.workspace.cancel(command.task_id); break;
          case 'job:restore': await this.workspace.restore(command.task_id); break;
          case 'job:restore-recipe': await this.workspace.restoreTaskRecipe(command.project_id,command.task_id); break;
          case 'job:hide-result': await this.workspace.hideTaskResult(command.project_id,command.task_id); break;
          case 'result:restore': await this.workspace.restoreResult(command.project_id,command.asset_id); break;
          case 'asset:export': {
            const p = this.workspace.requireProject(), asset = p.assets.find(a => a.asset_id === command.asset_id);
            if (!asset) throw new Error('素材不存在。');
            const ext = asset.mime_type.split('/')[1];
            const selected = await dialog.showSaveDialog(w, { title: '导出图片', defaultPath: path.join(this.outputDirectory,asset.kind==='output'?outputFilename(asset):asset.name), filters: [{ name: '图片', extensions: [ext] }] });
            if (selected.canceled || !selected.filePath) return { ok: true, cancelled: true };
            const resolved = path.resolve(selected.filePath);
            const projectRoot = path.resolve(this.workspace.repository!.directory);
            if (resolved === projectRoot || resolved.startsWith(`${projectRoot}${path.sep}`)) throw new Error('请导出到项目目录之外，避免覆盖工程数据。');
            await this.workspace.flush();
            const repository=this.workspace.repository as ProjectRepository;
            await repository.export(asset, selected.filePath);
            if(repository instanceof DocumentRepository&&asset.kind==='output')await this.documents.recordExport(repository,p,asset.asset_id,selected.filePath);
            break;
          }
        }
        if(this.needsRegistration)await this.rememberWorkspace();
        return { ok: true, state: await this.view(),...(selected_asset_id?{selected_asset_id}:{}) };
      });
    } catch (e) {
      // Never stringify command payloads: they may contain a transient API Key.
      const message = e instanceof z.ZodError ? e.issues.map(issue => issue.message).join('；') : e instanceof Error ? e.message : '操作失败';
      return { ok: false, error: message };
    }
  }
  private async recover(filename:string,known?:DocumentOutputMatch[]):Promise<string|undefined>{
    this.cancelReferencePreviews();
    this.workspace.assertSwitchable();await this.workspace.flush();
    const matches=known??await this.documents.findOutputs(filename,this.hiddenRecords);
    if(matches.length){
      let selected=matches[0];
      if(matches.length>1){
        const choice=await this.showMessage({type:'question',message:'找到多个来源版本，请选择要恢复的版本',buttons:['取消',...matches.map(m=>`${m.title} · ${m.name} · ${m.filename}`)],cancelId:0,defaultId:0});
        if(!choice.response)return;selected=matches[choice.response-1];if(!selected)return;
      }
      const target=path.join(this.projects.directory,`恢复工程_${newId('file').slice(5)}.ediro`);
      const repo=await this.documents.recoverOutput(selected,filename,target);
      try{await this.workspace.open(repo);await this.workspace.restoreResult(this.workspace.requireProject().project_id,selected.asset_id);await this.workspace.flush();}
      catch(error){if(this.workspace.repository!==repo)await repo.close();throw error;}
      await this.rememberWorkspace();this.token=newId('session');return selected.asset_id;
    }
    const directory=await this.projects.createDirectory(),repository=this.repository(directory);
    const project=await repository.recoverOutput(path.resolve(filename));await this.workspace.open(repository);await this.rememberWorkspace();this.token=newId('session');
    return project.jobs[0]?.output_asset_ids.find(id=>project.assets.some(a=>a.asset_id===id&&a.location.type==='external'&&path.resolve(a.location.path)===path.resolve(filename)))??project.jobs[0]?.output_asset_ids[0];
  }
  private async importOrRecover(paths:string[],moduleId?:string){
    if(paths.some(filename=>path.extname(filename).toLowerCase()==='.ediro')){
      if(paths.length!==1)throw new Error('请一次拖入一个工程文件，不要与图片混合拖入。');
      await this.openProjectFile(paths[0]);return;
    }
    if(!moduleId&&paths.length===1){
      await this.workspace.flush();
      const matches=await this.documents.findOutputs(paths[0],this.hiddenRecords);
      const sidecar=matches.length||await this.projects.records.find(paths[0])||await (this.workspace.repository as ProjectRepository).findOutputRecord(paths[0]);
      if(sidecar){const choice=await this.showMessage({type:'question',buttons:['取消','仅作为素材','恢复工作'],defaultId:1,cancelId:0,message:'找到这张图片的 Ediro 产出记录',detail:'恢复工作会在新工程中打开这一版的参数和创作模块；仅作为素材则加入当前工作。'});if(choice.response===0)return;if(choice.response===2)return this.recover(paths[0],matches);}
    }
    await this.workspace.importFiles(paths,moduleId);
  }
  openRepository(directory:string){return path.dirname(path.resolve(directory))===path.resolve(this.projects.directory)?this.repository(directory):new ProjectRepository(directory);}
  async openProjectFile(filename:string){
    this.cancelReferencePreviews();
    this.workspace.assertSwitchable();await this.workspace.flush();
    if(path.extname(filename).toLowerCase()==='.ediro'){
      const {repo}=await this.documents.openFile(filename);
      if(repo!==this.workspace.repository)await this.workspace.open(repo);
    }else{
      if(path.basename(filename)!==projectFilename)throw new Error(`请选择 .ediro 工程或 ${projectFilename}。`);
      const source=this.openRepository(path.dirname(filename)),project=await source.load();
      const directory=await this.projects.createDirectory();await source.forkWorkspace(project,directory,this.repository(directory));
      await this.workspace.open(this.repository(directory));
    }
    await this.rememberWorkspace();this.token=newId('session');
  }
}
