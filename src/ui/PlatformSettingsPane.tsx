import { forwardRef,useImperativeHandle,useState } from 'react';
import type { PublicConnection } from '../core/model-library.js';
import type { Command,WorkspaceView } from '../shared/api.js';
import type { DraftHandle } from './ModelSettingsEditor.js';

const endpointGuides:Record<string,{example:string;help:string}>={
  'gemini-generate-content':{example:'https://api.example.com/v1beta',help:'填写 Gemini 原生 API 基础地址。只填写域名时，程序会自动补上 /v1beta。'},
  'openai-images':{example:'https://api.example.com/v1',help:'填写 OpenAI Images API 基础地址。只填写域名时，程序会自动补上 /v1。'},
  'openai-chat-completions':{example:'https://api.example.com/v1',help:'填写 OpenAI 兼容 API 基础地址。只填写域名时，程序会自动补上 /v1；平台提供专用路径时，请完整保留。'},
};

export const PlatformSettingsPane=forwardRef<DraftHandle,{connection:PublicConnection;view:WorkspaceView;save:(c:Command)=>Promise<boolean>;busy:boolean;onClose:()=>void;onRemove:()=>void;onSaved:(connection:PublicConnection,invalidateDiscovery:boolean)=>void}>(function PlatformSettingsPane({connection,view,save,busy,onClose,onRemove,onSaved},ref){
  const initialAdapter=connection.adapter_id??view.models.find(m=>m.connection_id===connection.connection_id)?.adapter_id??'gemini-generate-content';
  const [title,setTitle]=useState(connection.title),[endpoint,setEndpoint]=useState(connection.endpoint),[adapter,setAdapter]=useState(initialAdapter),[enabled,setEnabled]=useState(connection.enabled),[secret,setSecret]=useState(''),[clear,setClear]=useState(false);
  const [baseline,setBaseline]=useState(()=>JSON.stringify([connection.title,connection.endpoint,initialAdapter,connection.enabled])),[saved,setSaved]=useState(false),[hasCredential,setHasCredential]=useState(connection.has_credential),[error,setError]=useState('');
  const existing=view.connections?.some(c=>c.connection_id===connection.connection_id);
  const endpointGuide=endpointGuides[adapter]??{example:'https://api.example.com',help:'填写平台提供的 HTTPS API 基础地址。'};
  const dirty=baseline!==JSON.stringify([title,endpoint,adapter,enabled])||!!secret||clear||!existing&&!saved;
  const configured=():PublicConnection=>({...connection,title:title.trim(),endpoint:endpoint.trim(),enabled,adapter_id:adapter,has_credential:clear?false:!!secret||hasCredential});
  const persist=async()=>{
    setError('');
    if(!title.trim()||!endpoint.trim()){setError('请填写平台名称和 API 地址。');return false;}
    const next=configured();
    try{
      const ok=await save({type:'connection:save',connection:{connection_id:next.connection_id,title:next.title,endpoint:next.endpoint,enabled,adapter_id:adapter},...(secret?{secret}:{}),clear_credential:clear});
      if(ok){setTitle(next.title);setEndpoint(next.endpoint);setHasCredential(next.has_credential);setSecret('');setClear(false);setSaved(true);setBaseline(JSON.stringify([next.title,next.endpoint,adapter,enabled]));}
      else setError('平台未保存，请检查输入后重试。');
      return ok;
    }catch(error){setError(error instanceof Error?error.message:'平台未保存，请重试。');return false;}
  };
  useImperativeHandle(ref,()=>({dirty,save:persist}));
  return <div className="settings-platform-form">
    <div className="settings-inline-heading"><h3>{existing?'平台设置':'添加平台'}</h3><button disabled={busy} onClick={onClose}>收起平台设置</button></div>
    <p className="settings-hint">旗下模型共用接口与密钥。</p>
    <form onSubmit={e=>{e.preventDefault();const next=configured(),invalidateDiscovery=next.endpoint!==connection.endpoint||adapter!==initialAdapter||!!secret||clear;void persist().then(ok=>{if(ok)onSaved(next,invalidateDiscovery);});}}>
      <fieldset disabled={busy} className="settings-form-fields">
        <div className="settings-field-grid">
        <label>平台名称<input autoFocus required value={title} onChange={e=>setTitle(e.target.value)} maxLength={100}/></label>
        <label>接口类型<select value={adapter} onChange={e=>setAdapter(e.target.value)}>{view.adapters?.filter(a=>a.kind==='cloud').map(a=><option key={a.adapter_id} value={a.adapter_id}>{a.title}</option>)}</select></label>
        </div>
        <label>API 地址（基础地址）<input required value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder={endpointGuide.example} aria-describedby="platform-endpoint-help"/></label>
        <p id="platform-endpoint-help" className="settings-hint">{endpointGuide.help} 不要填写具体操作路径，如 /models、/chat/completions 或 /images/generations。</p>
        <label>API Key<input type="password" autoComplete="off" value={secret} disabled={clear} placeholder={hasCredential?'已加密保存，留空保留':'填写接口密钥'} onChange={e=>setSecret(e.target.value)}/></label>
        <p className="settings-hint">密钥由本机加密保存。保存平台不会发起模型调用。</p>
        <label className="settings-check"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>启用平台</label>
        {existing&&<details><summary>平台管理</summary><label className="settings-check"><input type="checkbox" checked={clear} onChange={e=>{setClear(e.target.checked);setSecret('');}}/>清除已保存的密钥</label><button type="button" onClick={onRemove}>删除平台</button></details>}
        {error&&<p className="settings-notice" role="alert">{error}</p>}
        <div className="settings-savebar"><span className="settings-hint">{dirty?'有未保存的修改':'平台配置已保存'}</span><button type="submit" className="primary" disabled={!title.trim()||!endpoint.trim()}>保存平台</button></div>
      </fieldset>
    </form>
  </div>;
});
