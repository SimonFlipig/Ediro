import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppDialog } from './AppDialog.js';
import { UpdatePanel } from './UpdatePanel.js';
import type { UpdateState } from '../shared/updates.js';
import type { DialogRequest } from '../shared/api.js';
import { MaskEditor } from './MaskEditor.js';
import { ProjectHistory } from './ProjectHistory.js';
import { ImagePreview } from './ImagePreview.js';
import { fittedViewport, zoomViewport } from './image-viewport.js';
import type { Parameters, Recipe, SemanticModule } from '../core/domain.js';
import type { Command, DesktopApi, ViewAsset, WorkspaceView } from '../shared/api.js';
import { createPreviewApi } from './preview-api.js';

import { GenerationOptionsPanel } from './GenerationOptionsPanel.js';
import { ModuleEditor } from './ModuleEditor.js';
import { describeInputBlock } from './module-presentation.js';
import { ModelSettingsPage,type SettingsPageHandle } from './ModelSettingsPage.js';
import { referenceDropEffect } from './drag-input.js';
import { visibleResult, usableThumbnail } from './asset-display.js';
import { synchronizeInputPreview } from './input-preview.js';
import { resolveOutputGeometry,geometryLabel,parseRatio } from '../core/output-geometry.js';
import { contractFor,updateParameters } from '../core/generation-parameters.js';
import { defaultInputStrategies } from '../core/compiler.js';
import './editor.css';

declare global { interface Window { ediro?: DesktopApi } }
const glyphs: Record<string, string> = { image_text: '▧', subject: '◈', composition: '▦', style: '◐', prompt: '≡', viewpoint: '◇' };
const builtInModuleKinds = [
  {type:'image_text',title:'图文',description:'图片与文字 · 无预设语义',glyph:'▧'},
  {type:'prompt',title:'提示词',description:'文本生成要求',glyph:'≡'},
  {type:'subject',title:'语义参考图',description:'主体 / 构图 / 风格',glyph:'◈'},
  {type:'viewpoint',title:'功能参考图',description:'视角工具与生成参考',glyph:'◇'},
];
const statusLabels: Record<string,string> = { queued:'等待中', preparing:'准备中', running:'运行中', post_processing:'保存中', succeeded:'已完成', failed:'失败', cancelled:'已取消' };
const api = window.ediro ?? (new URLSearchParams(location.search).get('preview') === '1' ? createPreviewApi() : undefined);


function ModuleCard({ module: m, index, imageNames, assets, definition, definitions, onEdit, onCopy, onDelete, onImport, onMove, onDrop, onFiles, onAsset, onExpand, onReferenceType, onSelectAsset }: {
  module: SemanticModule; index: number; imageNames: string[]; assets: ViewAsset[]; definition?: WorkspaceView['module_definitions'][number];
  definitions: WorkspaceView['module_definitions'];
  onEdit: (patch: Partial<SemanticModule>) => void; onCopy: () => void; onDelete: () => void; onImport: () => void;
  onMove: (delta: number) => void; onDrop: (value: string) => void; onSelectAsset: (id: string) => void;
  onFiles: (files: File[]) => void; onAsset: (id: string) => void; onExpand: (text: string) => void; onReferenceType: (type: string) => void;
}) {
  const [text, setText] = useState(m.user_instruction);
  const [title, setTitle] = useState(m.title);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) { setText(m.user_instruction); setTitle(m.title); } }, [m.user_instruction,m.title]);
  const isPrompt = definition?.editor_kind === 'text';
  const neutral = m.reference_type === 'image_text';
  const textLabel = isPrompt ? '生成要求' : neutral ? '文字说明' : '额外要求';
  const functional = definition?.editor_kind === 'generated_reference';
  const acceptsImages = definition?.accepts_images;
  return <article className={`module-card type-${m.reference_type} ${m.enabled ? '' : 'disabled'}`} data-module-id={m.module_id}
    onDoubleClick={event=>{if(!(event.target as HTMLElement).closest('button,input,textarea,select,.drag-handle'))onExpand(text);}}
    onDragOver={event => { event.stopPropagation(); const effect=referenceDropEffect(Array.from(event.dataTransfer.types),event.dataTransfer.effectAllowed,definition?.editor_kind==='image_collection'); event.dataTransfer.dropEffect=effect; if(effect==='none'){event.currentTarget.classList.remove('drop-target');return;} event.preventDefault(); event.currentTarget.classList.add('drop-target'); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) { event.currentTarget.classList.remove('drop-target'); } }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.classList.remove('drop-target'); document.querySelectorAll('.module-card.is-dragging').forEach(el=>el.classList.remove('is-dragging')); document.querySelectorAll('.module-card.drop-target').forEach(el=>el.classList.remove('drop-target')); if(event.dataTransfer.files.length)onFiles(Array.from(event.dataTransfer.files));else if(event.dataTransfer.getData('application/ediro-asset'))onAsset(event.dataTransfer.getData('application/ediro-asset'));else onDrop(event.dataTransfer.getData('application/ediro-module')); }}>
    <div className="module-heading">
      <span className="drag-handle" draggable aria-label={`拖动${m.title}模块`} title="拖动排序"
        onDragStart={e => { e.dataTransfer.setData('application/ediro-module', JSON.stringify({ kind:'instance', id:m.module_id })); e.dataTransfer.effectAllowed='move'; const card=(e.currentTarget as HTMLElement).closest('.module-card'); requestAnimationFrame(()=>card?.classList.add('is-dragging')); }}
        onDragEnd={e => { const card=(e.currentTarget as HTMLElement).closest('.module-card'); card?.classList.remove('is-dragging'); document.querySelectorAll('.module-card.is-dragging').forEach(el=>el.classList.remove('is-dragging')); document.querySelectorAll('.module-card.drop-target').forEach(el=>el.classList.remove('drop-target')); }}>⠿</span>
      <span className="module-number">{String(index+1).padStart(2,'0')}</span>
      <span className="module-glyph">{glyphs[m.reference_type] ?? '◇'}</span>
      <input className="module-title" aria-label={`${m.title}模块名称`} value={title} maxLength={80}
        onFocus={() => focused.current=true} onChange={e => {setTitle(e.target.value);if(e.target.value.trim())onEdit({title:e.target.value.trim()});}}
        onBlur={() => { focused.current=false; if (title.trim() && title !== m.title) onEdit({title:title.trim()}); else if (!title.trim()) setTitle(m.title); }} />
      <button className={`toggle ${m.enabled?'on':''}`} aria-label={`${m.enabled?'停用':'启用'}${m.title}模块`} aria-pressed={m.enabled} title="启用或停用" onClick={() => onEdit({enabled:!m.enabled})} />
    </div>
    {definition?.editor_kind === 'image_collection' && !neutral && <select className="reference-role" aria-label={`${m.title}参考类别`} value={m.reference_type} onChange={event=>onReferenceType(event.target.value)}>{definitions.filter(d=>d.editor_kind==='image_collection'&&d.type!=='image_text').map(d=><option value={d.type} key={d.type}>{d.title}参考</option>)}</select>}
    {m.base_instruction && <div className="base-instruction" title={definition?.description??'按模块功能使用参考信息。'}><span>功能说明</span><p>{definition?.description??'按模块功能使用参考信息。'}</p></div>}
    {acceptsImages && <div className="reference-images">
      {m.asset_ids.map((id, i) => {
        const asset = assets.find(a => a.asset_id === id);
        return <div className="reference-image" key={`${id}-${i}`}>
          <button className="thumb-button" title={asset?.source_status==='missing'?'源图缺失':asset?.source_status==='changed'?'源图已变化':asset?.name} onClick={() => onSelectAsset(id)}>{usableThumbnail(asset) ? <img src={asset!.preview_url} alt={asset!.name} /> : <span>图片缺失</span>}</button>
          <span>{imageNames[i]??(m.enabled?String(i+1):'停用')}</span><button className="remove-reference" aria-label={`移除第${i+1}参考图`} onClick={() => onEdit({asset_ids:m.asset_ids.filter((_, j) => j !== i)})}>×</button>
        </div>;
      })}
      <button className="add-image" title={functional?'打开功能参考工具':'拖入或选择多图片，保持插入顺序'} onClick={functional?()=>onExpand(text):onImport}><b>{functional?'◇':'＋'}</b><span>{functional?'视角工具':neutral?'图片':'参考图'}</span></button>
    </div>}
    <label className="field-label">{textLabel}</label>
    <textarea aria-label={`${m.title}${textLabel}`} placeholder={isPrompt?'描述你想生成的电商视觉…':neutral?'填写文字说明或指令，不附加预设语义…':'补充你希望达到的效果…'} value={text} rows={isPrompt?5:3}
      onFocus={() => focused.current=true} onChange={e => {setText(e.target.value);onEdit({user_instruction:e.target.value});}} maxLength={32000}
      onBlur={() => { focused.current=false; if(text !== m.user_instruction) onEdit({user_instruction:text}); }} />
    <div className="module-footer"><button className="expand-module" aria-label={`展开${m.title}编辑`} onClick={()=>onExpand(text)}>展开编辑 ↗</button><div>
      <button aria-label={`${m.title}前移`} title="前移" onClick={() => onMove(-1)}>←</button>
      <button aria-label={`${m.title}后移`} title="后移" onClick={() => onMove(1)}>→</button>
      <button aria-label={`复制${m.title}模块`} title="复制 · 创建新 ID" onClick={onCopy}>⧉</button>
      <button aria-label={`移除${m.title}模块`} title="移除模块" onClick={onDelete}>×</button>
    </div></div>
  </article>;
}

export function App() {
  const [showUpdates,setShowUpdates]=useState(false),[updateState,setUpdateState]=useState<UpdateState>();
  const [maskSource,setMaskSource]=useState<string|null>(null);
  const [maskFresh,setMaskFresh]=useState(false),[maskTaskId,setMaskTaskId]=useState<string|undefined>();
  const [maskCanvas,setMaskCanvas]=useState<HTMLDivElement|null>(null);
  const [view,setView]=useState<WorkspaceView|null>(null);
  const viewRef=useRef<WorkspaceView|null>(null);
  const [invalidCustomRatio,setInvalidCustomRatio]=useState(false);
  const settingsRef=useRef<SettingsPageHandle>(null);
  const [toast,setToast]=useState(''), [error,setError]=useState(''), [pending,setPending]=useState(0), [library,setLibrary]=useState(false);
  const [selectedAsset,setSelectedAsset]=useState<string|null>(null), [viewport,setViewport]=useState(fittedViewport), [tab,setTab]=useState<'chain'|'history'>('chain');
  const zoom=viewport.zoom;
  const setZoom=(value:number)=>setViewport(previous=>zoomViewport(previous,value));
  useLayoutEffect(()=>setViewport(fittedViewport()),[selectedAsset,view?.project?.project_id]);
  const [showNew,setShowNew]=useState(false);
  const [hostDialogs,setHostDialogs]=useState<DialogRequest[]>([]);
  const [notices,setNotices]=useState<{id:string;title:string;detail:string;retry:Command;projectId:string}[]>([]);
  const seenFailures=useRef(new Set<string>());
  useEffect(()=>api?.onDialog?.(request=>setHostDialogs(items=>items.some(item=>item.id===request.id)?items:[...items,request])),[]);
  const answerHost=(response:number)=>{const request=hostDialogs[0];if(!request)return;api?.respondDialog?.(request.id,response);setHostDialogs(items=>items.filter(item=>item.id!==request.id));};
  const [showRecents,setShowRecents]=useState(false);
  const [editor,setEditor]=useState<{id:string;text:string}|null>(null), [fileDrag,setFileDrag]=useState(false);


  const chainRef=useRef<HTMLDivElement>(null);
  const resultRef=useRef<HTMLDivElement>(null);
  const queue=useRef<Promise<unknown>>(Promise.resolve());
  const lastDispatchError=useRef('');
  const selectedRef=useRef(selectedAsset); selectedRef.current=selectedAsset;
  const accept=(incoming:WorkspaceView)=>{const state=synchronizeInputPreview(incoming);const previous=viewRef.current;
    for(const job of state.project?.jobs??[]){
      if(job.status!=='failed')continue;
      const key=state.project!.project_id+':'+job.task_id;
      if(seenFailures.current.has(key))continue;seenFailures.current.add(key);
      if(previous?.project?.project_id!==state.project?.project_id)continue;
      const local=job.recoverable_result||!!job.mask_edit?.raw_asset_ids.length;
      setNotices(items=>[...items,{id:key,title:local?'结果保存失败':'生成失败',detail:(job.error??'任务未完成。')+'\n\n'+(local?'重试会保存已有结果，不会再次调用模型。':'重试将按此任务原来的输入和参数重新生成，可能产生新的调用费用。'),retry:{type:'job:retry',project_id:state.project!.project_id,task_id:job.task_id},projectId:state.project!.project_id}]);
    }
    viewRef.current=state;setView(state);const changed=previous?.project?.project_id!==state.project?.project_id;if(changed){setMaskSource(null);setEditor(null);setSelectedAsset(state.assets.filter(visibleResult).at(-1)?.asset_id??state.assets.find(a=>a.kind==='import'&&!a.hidden_from_materials)?.asset_id??null);return;}const imported=state.assets.find(a=>a.kind==='import'&&!previous?.assets.some(old=>old.asset_id===a.asset_id));const completed=state.project?.jobs.findLast(j=>j.status==='succeeded'&&!previous?.project?.jobs.some(old=>old.task_id===j.task_id&&old.status==='succeeded'));if(completed?.output_asset_ids[0])setSelectedAsset(completed.output_asset_ids[0]);else if(imported)setSelectedAsset(imported.asset_id);else if(!selectedRef.current&&state.assets.some(visibleResult))setSelectedAsset(state.assets.filter(visibleResult).at(-1)!.asset_id);};
  useEffect(()=>{
    if(!api){setError('请通过“启动 Ediro.cmd”打开桌面程序。普通浏览器没有桌面权限桥接。');return;}
    void api.execute({type:'state'}).then(r=>{if(r.state)accept(r.state);else setError(r.error??'无法连接内核');});
    return api.subscribe(state=>accept(state));
  },[]);
  useEffect(()=>{
    const cleanups=[chainRef.current,resultRef.current].filter((el):el is HTMLDivElement=>!!el).map(el=>{
      const handleWheel=(e:WheelEvent)=>{
        if(el.scrollWidth>el.clientWidth&&e.deltaY!==0&&!e.ctrlKey){
          e.preventDefault();el.scrollLeft+=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?el.clientWidth:1);
        }
      };
      el.addEventListener('wheel',handleWheel,{passive:false});
      return ()=>el.removeEventListener('wheel',handleWheel);
    });
    return ()=>cleanups.forEach(cleanup=>cleanup());
  },[]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),3500);return()=>clearTimeout(timer);},[toast]);
  const dispatch=(build:Command|((state:WorkspaceView)=>Command),message?:string,notifyFailure=true):Promise<boolean>=>{
    setPending(n=>n+1);
    const run=queue.current.then(async()=>{
      if(!api)throw new Error('桌面桥接不可用。');
      const command=typeof build==='function'?build(viewRef.current!):build;
      const response=await api.execute(command);
      if(!response.ok){
        if(response.state)accept(response.state);
        if(notifyFailure&&(command.type==='job:start'||command.type==='mask:start'))setNotices(items=>[...items,{id:crypto.randomUUID(),title:'生成未能开始',detail:response.error??'请检查输入后重试。',retry:structuredClone(command),projectId:viewRef.current?.project?.project_id??''}]);
        throw new Error(response.error??'操作失败');
      }
      if(response.state){accept(response.state);setError('');if(message)setToast(message);}
      if(response.selected_asset_id)setSelectedAsset(response.selected_asset_id);
      return !response.cancelled;
    });
    const result=run.catch(e=>{lastDispatchError.current=e instanceof Error?e.message:'操作失败';setError(lastDispatchError.current);return false;}).finally(()=>setPending(n=>n-1));
    queue.current=result;
    return result;
  };
  const updateRecipe=(transform:(r:Recipe)=>Recipe)=>dispatch(state=>({type:'recipe:save',recipe:transform(structuredClone(state.project!.recipe))}));
  const flushEditors=async()=>{
    (document.activeElement as HTMLElement|null)?.blur();
    const tasks:Promise<boolean>[]=[];
    window.dispatchEvent(new CustomEvent('ediro:flush-editors',{detail:tasks}));
    if((await Promise.all(tasks)).some(ok=>!ok)){setError('当前编辑尚未保存，请等待正在进行的操作结束后重试。');return false;}
    await queue.current;return dispatch({type:'project:save'});
  };
  const flushEditorsRef=useRef(flushEditors);flushEditorsRef.current=flushEditors;
  useEffect(()=>api?.beforeClose?.(()=>flushEditorsRef.current()),[]);
  useEffect(()=>{const save=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void flushEditorsRef.current();}};window.addEventListener('keydown',save);return()=>window.removeEventListener('keydown',save);},[]);
  const selectResult=async(assetId:string)=>{
    const project=viewRef.current?.project;
    if(!project)return;
    const job=project.jobs.find(j=>j.output_asset_ids.includes(assetId));
    const ok=await dispatch({type:'result:restore',project_id:project.project_id,asset_id:assetId});
    if(!ok||viewRef.current?.project?.project_id!==project.project_id)return;
    setSelectedAsset(assetId);setZoom(100);setEditor(null);
    setMaskFresh(false);setMaskTaskId(undefined);
    setMaskSource(null);
  };
  const editModule=(id:string,patch:Partial<SemanticModule>)=>void updateRecipe(r=>({...r,modules:r.modules.map(m=>m.module_id===id?{...m,...patch}:m)}));
  const moveModule=(id:string,delta:number)=>void updateRecipe(r=>{const i=r.modules.findIndex(m=>m.module_id===id),j=i+delta;if(i>=0&&j>=0&&j<r.modules.length){const [m]=r.modules.splice(i,1);r.modules.splice(j,0,m);}return r;});
  const dropModule=(value:string,target?:string)=>{
    document.querySelectorAll('.module-card.is-dragging').forEach(el=>el.classList.remove('is-dragging'));
    document.querySelectorAll('.module-card.drop-target').forEach(el=>el.classList.remove('drop-target'));
    try {const data=JSON.parse(value);if(data.kind==='definition')void dispatch({type:'module:add',reference_type:data.type,...(target?{before_module_id:target}:{})},'已添加参考模块');
      else if(data.kind==='instance'&&data.id!==target)void updateRecipe(r=>{const i=r.modules.findIndex(m=>m.module_id===data.id);if(i<0)return r;const [m]=r.modules.splice(i,1);const j=target?r.modules.findIndex(m=>m.module_id===target):r.modules.length;r.modules.splice(j<0?r.modules.length:j,0,m);return r;});}
    catch{/* Not an Ediro module drag. */}
  };
  const importDrop=(files:File[],moduleId?:string)=>{
    if(!files.length)return;
    try {const paths=api?.getFilePaths(files)??[];if(!paths.length){setError('浏览器验证模式无法读取资源管理器路径，请使用桌面程序拖入文件。');return;}if(paths.length!==files.length){setError('部分拖入文件没有可用磁盘路径，请从资源管理器重新拖入。');return;}void dispatch({type:'assets:drop',paths,...(moduleId?{module_id:moduleId}:{})},paths.some(p=>/\.ediro$/i.test(p))?'工程已打开':'素材已添加');}catch{setError('无法读取拖入文件路径，请手动选择素材。');}
  };
  const project=view?.project, recipe=project?.recipe, assets=view?.assets??[];
  const moduleKinds=[...builtInModuleKinds,...(view?.module_definitions??[]).filter(d=>!['image_text','prompt','subject','composition','style','viewpoint'].includes(d.type)).map(d=>({type:d.type,title:d.title,description:d.description,glyph:'◇'}))];
  const model=view?.models.find(m=>m.model_config_id===recipe?.model_config_id&&m.enabled&&(!recipe?.model_preset_id||m.preset_id===recipe.model_preset_id));
  let geometryNote='';if(recipe&&model){try{geometryNote=geometryLabel(resolveOutputGeometry(recipe,assets,model));}catch{geometryNote='比例依据待检查';}}
  const currentAsset=assets.find(a=>a.asset_id===(maskSource??selectedAsset));
  const resultLabels=new Map(project?.jobs.flatMap(job=>job.output_asset_ids.map(id=>[id,job.mask_edit?`${job.model_snapshot.kind==='mock'?'模拟 · ':''}${job.mask_edit.variants.find(v=>v.asset_id===id)?.mode==='natural'?'自然融合':'局部修改'}`:job.model_snapshot.kind==='mock'?'模拟预览':'AI 生成'] as const))??[]);
  const editingModule=recipe?.modules.find(m=>m.module_id===editor?.id);
  const latestJob=project?.jobs.at(-1);
  const activeCount=project?.jobs.filter(j=>['queued','preparing','running','post_processing'].includes(j.status)).length??0;
  const isDraft=view?.project_format==='draft';
  const saveLabel=view?.save_state==='error'?'保存失败':isDraft?'未创建项目':view?.save_state==='pending'?'等待自动保存…':view?.save_state==='saving'?'正在保存…':'已保存';
  const run=()=>void dispatch({type:'job:start',allow_degradation:true});
  const changeParameter=<K extends keyof Parameters>(key:K,value:Parameters[K])=>void updateRecipe(r=>({...r,core_parameters:model?updateParameters(r.core_parameters,{[key]:value},model):{...r.core_parameters,[key]:value}}));
  const strategyHelp=view?.adaptation?.kind==='separated_inputs'?'实际采用编号拍平：文字引用 image_N，对应图片发送顺序。':view?.adaptation?'实际采用图文顺序。':'选择图片与文字的组合方式，按模型能力检查兼容性。';

  return <div inert={hostDialogs.length>0||notices.length>0||showNew||showUpdates?true:undefined} className={`app-shell ${window.ediro?.windowControlsOverlay?'desktop-shell':''} ${fileDrag?'file-dragging':''} ${maskSource?'mask-active':''}`} onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';setFileDrag(true);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setFileDrag(false);}} onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();setFileDrag(false);if(maskSource)return;importDrop(Array.from(event.dataTransfer.files));}}}>
    <header className="topbar"><div className="brand"><div className="brand-mark">e</div><div><b>ediro<span> / </span></b><small>视觉工作台</small></div></div>
      <div className="project-heading" title={view?.project_location??''}><span className={`status-dot ${view?.save_state!=='saved'?'saving':''}`}/><b>{isDraft?'空白工作':project?.name??'正在准备工作台'}</b><span>{saveLabel}</span></div>
      <div className="top-actions" hidden={library}><button onClick={()=>setShowNew(true)} disabled={activeCount>0||!!maskSource}>＋ 新工作</button><button onClick={()=>setShowRecents(true)} disabled={activeCount>0||!!maskSource}>项目记录</button><button onClick={()=>void dispatch({type:'project:package'})} disabled={!project||activeCount>0||!!maskSource}>另存为…</button><button className="settings-button" onClick={()=>setLibrary(true)} disabled={!view||!!maskSource}>设置</button>{api?.updates&&<button onClick={()=>setShowUpdates(true)} disabled={!!maskSource} title="检查 GitHub 发布版本">{updateState?.status==='available'?'发现新版本':updateState?.status==='downloaded'?'重启升级':updateState?.status==='downloading'?`下载更新 ${updateState.percent??0}%`:'检查更新'}</button>}</div>
    </header>
    <UpdatePanel api={api?.updates} open={showUpdates} onClose={()=>setShowUpdates(false)} onState={setUpdateState}/>
    {library&&view&&<ModelSettingsPage ref={settingsRef} initialModel={recipe?.model_config_id} view={view} onClose={()=>setLibrary(false)} onSave={command=>dispatch(command,'设置已保存')} onProbe={async command=>{if(!api)return {ok:false,error:'桌面桥接不可用。'};const response=await api.execute(command);if(response.state)accept(response.state);return response;}}/>}
    <div className="workbench" hidden={library}>
      <aside className="left-sidebar" inert={!!maskSource}><section className="sidebar-section"><div className="section-heading"><h2>工作素材</h2><span>{assets.filter(a=>a.kind==='import'&&!a.hidden_from_materials).length}</span></div><p className="subtle">{isDraft?'添加素材或开始生成时创建项目。':view?.project_format==='ediro'?'素材收入工程，移动原图不影响编辑。':'旧工程使用外部引用；另存为可收齐素材。'}</p>
      <button className="import-button" disabled={!project} onClick={()=>void dispatch({type:'assets:import'},'素材已添加')}>＋ 添加素材</button>
      <div className="asset-grid">{assets.filter(a=>a.kind==='import'&&!a.hidden_from_materials).map(a=><div className="asset-entry" key={a.asset_id}><button className={`asset-tile ${selectedAsset===a.asset_id?'selected':''}`} draggable onDragStart={event=>{event.dataTransfer.setData('application/ediro-asset',a.asset_id);event.dataTransfer.effectAllowed='copy';}} onClick={()=>setSelectedAsset(a.asset_id)}>{usableThumbnail(a)?<img src={a.preview_url} alt={a.name} draggable={false}/>:<span className="missing-image-label">图片缺失</span>}<span title={a.location.type==='external'?a.location.path:a.name}>{a.name}</span><small>{a.source_status==='missing'?'源图缺失':a.source_status==='changed'?'源图已变化':a.location.type==='external'?'磁盘链接':'包内素材'} · {a.width} × {a.height}</small></button><button className="material-remove" aria-label={`移除素材 ${a.name}`} title="移除备选素材，不删除源文件、不影响模块引用" onClick={()=>void dispatch({type:'asset:hide',asset_id:a.asset_id},'已移除备选素材，模块引用和源文件不变')}>×</button>{a.source_status!=='available'&&a.location.type==='external'&&<button className="relink-button" onClick={()=>void dispatch({type:'asset:relink',asset_id:a.asset_id},'源图已重新定位')}>重新定位</button>}</div>)}</div>
      {!assets.some(a=>a.kind==='import'&&!a.hidden_from_materials)&&<div className="small-empty">◇<span>添加商品图或视觉参考</span><small>PNG / JPEG / WebP</small></div>}
      </section><section className="sidebar-section module-library"><div className="section-heading"><h2>输入模块库</h2><span>{moduleKinds.length}</span></div><p className="subtle">图文自由输入 · 语义与功能按需组合。</p>
      {moduleKinds.map(d=><button className={`library-module type-${d.type}`} key={d.type} disabled={!project} draggable={!!project}
        onDragStart={e=>{e.dataTransfer.setData('application/ediro-module',JSON.stringify({kind:'definition',type:d.type}));e.dataTransfer.effectAllowed='copy';}}
        onClick={()=>void dispatch({type:'module:add',reference_type:d.type},`已添加${d.title}模块`)}><span>{glyphs[d.type]??'◇'}</span><div><b>{d.title}</b><small>{d.description}</small></div><i>＋</i></button>)}
      <div className="future-module"><span>↗ 双击模块展开编辑</span><small>功能参考可生成视角图<br/>仍进入同一富媒体指令链</small></div></section>
      <div className="sidebar-footer"><span className="status-dot"/> {isDraft?'当前调整仅本次使用，开始工作后自动保存':'停止编辑约 2 秒后自动保存'}<br/><small>{isDraft?'模型沿用设置中的默认选择':view?.project_storage_version===1?'旧版工程 · 另存为可去除重复图片':'另存为独立工程 · 成品按需导出'}</small></div></aside>

      <main className="main-workspace"><section className="canvas-section"><div className="canvas-toolbar"><div className="workspace-heading"><h1>{maskSource?'局部编辑':currentAsset?.kind==='output'?'结果预览':currentAsset?'素材预览':'从参考到成品'}</h1><span className="eyebrow">VISUAL WORKSPACE</span></div><div className="canvas-actions">{maskSource?<span>正在编辑当前底图</span>:<>
          <button className="mask-edit-entry" disabled={!currentAsset||!!currentAsset.removed_result||currentAsset.source_status==='missing'||currentAsset.source_status==='changed'} onClick={()=>{if(currentAsset){setMaskFresh(false);setMaskTaskId(undefined);setMaskSource(currentAsset.asset_id);}}}>编辑选区</button><button onClick={()=>void dispatch({type:'output:folder'})}>{view?.project_format==='legacy'?'output 文件夹':'导出目录'}</button><button disabled={activeCount>0} onClick={()=>void dispatch({type:'output:open'},'已从产出恢复工作')}>恢复旧产出</button>
          {currentAsset?.kind==='output'&&!currentAsset.removed_result&&<button onClick={()=>void dispatch({type:'result:trash',asset_id:currentAsset.asset_id},view?.project_format==='ediro'?'已从结果列表移除，历史引用保留':'结果图片及恢复记录已移至回收站')} disabled={activeCount>0}>{view?.project_format==='ediro'?'移除选中版本':'删除选中版本'}</button>}
        <button onClick={()=>setZoom(Math.max(25,zoom-25))} disabled={!currentAsset} aria-label="缩小">−</button><span>{Math.round(zoom)}%</span><button onClick={()=>setZoom(Math.min(300,zoom+25))} disabled={!currentAsset} aria-label="放大">＋</button><button onClick={()=>setViewport(fittedViewport())}>适应</button>
        <button disabled={!currentAsset} onClick={()=>currentAsset&&void dispatch({type:'asset:export',asset_id:currentAsset.asset_id},'图片已导出')}>↗ 导出</button></>}</div></div>
        <div className={`canvas-stage ${currentAsset?'has-image':''}`}>
          {maskSource?<div className="mask-stage-host" ref={setMaskCanvas}/>:currentAsset?(currentAsset.source_status==='missing'||currentAsset.source_status==='changed'?<div className="image-scroll"><div className="small-empty"><span>{currentAsset.source_status==='missing'?'源图片已移动或删除':'源图片内容可能已变化'}</span><small>输入链与生成结果仍保留，可重新定位原图，或作为新素材导入。</small><button onClick={()=>void dispatch({type:'asset:relink',asset_id:currentAsset.asset_id},'源图已重新定位')}>重新定位原图</button></div></div>:<ImagePreview key={`${currentAsset.asset_id}:${currentAsset.original_url}`} asset={currentAsset} view={viewport} onChange={setViewport}/>):<div className="welcome-canvas"><div className="welcome-symbol">◈</div><span className="eyebrow">A CLEAR PATH TO CREATE</span><h2>把设计意图，排成一条链。</h2><p>从文件夹拖入商品图或视觉参考。<br/>不用建立项目，放进来就开始。</p><div className="welcome-actions"><button onClick={()=>void dispatch({type:'assets:import'},'素材已添加')}>添加素材</button><span>或直接拖入图片</span></div><div className="sample-recipe"><span>◈ 语义参考</span><i>→</i><span>◇ 功能参考</span><i>→</i><span>≡ 提示词</span></div></div>}
          <div className="canvas-bottom-note"><span>{currentAsset?`${currentAsset.name} · ${currentAsset.width} × ${currentAsset.height}`:'单工作台 · 生成单元与参考模块独立'}</span><span>{currentAsset?.kind==='output'?resultLabels.get(currentAsset.asset_id)??'生成结果':'LOCAL FIRST'}</span></div>
        </div>
        <div className="result-strip" ref={resultRef} inert={!!maskSource}><span className="strip-label">结果版本</span>{assets.filter(visibleResult).map(a=><button className={`result-thumb ${selectedAsset===a.asset_id?'selected':''}`} key={a.asset_id} title={`${a.name} · 点击恢复此版本的参数和创作模块 · 可拖入语义参考模块`} draggable onDragStart={event=>{event.dataTransfer.setData('application/ediro-asset',a.asset_id);event.dataTransfer.effectAllowed='copy';}} onClick={()=>void selectResult(a.asset_id)}><img src={a.preview_url} alt={a.name} draggable={false}/><span>{resultLabels.get(a.asset_id)??'生成结果'}</span></button>)}{!assets.some(visibleResult)&&<span className="subtle">生成结果会保存在这里，原图不会覆盖。</span>}</div>
      </section>

      <section className="recipe-section" inert={!!maskSource}><header className="recipe-header"><div className="workspace-heading"><h2>生成输入链 <span>{recipe?.modules.length??0} 个模块</span></h2><span className="eyebrow">GENERATION RECIPE</span></div><div className="recipe-summary"><small title="拖动改变阅读顺序 · 无数值权重">拖动改变阅读顺序 · 无数值权重</small><span>{view?.chain?.mode==='reference_generation'?'带参考生成':'文生图'}</span></div></header>
        <div className="module-chain" ref={chainRef} onDragOver={e=>e.preventDefault()} onDragEnd={()=>{document.querySelectorAll('.module-card.is-dragging').forEach(el=>el.classList.remove('is-dragging'));document.querySelectorAll('.module-card.drop-target').forEach(el=>el.classList.remove('drop-target'));}} onDrop={e=>{if(e.target===e.currentTarget){e.preventDefault();dropModule(e.dataTransfer.getData('application/ediro-module'));}}}>
          {recipe?.modules.map((m,index)=><ModuleCard key={m.module_id} module={m} index={index} imageNames={view?.chain?.blocks.filter(b=>b.type==='image'&&b.source_module_id===m.module_id).map(b=>b.type==='image'?b.image_name??'':'')??[]} assets={assets} definitions={view?.module_definitions??[]} definition={view?.module_definitions.find(d=>d.type===m.reference_type)}
            onEdit={patch=>editModule(m.module_id,patch)} onCopy={()=>void dispatch({type:'module:copy',module_id:m.module_id},'已复制 · 新参考 ID')}
            onDelete={()=>void updateRecipe(r=>({...r,modules:r.modules.filter(item=>item.module_id!==m.module_id)}))}
            onImport={()=>void dispatch({type:'assets:import',module_id:m.module_id},'参考图已添加')}
            onMove={delta=>moveModule(m.module_id,delta)} onDrop={value=>dropModule(value,m.module_id)} onFiles={files=>{setFileDrag(false);importDrop(files,m.module_id);}} onAsset={id=>{if(view?.module_definitions.find(d=>d.type===m.reference_type)?.editor_kind!=='image_collection'){setError('请把素材拖到语义参考图模块。');return;}void updateRecipe(r=>({...r,modules:r.modules.map(module=>module.module_id===m.module_id?{...module,asset_ids:[...module.asset_ids,id]}:module)}));}} onExpand={text=>setEditor({id:m.module_id,text})} onReferenceType={type=>void dispatch({type:'module:reference-type',module_id:m.module_id,reference_type:type},'参考类别已切换 · 新参考 ID')} onSelectAsset={id=>setSelectedAsset(id)}/>)}
          {project&&<button className="chain-add" title="添加提示词模块" onClick={()=>void dispatch({type:'module:add',reference_type:'prompt'})}><span>＋</span><small>添加模块<br/>或从左侧拖入</small></button>}
          {!project&&<div className="recipe-empty">先创建或打开项目，即可编辑完整生成配方。</div>}
        </div>
      </section></main>

      <aside className="right-sidebar">{maskSource&&currentAsset&&view&&api?<MaskEditor key={`${project?.project_id}:${maskSource}:${maskFresh}:${maskTaskId}`} fresh={maskFresh} resumeTaskId={maskTaskId} source={currentAsset} state={view} canvas={maskCanvas} dispatch={dispatch} onClose={()=>setMaskSource(null)} onContinue={id=>{setMaskFresh(true);setMaskTaskId(undefined);setSelectedAsset(id);setMaskSource(id);}} api={api}/>:<><section className="parameter-section"><div className="section-heading"><h2>生成单元</h2><button className="text-button" onClick={()=>setLibrary(true)} disabled={!view}>管理模型</button></div>
        <div className="parameter-label-row"><label className="field-label" htmlFor="generation-model">主生图模型</label>{model&&<button className="text-button" onClick={()=>void dispatch({type:'recipe:reset-parameters'},'已恢复当前模型的 Ediro 默认设置')}>恢复模型默认</button>}</div><select id="generation-model" aria-label="主生图模型" disabled={!project} value={recipe?.model_config_id??''} onChange={e=>void dispatch({type:'recipe:select-model',model_config_id:e.target.value},'已恢复此工作流程的模型设置')}>
          {!project&&<option value="">新建项目后选择</option>}{recipe&&!model&&<option value={recipe.model_config_id}>待选择模型 · 历史参数已保留</option>}{view?.models.filter(m=>m.enabled&&m.purpose!=='understanding'&&m.kind!=='local').map(m=>{const platform=view.connections?.find(c=>c.connection_id===m.connection_id)?.title;return <option key={m.model_config_id} value={m.model_config_id}>{platform?`${platform}·${m.title}`:m.title}</option>;})}
        </select>
        {model&&<div className={`execution-note ${model.kind==='mock'?'':'warning'}`}><div className="execution-note-line"><span>{model.kind==='mock'?'● 模拟执行 · 不计费':model.executable?'● 真实 API · 可能计费':'○ 连接或协议未就绪'}</span><small title={model.model}>{model.model}</small></div>{model.readiness_error&&<small className="execution-error">{model.readiness_error}</small>}</div>}
        {recipe&&model&&<div className="strategy-control"><div className="parameter-label-row"><label className="field-label" htmlFor="input-strategy">提示词组合方式</label><span className="parameter-help"><button type="button" aria-label="提示词组合方式说明" aria-describedby="input-strategy-help">ⓘ</button><span id="input-strategy-help" role="tooltip">{strategyHelp}</span></span></div><select id="input-strategy" aria-label="提示词组合方式" value={recipe.input_strategy??(model.capabilities.interleaving==='native'?'interleaved':model.capabilities.interleaving==='mediated'?'legacy':'numbered_flat')} onChange={e=>{const strategy=e.target.value;void updateRecipe(r=>({...r,input_strategy:strategy}));}}><option value="auto">按能力选择</option>{defaultInputStrategies.list().map(s=><option key={s.id} value={s.id}>{s.title}</option>)}{model.capabilities.interleaving==='mediated'&&!recipe.input_strategy&&<option value="legacy">旧中介流程（未接入）</option>}</select></div>}
        <div className="parameter-grid"><label>画面比例<select aria-label="画面比例" disabled={!model||recipe?.core_parameters.resolution?.mode==='exact'} value={recipe?.core_parameters.aspect_ratio==='auto'?'auto':model?.capabilities.aspect_ratios.includes(recipe?.core_parameters.aspect_ratio??'')?recipe?.core_parameters.aspect_ratio:'custom'} onChange={e=>{setInvalidCustomRatio(false);changeParameter('aspect_ratio',e.target.value==='custom'?'custom:5:3':e.target.value);}}><option value="auto">自动</option>{model?.capabilities.aspect_ratios.filter(v=>v!=='auto').map(value=><option key={value}>{value}</option>)}<option value="custom">自定义</option></select></label>
          {model&&contractFor(model).quality_control&&<label>质量<select aria-label="质量" disabled={!model} value={recipe?.core_parameters.quality??''} onChange={e=>changeParameter('quality',e.target.value)}>{model?.capabilities.qualities.map(value=><option key={value}>{value}</option>)}</select></label>}
          <label>输出格式<select aria-label="输出格式" disabled={!model} value={recipe?.core_parameters.output_format??'png'} onChange={e=>changeParameter('output_format',e.target.value as Parameters['output_format'])}>{model?.capabilities.formats.map(value=><option key={value} value={value} >{value.toUpperCase()}</option>)}</select></label>
          <label>输出数量<select aria-label="输出数量" disabled={!model} value={recipe?.core_parameters.count??1} onChange={e=>changeParameter('count',Number(e.target.value))}>{Array.from({length:model?.capabilities.max_count??1},(_,i)=><option key={i} value={i+1}>{i+1} </option>)}</select></label>
        {recipe&&recipe.core_parameters.aspect_ratio!=='auto'&&!model?.capabilities.aspect_ratios.includes(recipe.core_parameters.aspect_ratio)&&<label className="field-label">自定义宽:高<input aria-label="自定义宽高比" maxLength={13} onChange={e=>setInvalidCustomRatio(!parseRatio(e.target.value.trim().replace('：',':')))} key={`${recipe.recipe_id}:${recipe.core_parameters.aspect_ratio}`} defaultValue={recipe.core_parameters.aspect_ratio.replace(/^custom:/,'')} placeholder="例如 5:3" onBlur={e=>{const value=e.target.value.trim().replace('：',':');if(!parseRatio(value)){setError('请填写正数宽:高，例如 5:3。');return;}changeParameter('aspect_ratio',`custom:${value}`);}}/></label>}
        {model&&recipe&&<GenerationOptionsPanel model={model} parameters={recipe.core_parameters} references={assets.filter(a=>recipe.modules.some(m=>m.enabled&&m.asset_ids.includes(a.asset_id)))} onChange={patch=>void updateRecipe(r=>({...r,core_parameters:updateParameters(r.core_parameters,typeof patch==='function'?patch(r.core_parameters):patch,model)}))}/>}
        </div>
        {geometryNote&&<p className="notice">{geometryNote}{recipe?.core_parameters.aspect_ratio.startsWith('custom:')?' · 表达期望，实际输出可能不同':''}</p>}
        <button className="generate-button" onClick={run} disabled={!project||!model?.executable||!!view?.adaptation_error||invalidCustomRatio}><span>✦ {model?.kind==='mock'?'运行模拟生成':model?.executable?'生成图片':'生成（未就绪）'}</span><small>{activeCount?`${activeCount} 个任务执行／等待中`:'配方快照 → 任务 → 新版本'}</small></button>
        {latestJob&&<div className="task-progress"><div><b>{statusLabels[latestJob.status]}</b><small>{latestJob.progress}%</small></div><progress max={100} value={latestJob.progress}/><p>{latestJob.stage}</p>{!['failed','succeeded','cancelled'].includes(latestJob.status)&&<button className="text-button" onClick={()=>void dispatch({type:'job:cancel',task_id:latestJob.task_id})}>取消任务</button>}</div>}
      </section>
      <section className="input-inspector"><div className="inspector-tabs"><button className={tab==='chain'?'selected':''} onClick={()=>setTab('chain')}>富媒体链</button><button className={tab==='history'?'selected':''} onClick={()=>setTab('history')}>任务记录 <span>{project?.jobs.length??0}</span></button></div>
        {tab==='chain'?<><div className="inspector-intro"><span>当前配方的输入预览</span><small>{view?.chain?.blocks.length??0} 个内容块 · 可反查模块</small></div>
          {view?.adaptation_error&&<div className="notice warning">{view.adaptation_error}</div>}
          {view?.adaptation?.adjustments.map(a=><div className="notice warning" key={a}>{a}</div>)}
          <div className="block-list">{view?.chain?.blocks.map((b,i)=><div className={`input-block ${b.type}`} key={`${b.source_module_id}-${i}`}><div><span>{String(i+1).padStart(2,'0')}</span><b>{b.type==='text'?'TextBlock':'ImageBlock'}</b><small>{b.type==='image'?b.image_name??b.reference_type:b.model_name??b.reference_type}</small></div>{b.type==='text'?<p>{describeInputBlock(b,recipe?.modules.find(m=>m.module_id===b.source_module_id),view?.module_definitions.find(d=>d.type===b.reference_type))}</p>:<div className="image-block-content">{usableThumbnail(assets.find(a=>a.asset_id===b.asset_id))?<img src={assets.find(a=>a.asset_id===b.asset_id)!.preview_url} alt="输入参考"/>:<span className="missing-image-label">图片缺失</span>}<span>{assets.find(a=>a.asset_id===b.asset_id)?.name??b.asset_id}</span></div>}<code>{b.reference_id}</code></div>)}
          {!view?.chain?.blocks.length&&<div className="small-empty">≡<span>填写提示词或添加参考图</span><small>{isDraft?'首次加入素材或生成时创建项目':'停止编辑约 2 秒后自动保存'}</small></div>}</div></>:<div className="job-list">{[...(project?.jobs??[])].reverse().map(job=><article className="job-card" key={job.task_id}><div><span className={`job-status ${job.status}`}>{statusLabels[job.status]}</span><small>{new Date(job.created_at).toLocaleTimeString('zh-CN')}</small></div><b>{job.model_snapshot.title}</b><p>{job.stage}</p>{job.error&&<p className="error-text">{job.error}</p>}<code>{job.task_id.slice(-12)}</code><div className="job-actions">{job.status==='failed'&&job.recoverable_result&&<button onClick={()=>void dispatch({type:'job:recover-result',task_id:job.task_id},'已恢复本地结果，未调用 API')}>恢复本地结果</button>}<button onClick={async()=>{if(await dispatch({type:'job:restore',task_id:job.task_id},job.mask_edit?'已恢复局部编辑草稿':'已复用历史配方，功能指令采用当前定义')){if(job.mask_edit){setMaskFresh(false);setMaskTaskId(job.task_id);setMaskSource(job.mask_edit.draft.source_asset_id);}}}}>{job.mask_edit?'恢复局部编辑':'恢复配方'}</button>{job.output_asset_ids.some(id=>assets.some(a=>a.asset_id===id&&visibleResult(a)))?<button onClick={()=>void selectResult(job.output_asset_ids.find(id=>assets.some(a=>a.asset_id===id&&visibleResult(a)))!)}>查看结果</button>:job.output_asset_ids.length>0&&<span className="missing-image-label">结果已删除或缺失</span>}{!['succeeded','failed','cancelled'].includes(job.status)&&<button onClick={()=>void dispatch({type:'job:cancel',task_id:job.task_id})}>取消</button>}</div></article>)}{!project?.jobs.length&&<div className="small-empty">↺<span>尚无生成记录</span><small>每次执行保存独立快照</small></div>}</div>}
      </section></>}</aside>
    </div>
    <footer className="app-status"><span>● {saveLabel}<i> / </i>{isDraft?'临时调整不保存为启动预设':view?.project_format==='ediro'?'素材与结果保存在工程内':'旧目录工程 · 外部素材引用'}</span><span title={view?.project_location??''}>{view?.project_location??(isDraft?'加入素材或生成时保存到默认项目目录':'正在准备工作台')}</span></footer>
    {fileDrag&&<div className="file-drop-hint">放入图片添加素材 · 放入 .ediro 打开工程</div>}
    {editingModule&&editor&&<ModuleEditor key={editor.id} module={editingModule} description={view?.module_definitions.find(d=>d.type===editingModule.reference_type)?.description} initialText={editor.text} inferenceTask={view?.module_definitions.find(d=>d.type===editingModule.reference_type)?.inference_task} inference={api&&project?{api,project_id:project.project_id,models:view?.models??[],default_model_id:view?.assignments?.understanding_default}:undefined} functional={view?.module_definitions.find(d=>d.type===editingModule.reference_type)?.editor_kind==='generated_reference'} onClose={()=>setEditor(null)} onSave={(text,tool)=>tool?dispatch({type:'module:tool',module_id:editingModule.module_id,png_base64:tool.png,state:tool.state,instruction:text},'功能参考已更新，工程自动保存'):updateRecipe(r=>({...r,modules:r.modules.map(m=>m.module_id===editingModule.module_id?{...m,user_instruction:text}:m)}))}/>}
    {toast&&<div className="toast" role="status">✓ {toast}</div>}
    {(error||view?.save_error)&&<div className="error-banner" role="alert"><span>{error||view?.save_error}</span>{view?.save_error&&<button onClick={()=>void flushEditors()}>重试保存</button>}<button aria-label="关闭错误提示" onClick={()=>setError('')}>×</button></div>}
    {hostDialogs[0]?<AppDialog key={hostDialogs[0].id} title={hostDialogs[0].message} onDismiss={()=>answerHost(hostDialogs[0].cancelId)} actions={hostDialogs[0].buttons.map((label,index)=>({label,primary:index===hostDialogs[0].defaultId,run:()=>answerHost(index)}))}>{hostDialogs[0].detail}</AppDialog>:notices[0]?<AppDialog key={notices[0].id} title={notices[0].title} onDismiss={()=>setNotices(items=>items.slice(1))} actions={[
      {label:'重试',run:async()=>{const notice=notices[0];if(viewRef.current?.project?.project_id!==notice.projectId)throw new Error('工程已切换，请回到原工程后重试。');if(await dispatch(notice.retry,undefined,false))setNotices(items=>items.filter(item=>item.id!==notice.id));else throw new Error(lastDispatchError.current||'重试未完成，请点击“知道了”返回修改。');}},
      {label:'知道了',primary:true,run:()=>setNotices(items=>items.slice(1))},
    ]}>{notices[0].detail}</AppDialog>:showNew&&<AppDialog title="开始一份新工作？" onDismiss={()=>setShowNew(false)} actions={[{label:'取消',run:()=>setShowNew(false)},{label:'开始新工作',primary:true,run:async()=>{setShowNew(false);await dispatch({type:'project:create',name:'未命名工作'},'新工作已准备');}}]}>{isDraft?'当前空白界面的临时调整将清空。':'当前项目会先保存。'}<br/>新工作使用初始空界面和默认模型，加入素材或生成时才创建项目。</AppDialog>}
    {showRecents&&<ProjectHistory records={view?.recent_workspaces??[]} currentId={view?.project_record_id??view?.project_location?.split(/[\\/]/).at(-1)} dispatch={async(command,message)=>{if(command.type==='workspace:remove'&&command.id===viewRef.current?.project_record_id&&!(await flushEditors()))return false;return dispatch(command,message);}} onClose={()=>setShowRecents(false)}/>}
  </div>;
}
