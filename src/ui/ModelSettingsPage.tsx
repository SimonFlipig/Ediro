import { forwardRef,useEffect,useImperativeHandle,useRef,useState } from 'react';
import { newId } from '../core/domain.js';
import type { PublicConnection } from '../core/model-library.js';
import type { Command,WorkspaceView,ApiResponse } from '../shared/api.js';
import { familyForModel,modelFamilies } from '../protocols/model-catalog.js';
import { ModelSettingsEditor,type DraftHandle } from './ModelSettingsEditor.js';
import { PlatformSettingsPane } from './PlatformSettingsPane.js';
import { ModelEnrollment } from './ModelEnrollment.js';
import { ModelPlatformPicker } from './ModelPlatformPicker.js';
import { AppDialog } from './AppDialog.js';
import { SettingsConfirmation } from './SettingsConfirmation.js';
import { SettingsPageHeader } from './SettingsPageHeader.js';
import './model-settings.css';

export interface SettingsPageHandle {requestClose:()=>void}
type DraftTarget='model'|'platform';
type PlatformForm={connection:PublicConnection;addAfterSave:boolean;returnTo?:{platform:string;selected:string}};
type PendingChange={action:(saved?:boolean)=>void;targets:DraftTarget[]};
export const ModelSettingsPage=forwardRef<SettingsPageHandle,{view:WorkspaceView;initialModel?:string;onClose:()=>void;onModules:()=>void;onPrompts:()=>void;onSave:(command:Command)=>Promise<boolean>;onProbe:(command:Command)=>Promise<ApiResponse>}>(function ModelSettingsPage({view,initialModel,onClose,onModules,onPrompts,onSave,onProbe},ref){
  const [platform,setPlatform]=useState('all'),[selected,setSelected]=useState(initialModel??view.models.find(m=>m.kind==='cloud')?.model_config_id??view.models[0]?.model_config_id??'');
  const [platformQuery,setPlatformQuery]=useState(''),[modelQuery,setModelQuery]=useState('');
  const [platformForm,setPlatformForm]=useState<PlatformForm|null>(null),[enrollment,setEnrollment]=useState<{connectionId:string;open:boolean;version:number}|null>(null);
  const [pickingPlatform,setPickingPlatform]=useState(false);
  const [busy,setBusy]=useState(false),[flowBusy,setFlowBusy]=useState(false),[pending,setPending]=useState<PendingChange|null>(null),[editorVersion,setEditorVersion]=useState(0),[platformVersion,setPlatformVersion]=useState(0),[notice,setNotice]=useState('');
  const [removal,setRemoval]=useState<{command:Command;title:string;description:string;label:string}|null>(null);
  const saving=useRef(false),working=useRef(false),editor=useRef<DraftHandle>(null),platformEditor=useRef<DraftHandle>(null),latestView=useRef(view);
  const platformToggle=useRef<HTMLButtonElement>(null),addPlatformButton=useRef<HTMLButtonElement>(null),addModelButton=useRef<HTMLButtonElement>(null);
  const enrollmentHost=useRef<HTMLDivElement>(null);
  latestView.current=view;
  const focusPlatform=()=>requestAnimationFrame(()=>(platformToggle.current??addPlatformButton.current)?.focus({preventScroll:true}));
  const closeEnrollment=()=>{setEnrollment(current=>current?{...current,open:false}:null);requestAnimationFrame(()=>addModelButton.current?.focus({preventScroll:true}));};
  const locked=busy||flowBusy;
  const draft=(target:DraftTarget)=>target==='model'?editor.current:platformEditor.current;
  const guard=(action:(saved?:boolean)=>void,targets:DraftTarget[]=['model','platform'])=>{
    if(saving.current||working.current||removal||pending)return;
    const dirty=targets.filter(target=>draft(target)?.dirty);
    if(dirty.length)setPending({action,targets:dirty});else action();
  };
  const resetDrafts=(targets:DraftTarget[])=>{if(targets.includes('model'))setEditorVersion(v=>v+1);if(targets.includes('platform'))setPlatformVersion(v=>v+1);};
  useImperativeHandle(ref,()=>({requestClose:()=>pickingPlatform?setPickingPlatform(false):guard(onClose)}));
  const save=async(command:Command)=>{
    if(saving.current)return false;saving.current=true;setBusy(true);
    try{
      const previous=command.type==='connection:save'?latestView.current.connections?.find(c=>c.connection_id===command.connection.connection_id):undefined;
      const ok=await onSave(command);
      if(ok&&command.type==='connection:save'&&(previous?.endpoint!==command.connection.endpoint||previous?.adapter_id!==command.connection.adapter_id||command.secret||command.clear_credential))setEnrollment(null);
      return ok;
    }finally{saving.current=false;setBusy(false);}
  };
  const setWorking=(value:boolean)=>{working.current=value;setFlowBusy(value);};
  const hasLocalModels=view.models.some(m=>m.kind!=='cloud'),hasMockModels=view.models.some(m=>m.kind==='mock');
  const localTitle=hasMockModels?'模拟与本地':'本地模型';
  const matchesPlatform=(m:WorkspaceView['models'][number],id=platform)=>id==='all'||id==='local'&&m.kind!=='cloud'||m.connection_id===id;
  const platformModels=view.models.filter(m=>matchesPlatform(m));
  const familyTitle=(m:WorkspaceView['models'][number])=>modelFamilies.find(f=>f.id===familyForModel(m))?.title??'自定义';
  const models=platformModels.filter(m=>`${m.title} ${m.model} ${familyTitle(m)}`.toLowerCase().includes(modelQuery.toLowerCase()));
  const model=platformModels.find(m=>m.model_config_id===selected),connection=view.connections?.find(c=>c.connection_id===platform);
  const enrollmentConnection=view.connections?.find(c=>c.connection_id===enrollment?.connectionId);
  useEffect(()=>{
    if(platform==='local'&&!hasLocalModels){setPlatform('all');setModelQuery('');setSelected(view.models[0]?.model_config_id??'');return;}
    if(!model)setSelected(platformModels[0]?.model_config_id??'');
  },[model,platformModels,platform,hasLocalModels,view.models]);
  const choosePlatform=(id:string)=>{if(id===platform)return;guard(()=>{setPlatform(id);setModelQuery('');setNotice('');setSelected(view.models.find(m=>matchesPlatform(m,id))?.model_config_id??'');setPlatformForm(null);setEnrollment(null);});};
  const closePlatform=()=>guard(saved=>{
    if(!saved&&platformForm?.returnTo&&!latestView.current.connections?.some(c=>c.connection_id===platformForm.connection.connection_id)){
      setPlatform(platformForm.returnTo.platform);setSelected(platformForm.returnTo.selected);
    }
    setPlatformForm(null);focusPlatform();
  },['platform']);
  const editConnection=(c?:PublicConnection,addAfterSave=false)=>{
    if(c){
      setNotice('');setEnrollment(current=>current?{...current,open:false}:null);
      setPlatformForm({connection:c,addAfterSave});
    }else guard(()=>{
      const created:PublicConnection={connection_id:newId('connection'),title:'新平台',endpoint:'',enabled:true,revision:1,has_credential:false,adapter_id:'gemini-generate-content'};
      setPlatformForm({connection:created,addAfterSave:true,returnTo:{platform,selected}});
      setPlatform(created.connection_id);setSelected('');setModelQuery('');setEnrollment(null);setNotice('');
    });
  };
  const startEnrollment=(c:PublicConnection)=>{
    setNotice('');
    if(!c.enabled||!c.has_credential||!c.endpoint){editConnection(c,true);return;}
    setPlatformForm(null);
    setEnrollment(current=>({connectionId:c.connection_id,open:true,version:current?.connectionId===c.connection_id?current.version:0}));
    requestAnimationFrame(()=>[...enrollmentHost.current?.querySelectorAll<HTMLInputElement>('input:not(:disabled)')??[]].find(input=>input.getClientRects().length)?.focus({preventScroll:true}));
  };
  const chooseEnrollmentPlatform=(c:PublicConnection)=>{
    setPickingPlatform(false);
    const keepModel=model?.connection_id===c.connection_id;
    guard(()=>{
      const target=latestView.current.connections?.find(item=>item.connection_id===c.connection_id);
      if(!target)return;
      setPlatform(target.connection_id);setModelQuery('');
      if(!keepModel)setSelected(latestView.current.models.find(m=>m.connection_id===target.connection_id)?.model_config_id??'');
      setEnrollment(current=>current?.connectionId===target.connection_id?current:null);
      startEnrollment(target);
    },keepModel?['platform']:['model','platform']);
  };
  const enroll=()=>{
    if(!connection){setPickingPlatform(true);return;}
    guard(()=>startEnrollment(connection),['platform']);
  };
  return <section className="global-settings" aria-label="模型库">
    <div inert={pending||removal?true:undefined}><SettingsPageHeader page="models" busy={locked} onModels={()=>{}} onModules={()=>guard(onModules)} onPrompts={()=>guard(onPrompts)} onClose={()=>guard(onClose)}/></div>
    <div className="settings-columns" inert={pending||removal?true:undefined}>
      <aside className="settings-platforms" aria-label="平台导航" inert={locked?true:undefined}>
        <button className={`platform-row ${platform==='all'?'selected':''}`} aria-pressed={platform==='all'} onClick={()=>choosePlatform('all')}><b>全部模型</b><span className="platform-count">{view.models.length}</span></button>
        <div className="settings-section-heading"><h2>我的平台</h2></div>
        {(view.connections?.length??0)>5&&<input aria-label="搜索接口平台" placeholder="搜索平台…" value={platformQuery} onChange={e=>setPlatformQuery(e.target.value)}/>}
        {view.connections?.filter(c=>c.title.toLowerCase().includes(platformQuery.toLowerCase())).map(c=><button className={`platform-row ${platform===c.connection_id?'selected':''}`} aria-pressed={platform===c.connection_id} key={c.connection_id} onClick={()=>choosePlatform(c.connection_id)}><span className={`platform-dot ${!c.enabled||!c.has_credential?'pending':''}`} aria-hidden="true"/><span><b>{c.title}</b><small>{!c.enabled?'已停用':!c.has_credential?'待配置密钥':''}</small></span><span className="platform-count">{view.models.filter(m=>m.connection_id===c.connection_id).length}</span></button>)}
        {platformForm?.returnTo&&!connection&&<div className="platform-row selected"><span><b>新平台</b><small>待保存</small></span></div>}
        <button ref={addPlatformButton} className="platform-row settings-add-platform" onClick={()=>editConnection()}>＋ 添加平台</button>
        {hasLocalModels&&<div className="settings-platform-footer"><button className={`platform-row ${platform==='local'?'selected':''}`} aria-pressed={platform==='local'} onClick={()=>choosePlatform('local')}><span><b>{localTitle}</b><small>{hasMockModels?'本地验证入口':'本地模型接入'}</small></span></button></div>}
      </aside>
        <section className="settings-models" aria-label="已入库模型">
          <div className="settings-library-heading"><div><span className="settings-eyebrow">模型与平台</span><div className="settings-platform-title"><h2>{connection?.title??(platformForm?.returnTo?'添加新平台':platform==='local'?localTitle:'全部模型')}</h2>{connection&&<button ref={platformToggle} className="settings-platform-toggle" disabled={locked} aria-label="平台设置" title="平台设置" aria-expanded={!!platformForm} aria-controls="inline-platform-settings" onClick={()=>platformForm?closePlatform():editConnection(connection)}><span aria-hidden="true">⚙</span></button>}</div><p>{connection?`${view.adapters?.find(a=>a.adapter_id===connection.adapter_id)?.title??'云端接口'} · ${!connection.enabled?'已停用':connection.has_credential?'密钥已配置':'待配置密钥'}`:platformForm?.returnTo?'保存后即可在这里添加模型。':platform==='local'?(hasMockModels?'用于验证本地工作流程。':'管理本地模型接入。'):'选择平台管理模型，选择模型调整参数。'}</p></div>{!platformForm&&!enrollment?.open&&<button ref={addModelButton} className="primary" disabled={locked} onClick={enroll}>＋ 添加模型</button>}</div>
          {platformForm&&<section id="inline-platform-settings" className="settings-platform-editor" aria-label="平台设置">
            <PlatformSettingsPane key={`${platformForm.connection.connection_id}:${platformVersion}`} ref={platformEditor} connection={view.connections?.find(c=>c.connection_id===platformForm.connection.connection_id)??platformForm.connection} view={view} save={save} busy={locked} onClose={closePlatform} onSaved={(c,invalidateDiscovery)=>{
              setPlatformForm(null);setNotice('平台设置已保存。');focusPlatform();
              setEnrollment(current=>platformForm.addAfterSave&&c.enabled&&c.has_credential&&c.endpoint?{connectionId:c.connection_id,open:true,version:(current?.version??0)+1}:invalidateDiscovery?null:current);
            }} onRemove={()=>setRemoval({command:{type:'connection:delete',connection_id:platformForm.connection.connection_id},title:'删除接口平台',description:`删除「${platformForm.connection.title}」？仍有关联模型的平台无法删除。`,label:'确认删除'})}/>
          </section>}
          {enrollment&&enrollmentConnection&&<div ref={enrollmentHost} hidden={!enrollment.open||!!platformForm}>
            <ModelEnrollment key={`${enrollment.connectionId}:${enrollment.version}`} connection={enrollmentConnection} view={view} save={save} probe={onProbe} busy={busy} onWorkingChange={setWorking} onClose={closeEnrollment} onEnrolled={()=>setNotice('模型已添加，可继续添加或在下方选择模型调整参数。')}/>
          </div>}
          {platform==='all'&&<div className="settings-defaults" aria-label="工作台默认模型">{(['generation','editing','understanding'] as const).map(purpose=>{const entry=view.models.find(m=>m.model_config_id===view.assignments?.[`${purpose}_default`]);return <button key={purpose} disabled={locked||!entry} onClick={()=>guard(()=>entry&&setSelected(entry.model_config_id),['model'])}><span>{{generation:'默认生图',editing:'默认编辑',understanding:'默认推理'}[purpose]}</span><b>{entry?.title??'尚未设置'}</b><small>{view.connections?.find(c=>c.connection_id===entry?.connection_id)?.title??(entry?entry.kind==='mock'?'内置模拟':'本地模型':'')}</small></button>;})}</div>}
          {notice&&<p className="settings-success" role="status">{notice}</p>}
          <div className="settings-model-toolbar"><span>已入库模型 · {models.length}</span><input disabled={locked} aria-label="搜索已入库模型" placeholder="搜索名称、家族或模型 ID" value={modelQuery} onChange={e=>setModelQuery(e.target.value)}/></div>
          <div className="settings-model-list">{models.map(m=><button disabled={locked} key={m.model_config_id} data-model-id={m.model_config_id} className={`settings-model-row ${selected===m.model_config_id?'selected':''}`} aria-pressed={selected===m.model_config_id} onClick={()=>{if(selected!==m.model_config_id)guard(()=>{setSelected(m.model_config_id);setNotice('');},['model']);}}><span className="settings-model-symbol" aria-hidden="true">{m.purpose==='understanding'?'理':'图'}</span><span className="settings-model-copy"><span className="settings-model-name"><b>{m.title}</b>{view.assignments?.[`${m.purpose??'generation'}_default`]===m.model_config_id&&<span className="settings-model-kind">{m.purpose==='understanding'?'默认推理':'默认生图'}</span>}{view.assignments?.editing_default===m.model_config_id&&<span className="settings-model-kind">默认编辑</span>}</span><small>{view.connections?.find(c=>c.connection_id===m.connection_id)?.title??(m.kind==='mock'?'内置模拟':'本地模型')} · {familyTitle(m)}</small><small className="settings-remote-id">{m.model}</small>{(!m.enabled||m.readiness_error)&&<small className="settings-warning">{!m.enabled?'已停用':m.readiness_error}</small>}</span><span aria-hidden="true">›</span></button>)}</div>
          {!models.length&&<div className="settings-empty"><h3>{modelQuery?'没有找到匹配的模型':'这里还没有模型'}</h3><p>{modelQuery?'试试模型名称、家族或模型 ID。':'添加模型后，即可在右侧调整默认参数。'}</p>{!modelQuery&&!enrollment?.open&&!platformForm&&<button disabled={locked} onClick={enroll}>添加第一个模型</button>}</div>}
          <p className="settings-list-footnote">按家族选择模型，按模型保存默认参数。</p>
        </section>
        <section className="settings-model-detail" aria-label="模型参数设置" inert={locked?true:undefined}>{model?<ModelSettingsEditor key={`${selected}:${editorVersion}`} ref={editor} model={model} view={view} save={save} busy={locked} onRemove={()=>setRemoval({command:{type:'model:delete',model_config_id:model.model_config_id},title:'移除模型接入',description:`移除「${model.title}」的当前接口接入？${Object.values(view.assignments??{}).includes(model.model_config_id)?'此模型的默认选择会一并清除。':''}已有工作记录和生成结果会保留。清空自己的模型后，内置模拟引擎会重新显示。`,label:'确认移除'})}/>:<div className="settings-empty"><h2>模型设置</h2><p>添加并选择一个模型，即可调整参数。</p></div>}</section>
    </div>
    {pickingPlatform&&<ModelPlatformPicker connections={view.connections??[]} adapters={view.adapters??[]} onChoose={chooseEnrollmentPlatform} onNewPlatform={()=>{setPickingPlatform(false);editConnection();}} onDismiss={()=>setPickingPlatform(false)}/>}
    {removal&&<SettingsConfirmation title={removal.title} description={removal.description} confirmLabel={removal.label} onCancel={()=>setRemoval(null)} onConfirm={async()=>{const ok=await save(removal.command);if(ok){if(removal.command.type==='connection:delete'){setPlatform('all');setSelected('');setPlatformForm(null);setEnrollment(null);}setRemoval(null);}return ok;}}/>}
    {pending&&<AppDialog title="设置尚未保存" onDismiss={()=>setPending(null)} actions={[{label:'继续编辑',run:()=>setPending(null)},{label:'放弃并切换',run:()=>{const next=pending;resetDrafts(next.targets);setPending(null);next.action();}},{label:'保存并切换',primary:true,run:async()=>{
      for(const target of pending.targets){const current=draft(target);if(current?.dirty&&!await current.save())throw new Error('设置尚未保存，请检查输入后重试。');}
      const next=pending;setPending(null);next.action(true);
    }}]}>{pending.targets.length>1?'模型参数和平台设置都有未保存的修改。':pending.targets[0]==='platform'?'平台设置尚未保存。':'模型参数尚未保存。'}保存后切换，或放弃这次修改。</AppDialog>}
  </section>;
});
