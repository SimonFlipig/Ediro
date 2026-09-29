// Developer UI verification host. No real credentials, remote API or
// arbitrary file selection are exposed. All recipe/task logic uses core.
import http from 'node:http';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { Workspace } from '../dist-host/core/workspace.js';
import { ModelLibrary, seedModels } from '../dist-host/core/models.js';
import { ProjectRepository } from '../dist-host/adapters/project-repository.js';
import { ProjectLibrary } from '../dist-host/adapters/project-library.js';
import { MaskPixels } from '../dist-host/adapters/mask-pixels.js';
import { MockGenerator } from '../dist-host/adapters/mock-generator.js';
import { GeminiGenerator } from '../dist-host/adapters/gemini-generator.js';
import { ImagesGenerator } from '../dist-host/adapters/images-generator.js';
import { mockDescription } from '../dist-host/core/model-library.js';
import { planExecution } from '../dist-host/core/execution-plan.js';
import { prepareModuleInference,executeModuleInference } from '../dist-host/core/module-inference.js';
import { commandSchema } from '../dist-host/shared/commands.js';
import { modelCatalog } from '../dist-host/protocols/model-catalog.js';
import { createPreviewFixtures } from './preview-fixtures.mjs';

const port=Number(process.env.EDIRO_PREVIEW_PORT??5191);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('验证端口无效。');
const origin=`http://127.0.0.1:${port}`,token=randomUUID();
const pages=new Set();
let closeTimer,stopping=false;
async function shutdown(){
  if(stopping)return;stopping=true;clearTimeout(closeTimer);
  const deadline=setTimeout(()=>process.exit(1),5000);
  for(const page of pages)page.end();
  try{await workspace.shutdown();server.close();server.closeAllConnections();clearTimeout(deadline);console.log('验证界面已关闭，后台进程退出。');}
  catch(error){console.error(error);process.exit(1);}
}
const guidedPreview={...seedModels()[0],model_config_id:'model_preview_guided_mask',title:'模拟黑白区域图编辑 · 不调用云端',adapter_id:'mock-guided-mask',generation_contract:seedModels()[2].generation_contract,defaults:seedModels()[2].defaults,capabilities:{...seedModels()[2].capabilities,operations:['generate','referenceEdit','guidedMaskEdit']}};
const guidedPreviewAdapter={...mockDescription,adapter_id:'mock-guided-mask',title:'模拟黑白区域图编辑',generation_contract:guidedPreview.generation_contract,operations:guidedPreview.capabilities.operations};
const modelLibrary=new ModelLibrary([...seedModels(),guidedPreview,{...seedModels()[0],model_config_id:'model_preview_understanding',title:'模拟理解模型 · 不调用云端',purpose:'understanding',capabilities:{...seedModels()[0].capabilities,operations:['understand']}},{...seedModels()[0],model_config_id:'model_preview_text_only',title:'模拟纯文字模型 · 不调用云端',purpose:'understanding',capabilities:{...seedModels()[0].capabilities,max_images:0,operations:['understand']}}],async()=>{}, {has:async()=>false,set:async()=>{throw new Error('浏览器验证宿主禁止保存凭据。');}},[guidedPreviewAdapter,{...mockDescription,purposes:['generation','understanding'],operations:['generate','nativeMaskEdit','understand']},{...new GeminiGenerator().description,installed:false},
{...new ImagesGenerator().description,installed:false},
{adapter_id:'local-pending',version:1,title:'本地引擎 · 待选型',kind:'local',installed:false,purposes:['generation'],requires_credential:false,supports_probe:false,interleaving:['native'],operations:[],parameters:[]}]);
const workspace=new Workspace(modelLibrary,new MockGenerator(350),undefined,new MaskPixels());
let projectFile;
try { projectFile=(await readFile('.local/preview-v2-project-path.txt','utf8')).trim(); }
catch(e) { if(e.code!=='ENOENT')throw e;projectFile=await createPreviewFixtures(); }
const demoRoot=path.resolve('.local/demo-projects');
if(!path.resolve(projectFile).startsWith(`${demoRoot}${path.sep}`))throw new Error('验证项目必须位于 .local/demo-projects 内。');
const projectLibrary=new ProjectLibrary(path.resolve('.local/preview-storage'));
const previewSource=new ProjectRepository(path.dirname(projectFile)),previewDirectory=await projectLibrary.createDirectory();
await previewSource.forkWorkspace(await previewSource.load(),previewDirectory,projectLibrary.repository(previewDirectory));
await workspace.open(projectLibrary.repository(previewDirectory));
const hiddenRecords=new Set();
const historyCount=Math.min(60,Math.max(0,Number(process.env.EDIRO_PREVIEW_HISTORY_COUNT??0)));
for(let i=0;i<historyCount;i++){
  const directory=await projectLibrary.createDirectory(),project=structuredClone(workspace.project);
  project.project_id=`project_preview_${i}`;project.name=`预览项目 ${String(i+1).padStart(2,'0')} · 产品设计`;
  project.updated_at=new Date(Date.now()-(i+1)*86400000).toISOString();
  await workspace.repository.forkWorkspace(project,directory,projectLibrary.repository(directory));
}
async function view(){
  const project=workspace.project?structuredClone(workspace.project):null;
  let chain=null,adaptation=null,adaptation_error;
  if(project)try{const plan=planExecution(project.recipe,project.assets,workspace.models.resolve(project.recipe.model_config_id),workspace.registry);chain=plan.chain;adaptation=plan.adapted;}catch(e){adaptation_error=e.message;}
  return {project,models:await modelLibrary.list(),connections:await modelLibrary.connections(),adapters:modelLibrary.adapters,assignments:modelLibrary.snapshot().assignments,module_definitions:workspace.registry.list(),chain,adaptation,adaptation_error,project_location:workspace.repository.directory,
    recent_workspaces:(await projectLibrary.list(hiddenRecords)).map(record=>({...record,preview_url:record.cover_asset_id?`/preview-project-cover/${record.id}/${record.cover_asset_id}`:undefined})),
    assets:await Promise.all((project?.assets??[]).map(async a=>({...a,source_status:await workspace.repository.sourceStatus(a),preview_url:`/preview-assets/${a.asset_id}?thumbnail=1`,original_url:`/preview-assets/${a.asset_id}`})))};
}
function json(response,status,data){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(data));}
const server=http.createServer(async(request,response)=>{
  try{
    if(request.headers.host!==`127.0.0.1:${port}`||(request.headers.origin&&request.headers.origin!==origin)){json(response,403,{ok:false,error:'Origin rejected'});return;}
    const url=new URL(request.url,origin);
    if(url.pathname==='/preview-lifecycle'&&request.method==='GET'){
      if(url.searchParams.get('token')!==token||stopping){json(response,403,{ok:false});return;}
      clearTimeout(closeTimer);pages.add(response);
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
      response.write('data: connected\n\n');
      const heartbeat=setInterval(()=>response.write(': alive\n\n'),1000);
      response.on('close',()=>{clearInterval(heartbeat);pages.delete(response);if(!pages.size&&!stopping)closeTimer=setTimeout(()=>void shutdown(),2500);});
      return;
    }
    if(url.pathname==='/preview-session'&&request.method==='GET'){json(response,200,{token});return;}
    if(url.pathname==='/preview-command'&&request.method==='POST'){
      if(request.headers['x-ediro-preview']!==token){json(response,403,{ok:false,error:'Preview session required'});return;}
      const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>4*1024*1024)throw new Error('验证请求过大。');chunks.push(chunk);}
      const command=commandSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const result=await workspace.serial(async()=>{
        switch(command.type){
          case 'mask:save-composite':await workspace.saveCompositeMask(command.project_id,command.task_id,command.strokes);break;
          case 'mask:save-draft':await workspace.saveMaskDraft(command.project_id,command.draft);break;
          case 'mask:preview':return {ok:true,mask_preview:await workspace.previewMask(command.project_id,command.task_id,command.mode,command.feather,command.composite_strokes)};
          case 'mask:start':if(modelLibrary.resolve(command.draft.model_config_id).kind!=='mock')throw new Error('验证模式只允许模拟编辑。');await workspace.enqueueMask(command.project_id,command.draft);break;
          case 'mask:reprocess':{const selected_asset_id=await workspace.reprocessMask(command.project_id,command.task_id,command.mode,command.feather,command.composite_strokes);return {ok:true,state:await view(),selected_asset_id};}
          case 'module:infer':{
            if(!['model_preview_understanding','model_preview_text_only'].includes(command.model_config_id))throw new Error('验证界面仅支持模拟推理，不调用云端。');
            const project=workspace.requireProject();if(project.project_id!==command.project_id)throw new Error('工作记录已切换。');
            const model=await modelLibrary.execution(command.model_config_id),plan=prepareModuleInference(project.recipe,command.module_id,command.text,model,workspace.registry,command.allow_text_only);
            const suggestion=await executeModuleInference({execute:async()=>({images:[],text:[command.text,'这是用于验证采用与保存流程的模拟建议，未分析真实图片。'].filter(Boolean).join('\n')})},{model,job:plan.job,readImage:async()=>{throw new Error('模拟推理不读取图片。');},resolveCredential:async()=>{throw new Error('模拟推理不读取凭据。');}},plan,new AbortController().signal);
            suggestion.model_title='模拟建议 · 未调用真实模型';return {ok:true,suggestion};
          }
          case 'module:cancel-inference':return {ok:true};
          case 'job:model-input':{
            if(!workspace.requireProject().jobs.some(j=>j.task_id===command.task_id))throw new Error('任务不存在。');
            return {ok:true,model_input:await workspace.repository.loadModelInput(command.task_id)};
          }
          case 'connection:save':if(command.secret)throw new Error('浏览器验证宿主禁止保存凭据。');await modelLibrary.saveConnection(command.connection,undefined,command.clear_credential);break;
          case 'connection:delete':await modelLibrary.deleteConnection(command.connection_id);break;
          case 'model:save':await modelLibrary.saveModel(command.model);break;
          case 'connection:probe':return {ok:true,state:await view(),discovered_models:[...modelCatalog.filter(p=>p.config.adapter_id===command.adapter_id).map(p=>p.aliases[0]),'custom-model-alias']};
          case 'model:delete':await modelLibrary.deleteModel(command.model_config_id);break;
          case 'model:assign':if(command.purpose==='generation'&&modelLibrary.resolve(command.model_config_id).kind!=='mock')throw new Error('浏览器验证默认生图只能选择模拟引擎。');await modelLibrary.assign(command.purpose,command.model_config_id);break;
          case 'job:recover-result':await workspace.recoverResult(command.task_id);break;
          case 'state':break;
          case 'project:create':{const directory=await projectLibrary.createDirectory();await workspace.create(projectLibrary.repository(directory),command.name);break;}
          case 'workspace:resume':{if(hiddenRecords.has(command.id))throw new Error('验证记录不存在');await workspace.open(projectLibrary.forId(command.id));break;}
          case 'workspace:rename':{await projectLibrary.rename(command.id,command.name);if(path.basename(workspace.repository.directory)===command.id)workspace.project.name=command.name;break;}
          case 'workspace:remove':{hiddenRecords.add(command.id);if(path.basename(workspace.repository.directory)===command.id){const directory=await projectLibrary.createDirectory();await workspace.create(projectLibrary.repository(directory),'未命名工作');}break;}
          case 'project:open':await workspace.open(new ProjectRepository(path.dirname(projectFile)));break;
          case 'recipe:save':await workspace.saveRecipe(command.recipe);break;
          case 'recipe:select-model':await workspace.selectModel(command.model_config_id);break;
          case 'recipe:reset-parameters':await workspace.resetParameters();break;
          case 'asset:hide':await workspace.hideMaterial(command.asset_id);break;
          case 'module:add':await workspace.addModule(command.reference_type,command.before_module_id);break;
          case 'module:copy':await workspace.copyModule(command.module_id);break;
          case 'module:reference-type':await workspace.changeReferenceType(command.module_id,command.reference_type);break;
          case 'module:tool':await workspace.saveToolReference(command.module_id,Buffer.from(command.png_base64,'base64'),command.state,command.instruction);break;
          case 'assets:import':await workspace.importFiles(['product','composition','style'].map(name=>path.resolve(`.local/fixtures-v2/${name}.png`)),command.module_id);break;
          case 'job:start':await workspace.enqueue(command.allow_degradation);break;
          case 'job:retry':await workspace.retry(command.project_id,command.task_id);break;
          case 'job:cancel':await workspace.cancel(command.task_id);break;
          case 'job:restore':await workspace.restore(command.task_id);break;
          case 'result:restore':await workspace.restoreResult(command.project_id,command.asset_id);break;
          default:throw new Error('此功能需在桌面验证；浏览器宿主不开放凭据配置或任意文件写入。');
        }
        return {ok:true,state:await view()};
      });json(response,200,result);return;
    }
    if(request.method!=='GET'){json(response,405,{ok:false});return;}
    if(url.pathname.startsWith('/preview-project-cover/')){
      const [id,assetId]=url.pathname.slice('/preview-project-cover/'.length).split('/');
      const filename=await projectLibrary.cover(id,assetId);response.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'no-store'});response.end(await readFile(filename));return;
    }
    if(url.pathname.startsWith('/preview-assets/')){
      const id=url.pathname.slice('/preview-assets/'.length),asset=workspace.project?.assets.find(a=>a.asset_id===id);
      if(!asset)throw new Error('Missing asset');
      const filename=await workspace.repository.resolveAssetPath(asset,url.searchParams.get('thumbnail')==='1');
      const bytes=await readFile(filename);
      response.writeHead(200,{'Content-Type':url.searchParams.get('thumbnail')==='1'?'image/webp':asset.mime_type,'Cache-Control':'no-store'});response.end(bytes);return;
    }
    const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
    const root=path.resolve('dist'),filename=path.resolve(root,relative);
    if(!filename.startsWith(`${root}${path.sep}`))throw new Error('Invalid path');
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[path.extname(filename)]??'application/octet-stream';
    const bytes=await readFile(filename);
    response.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(bytes);
  }catch(e){const message=e instanceof ZodError?e.issues.map(issue=>issue.message).join('；'):e.message??'验证操作失败。';if(!response.headersSent)json(response,e.code==='ENOENT'?404:400,{ok:false,error:message});else response.destroy();}
});
server.listen(port,'127.0.0.1',()=>console.log(`${origin}/?preview=1 — fixed fixtures, mock engine only`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void shutdown());
