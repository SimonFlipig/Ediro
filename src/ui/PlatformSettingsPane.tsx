import { forwardRef,useImperativeHandle,useState } from 'react';
import type { PublicConnection } from '../core/model-library.js';
import type { Command,WorkspaceView } from '../shared/api.js';
import type { DraftHandle } from './ModelSettingsEditor.js';

export const PlatformSettingsPane=forwardRef<DraftHandle,{connection:PublicConnection;view:WorkspaceView;save:(c:Command)=>Promise<boolean>;busy:boolean;enrollAfterSave:boolean;onClose:()=>void;onRemove:()=>void;onSaved:(connection:PublicConnection)=>void}>(function PlatformSettingsPane({connection,view,save,busy,enrollAfterSave,onClose,onRemove,onSaved},ref){
  const initialAdapter=connection.adapter_id??view.models.find(m=>m.connection_id===connection.connection_id)?.adapter_id??'gemini-generate-content';
  const [title,setTitle]=useState(connection.title),[endpoint,setEndpoint]=useState(connection.endpoint),[adapter,setAdapter]=useState(initialAdapter),[enabled,setEnabled]=useState(connection.enabled),[secret,setSecret]=useState(''),[clear,setClear]=useState(false);
  const [baseline,setBaseline]=useState(()=>JSON.stringify([connection.title,connection.endpoint,initialAdapter,connection.enabled])),[saved,setSaved]=useState(false);
  const existing=view.connections?.some(c=>c.connection_id===connection.connection_id);
  const dirty=baseline!==JSON.stringify([title,endpoint,adapter,enabled])||!!secret||clear||!existing&&!saved;
  const configured=():PublicConnection=>({...connection,title:title.trim(),endpoint:endpoint.trim(),enabled,adapter_id:adapter,has_credential:clear?false:!!secret||connection.has_credential});
  const persist=async()=>{if(!title.trim()||!endpoint.trim())return false;const ok=await save({type:'connection:save',connection:{connection_id:connection.connection_id,title:title.trim(),endpoint:endpoint.trim(),enabled,adapter_id:adapter},...(secret?{secret}:{}),clear_credential:clear});if(ok){setSecret('');setClear(false);setSaved(true);setBaseline(JSON.stringify([title,endpoint,adapter,enabled]));}return ok;};
  useImperativeHandle(ref,()=>({dirty,save:persist}));
  return <div className="settings-flow-content">
    <button className="settings-back" disabled={busy} onClick={onClose}>← 返回模型库</button>
    <div className="settings-library-heading"><div><span className="settings-eyebrow">PLATFORM CONNECTION</span><h2>{existing?'平台设置':'接入一个新平台'}</h2><p>一个平台配置一次，旗下模型共用接口与密钥。</p></div></div>
    <form onSubmit={e=>{e.preventDefault();const next=configured();void persist().then(ok=>{if(ok)onSaved(next);});}}>
      <fieldset disabled={busy} className="settings-form-fields">
        <label>平台名称<input autoFocus required value={title} onChange={e=>setTitle(e.target.value)} maxLength={100}/></label>
        <label>接口类型<select value={adapter} onChange={e=>setAdapter(e.target.value)}>{view.adapters?.filter(a=>a.kind==='cloud'&&a.supports_probe).map(a=><option key={a.adapter_id} value={a.adapter_id}>{a.title}</option>)}</select></label>
        <label>API 地址<input required value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder="https://api.example.com"/></label>
        <label>API Key<input type="password" autoComplete="off" value={secret} disabled={clear} placeholder={connection.has_credential?'已加密保存，留空保留':'填写接口密钥'} onChange={e=>setSecret(e.target.value)}/></label>
        <p className="settings-hint">密钥由本机加密保存。保存平台不会发起模型调用。</p>
        <label className="settings-check"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>启用平台</label>
        {existing&&<details><summary>平台管理</summary><label className="settings-check"><input type="checkbox" checked={clear} onChange={e=>{setClear(e.target.checked);setSecret('');}}/>清除已保存的密钥</label><button type="button" onClick={onRemove}>删除平台</button></details>}
        <div className="settings-savebar"><span className="settings-hint">{enrollAfterSave?'下一步：选择要添加的模型':dirty?'有未保存的修改':'平台配置已保存'}</span><button type="submit" className="primary" disabled={!title.trim()||!endpoint.trim()}>{enrollAfterSave?'保存并添加模型':'保存平台设置'}</button></div>
      </fieldset>
    </form>
  </div>;
});
