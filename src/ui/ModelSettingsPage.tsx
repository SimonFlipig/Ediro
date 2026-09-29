import { forwardRef,useEffect,useImperativeHandle,useRef,useState } from 'react';
import { newId } from '../core/domain.js';
import type { PublicConnection } from '../core/model-library.js';
import type { Command,WorkspaceView,ApiResponse } from '../shared/api.js';
import { findPreset } from '../protocols/model-catalog.js';
import { ModelSettingsEditor,type DraftHandle } from './ModelSettingsEditor.js';
import { PlatformSettingsPane } from './PlatformSettingsPane.js';
import { ModelEnrollment } from './ModelEnrollment.js';
import { AppDialog } from './AppDialog.js';
import { SettingsConfirmation } from './SettingsConfirmation.js';
import './model-settings.css';

export interface SettingsPageHandle {requestClose:()=>void}
type Screen={kind:'library'}|{kind:'platform';connection:PublicConnection;enrollAfterSave:boolean}|{kind:'enroll';connection:PublicConnection};
export const ModelSettingsPage=forwardRef<SettingsPageHandle,{view:WorkspaceView;initialModel?:string;onClose:()=>void;onSave:(command:Command)=>Promise<boolean>;onProbe:(command:Command)=>Promise<ApiResponse>}>(function ModelSettingsPage({view,initialModel,onClose,onSave,onProbe},ref){
  const [platform,setPlatform]=useState('all'),[selected,setSelected]=useState(initialModel??view.models.find(m=>m.kind==='cloud')?.model_config_id??view.models[0]?.model_config_id??'');
  const [platformQuery,setPlatformQuery]=useState(''),[modelQuery,setModelQuery]=useState('');
  const [screen,setScreen]=useState<Screen>({kind:'library'}),[busy,setBusy]=useState(false),[flowBusy,setFlowBusy]=useState(false),[pending,setPending]=useState<(()=>void)|null>(null),[editorVersion,setEditorVersion]=useState(0),[notice,setNotice]=useState('');
  const [removal,setRemoval]=useState<{command:Command;title:string;description:string;label:string}|null>(null);
  const saving=useRef(false),working=useRef(false),editor=useRef<DraftHandle>(null),platformEditor=useRef<DraftHandle>(null);
  const locked=busy||flowBusy;
  const currentDraft=()=>screen.kind==='platform'?platformEditor.current:screen.kind==='library'?editor.current:null;
  const guard=(action:()=>void)=>{if(saving.current||working.current||removal)return;if(currentDraft()?.dirty)setPending(()=>action);else action();};
  useImperativeHandle(ref,()=>({requestClose:()=>guard(onClose)}));
  const save=async(command:Command)=>{if(saving.current)return false;saving.current=true;setBusy(true);try{return await onSave(command);}finally{saving.current=false;setBusy(false);}};
  const setWorking=(value:boolean)=>{working.current=value;setFlowBusy(value);};
  const matchesPlatform=(m:WorkspaceView['models'][number],id=platform)=>id==='all'||id==='local'&&m.kind!=='cloud'||m.connection_id===id;
  const platformModels=view.models.filter(m=>matchesPlatform(m));
  const models=platformModels.filter(m=>`${m.title} ${m.model} ${findPreset(m.preset_id)?.title??''}`.toLowerCase().includes(modelQuery.toLowerCase()));
  const model=platformModels.find(m=>m.model_config_id===selected),connection=view.connections?.find(c=>c.connection_id===platform);
  useEffect(()=>{if(!model)setSelected(platformModels[0]?.model_config_id??'');},[model,platformModels]);
  const back=()=>{setScreen({kind:'library'});setEditorVersion(v=>v+1);};
  const choosePlatform=(id:string)=>guard(()=>{setPlatform(id);setModelQuery('');setNotice('');setSelected(view.models.find(m=>matchesPlatform(m,id))?.model_config_id??'');back();});
  const editConnection=(c?:PublicConnection,enrollAfterSave=false)=>guard(()=>{setNotice('');setScreen({kind:'platform',enrollAfterSave:enrollAfterSave||!c,connection:c??{connection_id:newId('connection'),title:'新接口平台',endpoint:'',enabled:true,revision:1,has_credential:false,adapter_id:'gemini-generate-content'}});});
  const enroll=()=>{const c=connection??view.connections?.[0];if(!c||!c.has_credential||!c.endpoint){editConnection(c,true);return;}guard(()=>{setNotice('');setScreen({kind:'enroll',connection:c});});};
  return <section className="global-settings" aria-label="模型库">
    <div className="settings-page-heading" inert={pending||removal?true:undefined}><div className="settings-page-title"><span className="settings-wordmark">ediro<span>.</span></span><h1>模型库</h1></div>{locked&&<span role="status">正在处理…</span>}<button disabled={locked} onClick={()=>guard(onClose)}>返回工作台</button></div>
    <div className={`settings-columns ${screen.kind!=='library'?'settings-flow-active':''}`} inert={pending||removal?true:undefined}>
      <aside className="settings-platforms" aria-label="平台导航" inert={locked?true:undefined}>
        <button className={`platform-row ${platform==='all'?'selected':''}`} aria-pressed={platform==='all'} onClick={()=>choosePlatform('all')}><b>全部模型</b><span className="platform-count">{view.models.length}</span></button>
        <div className="settings-section-heading"><h2>我的平台</h2></div>
        {(view.connections?.length??0)>5&&<input aria-label="搜索接口平台" placeholder="搜索平台…" value={platformQuery} onChange={e=>setPlatformQuery(e.target.value)}/>}
        {view.connections?.filter(c=>c.title.toLowerCase().includes(platformQuery.toLowerCase())).map(c=><button className={`platform-row ${platform===c.connection_id?'selected':''}`} aria-pressed={platform===c.connection_id} key={c.connection_id} onClick={()=>choosePlatform(c.connection_id)}><span className={`platform-dot ${!c.enabled||!c.has_credential?'pending':''}`} aria-hidden="true"/><span><b>{c.title}</b><small>{!c.enabled?'已停用':!c.has_credential?'待配置密钥':''}</small></span><span className="platform-count">{view.models.filter(m=>m.connection_id===c.connection_id).length}</span></button>)}
        <button className="platform-row settings-add-platform" onClick={()=>editConnection()}>＋ 添加平台</button>
        <div className="settings-platform-footer"><button className={`platform-row ${platform==='local'?'selected':''}`} aria-pressed={platform==='local'} onClick={()=>choosePlatform('local')}><span><b>模拟与本地</b><small>本地验证入口</small></span></button></div>
      </aside>
      {screen.kind==='library'?<>
        <section className="settings-models" aria-label="已入库模型" inert={locked?true:undefined}>
          <div className="settings-library-heading"><div><span className="settings-eyebrow">YOUR CREATIVE TOOLKIT</span><h2>{connection?.title??(platform==='local'?'模拟与本地':'常用模型，各就其位。')}</h2><p>{connection?`${view.adapters?.find(a=>a.adapter_id===connection.adapter_id)?.title??'云端接口'} · ${!connection.enabled?'已停用':connection.has_credential?'密钥已配置':'待配置密钥'}`:platform==='local'?'用于验证本地工作流程。':'为每一种创作选好工具。'}</p></div><button className="primary" onClick={enroll}>＋ 添加模型</button></div>
          {connection&&<div className="settings-tabs" aria-label="平台内容"><button aria-pressed="true">已入库模型</button><button aria-pressed="false" onClick={()=>editConnection(connection)}>平台设置</button></div>}
          {platform==='all'&&<div className="settings-defaults" aria-label="工作台默认模型">{(['generation','editing','understanding'] as const).map(purpose=>{const entry=view.models.find(m=>m.model_config_id===view.assignments?.[`${purpose}_default`]);return <button key={purpose} disabled={!entry} onClick={()=>guard(()=>entry&&setSelected(entry.model_config_id))}><span>{{generation:'默认生图',editing:'默认编辑',understanding:'默认理解'}[purpose]}</span><b>{entry?.title??'尚未设置'}</b><small>{view.connections?.find(c=>c.connection_id===entry?.connection_id)?.title??(entry?'模拟与本地':'')}</small></button>;})}</div>}
          {notice&&<p className="settings-success" role="status">{notice}</p>}
          <div className="settings-model-toolbar"><span>模型列表 · {models.length}</span><input aria-label="搜索已入库模型" placeholder="搜索名称、预设或模型 ID" value={modelQuery} onChange={e=>setModelQuery(e.target.value)}/></div>
          <div className="settings-model-list">{models.map(m=><button key={m.model_config_id} data-model-id={m.model_config_id} className={`settings-model-row ${selected===m.model_config_id?'selected':''}`} aria-pressed={selected===m.model_config_id} onClick={()=>{if(selected!==m.model_config_id)guard(()=>{setSelected(m.model_config_id);setNotice('');});}}><span className="settings-model-symbol" aria-hidden="true">{m.purpose==='understanding'?'理':'图'}</span><span className="settings-model-copy"><span className="settings-model-name"><b>{m.title}</b>{view.assignments?.[`${m.purpose??'generation'}_default`]===m.model_config_id&&<span className="settings-model-kind">{m.purpose==='understanding'?'默认理解':'默认生图'}</span>}{view.assignments?.editing_default===m.model_config_id&&<span className="settings-model-kind">默认编辑</span>}</span><small>{view.connections?.find(c=>c.connection_id===m.connection_id)?.title??'模拟与本地'} · 预设：{findPreset(m.preset_id)?.title??'自定义'}</small><small className="settings-remote-id">{m.model}</small>{(!m.enabled||m.readiness_error)&&<small className="settings-warning">{!m.enabled?'已停用':m.readiness_error}</small>}</span><span aria-hidden="true">›</span></button>)}</div>
          {!models.length&&<div className="settings-empty"><h3>{modelQuery?'没有找到匹配的模型':'这里还没有模型'}</h3><p>{modelQuery?'试试模型名称、预设或模型 ID。':'添加模型后，即可在右侧调整默认参数。'}</p>{!modelQuery&&<button onClick={enroll}>添加第一个模型</button>}</div>}
          <p className="settings-list-footnote">参数随预设，接入随平台。</p>
        </section>
        <section className="settings-model-detail" aria-label="模型参数设置" inert={locked?true:undefined}>{model?<ModelSettingsEditor key={`${selected}:${editorVersion}`} ref={editor} model={model} view={view} save={save} busy={locked} onRemove={()=>setRemoval({command:{type:'model:delete',model_config_id:model.model_config_id},title:'移除模型接入',description:`移除「${model.title}」的当前接口接入？已有工作记录和生成结果会保留。`,label:'确认移除'})}/>:<div className="settings-empty"><h2>模型设置</h2><p>添加并选择一个模型，即可调整参数。</p></div>}</section>
      </>:<section className="settings-flow" aria-label={screen.kind==='platform'?'平台设置':'模型入库'}>
        {screen.kind==='platform'?<PlatformSettingsPane key={`${screen.connection.connection_id}:${editorVersion}`} ref={platformEditor} connection={screen.connection} view={view} save={save} busy={locked} enrollAfterSave={screen.enrollAfterSave} onClose={()=>guard(back)} onSaved={c=>{setPlatform(c.connection_id);setModelQuery('');if(screen.enrollAfterSave)setScreen({kind:'enroll',connection:c});else{back();setNotice('平台设置已保存。');}}} onRemove={()=>setRemoval({command:{type:'connection:delete',connection_id:screen.connection.connection_id},title:'删除接口平台',description:`删除「${screen.connection.title}」？仍有关联模型的平台无法删除。`,label:'确认删除'})}/>:<ModelEnrollment key={screen.connection.connection_id} connection={screen.connection} view={view} save={save} probe={onProbe} busy={busy} onWorkingChange={setWorking} onClose={()=>guard(back)} onChooseConnection={c=>setScreen({kind:'enroll',connection:c})} onNewConnection={()=>editConnection(undefined,true)} onEnrolled={ids=>{setPlatform(screen.connection.connection_id);setModelQuery('');setSelected(ids[0]);setNotice(`已添加 ${ids.length} 个模型，可在右侧直接设置。`);back();}}/>}
      </section>}
    </div>
    {removal&&<SettingsConfirmation title={removal.title} description={removal.description} confirmLabel={removal.label} onCancel={()=>setRemoval(null)} onConfirm={async()=>{const ok=await save(removal.command);if(ok){if(removal.command.type==='connection:delete'){setPlatform('all');setSelected('');back();}setRemoval(null);}return ok;}}/>}
    {pending&&<AppDialog title="设置尚未保存" onDismiss={()=>setPending(null)} actions={[{label:'继续编辑',run:()=>setPending(null)},{label:'放弃并切换',run:()=>{const next=pending;setPending(null);setEditorVersion(v=>v+1);next();}},{label:'保存并切换',primary:true,run:async()=>{if(await currentDraft()?.save()){const next=pending;setPending(null);setEditorVersion(v=>v+1);next();}else throw new Error('设置尚未保存，请检查输入后重试。');}}]}>保存当前修改后切换，或放弃这次修改。</AppDialog>}
  </section>;
});
