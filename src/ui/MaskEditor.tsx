import {useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {MaskCrop,MaskDraft,MaskStroke} from '../core/mask.js';
import type {Command,ViewAsset,WorkspaceView} from '../shared/api.js';
import {MaskCanvas} from './MaskCanvas.js';
import {ImagePreview} from './ImagePreview.js';
import {useMaskPreview} from './useMaskPreview.js';
import {useCompositeMask} from './useCompositeMask.js';
import {sameMaskStrokes,currentMaskFeather} from '../core/mask.js';
import {maskEditMethod,planMaskRequest} from '../core/mask-request.js';
import {fittedViewport} from './image-viewport.js';

import {defaultMaskModel,maskEditorEntry} from './mask-editor-state.js';
import type {DesktopApi} from '../shared/api.js';
import './mask.css';

export function MaskEditor({source:selectedSource,state,canvas,dispatch,onClose,onContinue,api,fresh=false,resumeTaskId}:{source:ViewAsset;state:WorkspaceView;canvas:HTMLElement|null;dispatch:(command:Command)=>Promise<boolean>;onClose:()=>void;onContinue:(assetId:string)=>void;api:DesktopApi;fresh?:boolean;resumeTaskId?:string}){
  const project=state.project!,models=state.models.filter(m=>m.enabled&&maskEditMethod(m));
  const [entry]=useState(()=>maskEditorEntry(project,selectedSource.asset_id,{fresh,taskId:resumeTaskId}));
  const source=state.assets.find(a=>a.asset_id===entry.sourceId)??selectedSource;
  const generationSource=state.assets.find(a=>a.asset_id===entry.snapshotId)??source;
  const [chosenTask,setChosenTask]=useState(entry.taskId);
  const defaultModel=defaultMaskModel(models,state.assignments?.editing_default);
  const [draft,setDraft]=useState<MaskDraft>(()=>{const initial:MaskDraft=structuredClone(entry.draft??{source_asset_id:source.asset_id,width:source.width,height:source.height,strokes:[],instruction:'',model_config_id:defaultModel?.model_config_id??'',quality:defaultModel?.defaults.quality??'auto',mode:'strict',feather:0});if(!entry.taskId)delete initial.resolution;return initial;});
  const current=useRef(draft);current.current=draft;
  const [redo,setRedo]=useState<MaskStroke[][]>([]),[tool,setTool]=useState<'paint'|'erase'|'pan'|'crop'>('paint'),[size,setSize]=useState(Math.max(10,Math.round(source.width/24))),[visible,setVisible]=useState(true),[busy,setBusy]=useState(false),[saved,setSaved]=useState(''),[display,setDisplay]=useState<'mask'|'result'|'raw'>(entry.display),[viewport,setViewport]=useState(fittedViewport);
  const undoStack=useRef<MaskStroke[][]>([]);
  const dirty=useRef(false),awaiting=useRef(false),seen=useRef<string|null>(null);
  const model=models.find(m=>m.model_config_id===draft.model_config_id);
  const guided=!!model&&maskEditMethod(model)==='guided';
  const cropPlan=useMemo<{crop?:MaskCrop;parameters?:ReturnType<typeof planMaskRequest>['parameters'];error?:string}>(()=>{if(!model||!draft.strokes.some(s=>s.tool==='paint'))return {};try{return planMaskRequest(draft,model);}catch(error){return {error:error instanceof Error?error.message:'无法确定送入范围'};}},[draft.strokes,draft.crop,draft.context_padding,draft.width,draft.height,draft.quality,draft.resolution,model]);
  const cropResolution=cropPlan.parameters?.resolution;
  const geometryIssue=cropPlan.error??'';
  const jobs=project.jobs.filter(j=>j.mask_edit?.draft.source_asset_id===entry.sourceId),job=jobs.find(j=>j.task_id===chosenTask)??jobs.at(-1);
  const active=jobs.find(j=>['queued','preparing','running','post_processing'].includes(j.status));
  useEffect(()=>{if(active){setChosenTask(active.task_id);awaiting.current=true;}},[active?.task_id]);
  const composite=useCompositeMask(project.project_id,job?.task_id,job?.mask_edit,dispatch,job?.task_id===entry.taskId?entry.strokes:undefined);
  const [resultVisible,setResultVisible]=useState(false),[liveResultStroke,setLiveResultStroke]=useState<MaskStroke|null>(null);
  useEffect(()=>{setLiveResultStroke(null);if(display!=='mask')setTool(t=>t==='crop'?'paint':t);},[job?.task_id,display,draft.mode]);
  const update=(patch:Partial<MaskDraft>)=>{dirty.current=true;setSaved('未保存');setDraft(d=>({...d,...patch}));};
  const flush=async()=>{if(!dirty.current)return true;const snapshot=current.current;setSaved('同步中…');const ok=await dispatch({type:'mask:save-draft',project_id:project.project_id,draft:snapshot});if(current.current===snapshot){dirty.current=!ok;setSaved(ok?'草稿已同步，工程自动保存':'保存失败，草稿仍在此窗口');}return ok;};
  useEffect(()=>{const submit=(event:Event)=>{(event as CustomEvent<Promise<boolean>[]>).detail.push(flush(),composite.flush());};window.addEventListener('ediro:flush-editors',submit);return()=>window.removeEventListener('ediro:flush-editors',submit);});
  useEffect(()=>{if(!dirty.current)return;const timer=setTimeout(()=>void flush(),450);return()=>clearTimeout(timer);},[draft]);
  useEffect(()=>{
    if(!job||seen.current===`${job.task_id}:${job.status}`)return;
    const recovered=seen.current===`${job.task_id}:failed`&&job.status==='succeeded';
    seen.current=`${job.task_id}:${job.status}`;
    if((awaiting.current||recovered)&&['succeeded','failed','cancelled'].includes(job.status)){
      awaiting.current=false;
      if(job.mask_edit?.raw_asset_ids.length){setDisplay('result');setViewport(fittedViewport());}
    }
  },[job?.task_id,job?.status]);
  const changeStrokes=(strokes:MaskStroke[])=>{undoStack.current.push(current.current.strokes);setRedo([]);update({strokes});};
  const undo=()=>{const previous=undoStack.current.pop();if(previous){setRedo(r=>[...r,current.current.strokes]);update({strokes:previous});}else if(draft.strokes.length){setRedo(r=>[...r,current.current.strokes]);update({strokes:draft.strokes.slice(0,-1)});}};
  const redoStroke=()=>{const next=redo.at(-1);if(next){undoStack.current.push(current.current.strokes);setRedo(r=>r.slice(0,-1));update({strokes:next});}};
  const run=async()=>{setBusy(true);if(!await composite.flush()){setBusy(false);return;}setChosenTask(undefined);awaiting.current=true;const ok=await dispatch({type:'mask:start',project_id:project.project_id,draft:current.current});if(!ok)awaiting.current=false;else{dirty.current=false;setSaved('草稿已保存');}setBusy(false);};
  const close=async()=>{setBusy(true);if(await flush()&&await composite.flush())onClose();else setBusy(false);};
  const rawId=job?.mask_edit?.raw_asset_ids[0];
  const raw=state.assets.find(a=>a.asset_id===rawId);
  const resultTools=display==='result'&&draft.mode==='strict'&&!!raw;
  const resultStrokes=liveResultStroke?[...composite.strokes,liveResultStroke]:composite.strokes;
  const reprocess=async()=>{
    if(!job)return;setBusy(true);if(!await composite.flush()){setBusy(false);return;}const ok=await dispatch({type:'mask:reprocess',project_id:project.project_id,task_id:job.task_id,mode:draft.mode,feather:draft.feather,composite_strokes:composite.strokes});
    if(ok){setDisplay('result');setViewport(fittedViewport());}setBusy(false);
  };
  // Existing variants are deterministic and require no second model request.
  const variant=job?.mask_edit?.variants.find(v=>currentMaskFeather(v)&&v.mode===draft.mode&&(draft.mode==='natural'||v.feather===draft.feather&&sameMaskStrokes(v.composite_strokes??job.mask_edit!.draft.strokes,resultStrokes)));
  const processed=state.assets.find(a=>a.asset_id===variant?.asset_id&&!a.removed_result);
  const preview=useMaskPreview(api,project.project_id,job?.task_id,raw,draft.mode,draft.feather,processed,display==='result',resultStrokes,job?.mask_edit?.crop?{width:job.mask_edit.draft.width,height:job.mask_edit.draft.height}:undefined);
  const result=display==='result'?preview.asset:raw;
  const frozenBase=state.assets.find(a=>a.asset_id===job?.mask_edit?.source_snapshot_id)??source;
  const treatment=(patch:Partial<MaskDraft>)=>{update(patch);if(rawId)setDisplay('result');};
  return <>
    {canvas&&createPortal(<div className="mask-canvas-shell"><div className="mask-view-tabs"><button className="mask-back" disabled={busy} onClick={()=>void close()}>← 返回工作台</button><button className={display==='mask'?'selected':''} onClick={()=>setDisplay('mask')}>绘制蒙版</button><button disabled={!rawId} className={display==='result'?'selected':''} onClick={()=>setDisplay('result')}>修改结果</button><button disabled={!rawId} className={display==='raw'?'selected':''} onClick={()=>setDisplay('raw')}>模型原始返回</button><span>{display==='raw'&&raw?raw.width:source.width} × {display==='raw'&&raw?raw.height:source.height}</span></div>
      <div className="mask-preview-body">{display==='mask'?<MaskCanvas key="generation" asset={generationSource} draft={draft} crop={cropPlan.crop??draft.crop} onCrop={crop=>{update({crop});setTool('paint');}} tool={tool} size={size} visible={visible} disabled={!!active||busy} onStroke={stroke=>changeStrokes([...current.current.strokes,stroke])}/>:resultTools&&!preview.error?<MaskCanvas key={`composite-${job!.task_id}`} resultMode crop={job!.mask_edit!.crop} asset={result??frozenBase} draft={{...job!.mask_edit!.draft,strokes:composite.strokes}} tool={tool} size={size} visible={resultVisible} disabled={!!active||busy} onStroke={stroke=>composite.change([...composite.strokes,stroke])} onLiveStroke={setLiveResultStroke}/>:result?<ImagePreview key={result.asset_id} asset={result} view={viewport} onChange={setViewport}/>:<div className="small-empty">{preview.error??(preview.pending?'正在更新处理预览…':'等待修改结果')}</div>}{resultTools&&<div className="mask-result-feedback" role="status">{preview.error??(preview.pending?'正在更新合成预览…':job?.mask_edit?.crop?'框内补画采用模型内容 · 减选恢复原图':'画笔采用模型内容 · 减选恢复原图')}</div>}</div>
    </div>,canvas)}
    <section className="mask-editor" aria-label="局部编辑面板">
      <header><div><span className="eyebrow">LOCAL EDIT</span><h2>局部编辑</h2></div><button onClick={()=>void close()} disabled={busy} aria-label="退出局部编辑">×</button></header>
      <div className="mask-source"><img src={source.preview_url} alt="编辑源图"/><div><b>当前底图</b><span title={source.name}>{source.name}</span><small>{saved||'独立编辑 · 保留原图'}</small></div></div>
      <div className="mask-settings">
        <fieldset disabled={busy||!!active||display==='raw'||display==='result'&&draft.mode==='natural'}><legend className="mask-tools-heading"><span>{resultTools?'结果合成蒙版':'蒙版工具'}</span><label className="mask-check"><input type="checkbox" disabled={busy||!!active||display==='raw'||display==='result'&&draft.mode==='natural'} checked={resultTools?resultVisible:visible} onChange={e=>resultTools?setResultVisible(e.target.checked):setVisible(e.target.checked)}/>显示蒙版</label></legend><div className="mask-tool-row">{([['paint','画笔'],['erase','减选'],['pan','抓手']] as const).map(([value,title])=><button key={value} aria-pressed={tool===value} className={tool===value?'selected':''} onClick={()=>setTool(value)}>{title}</button>)}</div>
          <label>画笔大小 <span>{size} px</span><input aria-label="蒙版画笔大小" type="range" min="1" max={Math.min(1000,Math.max(source.width,source.height)/2)} value={size} onChange={e=>setSize(Number(e.target.value))}/></label>
          <div className="mask-tool-row"><button onClick={resultTools?composite.undo:undo} disabled={resultTools?!composite.canUndo:!draft.strokes.length&&!undoStack.current.length}>撤销</button><button onClick={resultTools?composite.redo:redoStroke} disabled={resultTools?!composite.canRedo:!redo.length}>重做</button><button onClick={()=>resultTools?composite.change([]):changeStrokes([])} disabled={!(resultTools?composite.strokes:draft.strokes).length}>清空</button></div>
          {resultTools&&<><button className="mask-reprocess" onClick={()=>composite.change(structuredClone(job!.mask_edit!.draft.strokes))}>恢复生成时的选区</button><p className="mask-hint">{composite.status}</p></>}
        </fieldset>
        {display==='mask'&&<fieldset disabled={busy||!!active}><legend className="mask-crop-heading">剪切范围{cropPlan.crop&&<small>—— {cropPlan.crop.width}px × {cropPlan.crop.height}px{cropResolution?.mode==='tier'?`（${cropResolution.value}）`:''}</small>}</legend>
          <label>周边范围 <span>{draft.context_padding??128} px</span><input aria-label="周边范围" type="range" min="0" max="1024" step="16" value={draft.context_padding??128} onChange={e=>update({context_padding:Number(e.target.value),crop:undefined})}/></label>
          <div className="mask-tool-row"><button className={tool==='crop'?'selected':''} aria-pressed={tool==='crop'} onClick={()=>setTool(t=>t==='crop'?'paint':'crop')}>拖框调整范围</button><button onClick={()=>{update({crop:undefined});setTool('paint');}}>恢复自动范围</button></div>
          {tool==='crop'&&<p className="mask-hint">拖框需包含全部选区。</p>}
        </fieldset>}
        <fieldset disabled={busy||!!active}><legend>编辑设置</legend>
          <label className="mask-model-field">局部编辑模型<select aria-label="局部编辑模型" value={draft.model_config_id} onChange={e=>{const m=models.find(m=>m.model_config_id===e.target.value)!;update({model_config_id:m.model_config_id,quality:m.defaults.quality,resolution:undefined});}}><option value="" disabled>选择局部编辑模型</option>{!model&&draft.model_config_id&&<option value={draft.model_config_id}>原编辑模型不可用</option>}{models.map(m=><option key={m.model_config_id} value={m.model_config_id}>{state.connections?.find(c=>c.connection_id===m.connection_id)?.title?`${state.connections.find(c=>c.connection_id===m.connection_id)!.title} · `:''}{m.title}</option>)}</select></label>
          {model?.kind==='mock'?<p className="mask-hint">模拟编辑 · 不计费</p>:model&&!model.executable?<p className="mask-warning">{model.readiness_error??'编辑模型尚未就绪'}</p>:!model&&<p className="mask-warning">请在模型管理中配置支持局部编辑的接入。</p>}
          {!guided&&<label>编辑质量<select aria-label="编辑质量" value={draft.quality} onChange={e=>update({quality:e.target.value})}>{model?.capabilities.qualities.map(q=><option key={q}>{q}</option>)}</select></label>}
        </fieldset>
        <fieldset disabled={busy||!!active}><legend>结果处理</legend><div className="mask-mode-options"><button title="按蒙版合回底图，严格保留选区外内容，输出 PNG。" aria-pressed={draft.mode==='strict'} className={draft.mode==='strict'?'selected':''} onClick={()=>treatment({mode:'strict'})}><b>蒙版合成</b></button><button title={job?.mask_edit?.crop||!rawId?'采用送入范围的返回内容，框外不变。':'采用整张返回图，周围可能变化。'} aria-pressed={draft.mode==='natural'} className={draft.mode==='natural'?'selected':''} onClick={()=>treatment({mode:'natural'})}><b>自然融合</b></button></div>
          {draft.mode==='strict'&&<label>向内羽化 <span>{draft.feather} px</span><input aria-label="向内羽化" type="range" min="0" max="64" value={draft.feather} onChange={e=>treatment({feather:Number(e.target.value)})}/></label>}
          {geometryIssue&&<p className="mask-warning">{geometryIssue}</p>}
        </fieldset>
        {job&&<div className="mask-job"><b>{active?'正在生成局部修改':job.status==='succeeded'?(job.output_asset_ids.length?'结果版本已保存':'等待预览确认'):job.status==='cancelled'?'已取消':job.status==='failed'?'局部修改未完成':'编辑任务'}</b>{(job.error||job.status!=='succeeded')&&<p>{job.error??job.stage}</p>}{active&&<button onClick={()=>void dispatch({type:'job:cancel',task_id:active.task_id})}>取消任务</button>}{job.recoverable_result&&job.status==='failed'&&<button onClick={()=>void dispatch({type:'job:recover-result',task_id:job.task_id})}>恢复本地结果</button>}</div>}
      </div>
      <footer>{display==='result'&&rawId?<><p className="mask-hint">本地合成 · 不再次调用模型</p><button className="primary mask-generate" disabled={busy||!!active||(!!processed&&!job?.error)||preview.pending||!!preview.error||!!liveResultStroke} onClick={()=>void reprocess()}>{processed&&!job?.error?'此处理版本已保存':preview.pending?'正在更新预览…':'确认保存此版本'}</button><button className="mask-continue" disabled={busy||!!active} onClick={()=>setDisplay('mask')}>返回绘制蒙版与生成</button></>:<><label htmlFor="mask-instruction">局部编辑指令</label><textarea id="mask-instruction" aria-label="局部编辑指令" value={draft.instruction} maxLength={32000} disabled={busy||!!active} onChange={e=>update({instruction:e.target.value})} placeholder="描述选中区域需要如何修改…"/>
        <button className="primary mask-generate" onClick={()=>void run()} disabled={busy||!!active||!model?.executable||!!geometryIssue||!draft.strokes.length||!draft.instruction.trim()}>{active?'正在生成…':model?.kind==='mock'?'模拟局部修改':'生成局部修改'}</button></>}
        {display==='result'&&processed&&<button className="mask-continue" disabled={busy||!!active||!!liveResultStroke} onClick={async()=>{if(await flush()&&await composite.flush())onContinue(processed.asset_id);}}>基于此版本继续编辑 →</button>}
      </footer>
    </section>
  </>;
}
