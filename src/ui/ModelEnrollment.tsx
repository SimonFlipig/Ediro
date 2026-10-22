import { useEffect,useRef,useState } from 'react';
import { newId } from '../core/domain.js';
import type { PublicConnection } from '../core/model-library.js';
import type { ApiResponse,Command,WorkspaceView } from '../shared/api.js';
import { familiesForAdapter,identifyPreset,modelFamilies,modelForEnrollment,type ModelFamily } from '../protocols/model-catalog.js';
import { ModelEnrollmentForm } from './ModelEnrollmentForm.js';
import './model-enrollment.css';

export function ModelEnrollment({connection,view,save,probe,busy,onWorkingChange,onClose,onEnrolled}:{connection:PublicConnection;view:WorkspaceView;save:(c:Command)=>Promise<boolean>;probe:(c:Command)=>Promise<ApiResponse>;busy:boolean;onWorkingChange:(busy:boolean)=>void;onClose:()=>void;onEnrolled:(id:string)=>void}){
  const adapter=connection.adapter_id??view.models.find(m=>m.connection_id===connection.connection_id)?.adapter_id??'gemini-generate-content';
  const available=familiesForAdapter(adapter),canDiscover=!!view.adapters?.find(a=>a.adapter_id===adapter)?.supports_probe;
  const [family,setFamily]=useState<ModelFamily|''>(()=>available.length===1?available[0].id:'');
  const [mode,setMode]=useState<'remote'|'manual'>(canDiscover?'remote':'manual'),[models,setModels]=useState<string[]>([]),[loaded,setLoaded]=useState(false),[query,setQuery]=useState(''),[manual,setManual]=useState(''),[vision,setVision]=useState(false),[working,setWorking]=useState(false),[message,setMessage]=useState(''),[pending,setPending]=useState<string|null>(null);
  const running=useRef(false),added=useRef(new Set<string>()),pendingRow=useRef<HTMLDivElement|null>(null);
  // The ref covers the brief gap before the saved view arrives, not library membership.
  useEffect(()=>{for(const id of added.current)if(view.models.some(m=>m.connection_id===connection.connection_id&&m.model===id&&m.adapter_id===adapter))added.current.delete(id);});
  const locked=busy||working,familyTitle=available.find(f=>f.id===family)?.title??'所选';
  const exists=(id:string)=>added.current.has(id)||view.models.some(m=>m.connection_id===connection.connection_id&&m.model===id&&m.adapter_id===adapter);
  const knownFamily=(id:string)=>identifyPreset(id)?.family;
  const eligibleFamilies=(id:string)=>available.filter(f=>!knownFamily(id)||knownFamily(id)===f.id);
  const matchingPreset=(id:string)=>{const match=identifyPreset(id);return match?.family===family&&match.config.adapter_id===adapter?match:undefined;};
  const manualFamily=knownFamily(manual.trim()),manualIncompatible=!!manualFamily&&manualFamily!==family;
  const changeFamily=(value:ModelFamily|'')=>{setFamily(value);setVision(false);setMessage('');};
  const changeManual=(value:string)=>{
    setManual(value);setMessage('');
    const known=knownFamily(value.trim());
    if(known&&available.some(f=>f.id===known))changeFamily(known);
    else if(knownFamily(manual.trim())&&!known)changeFamily(available.length===1?available[0].id:'');
  };
  const visibleModels=models.filter(id=>id.toLowerCase().includes(query.toLowerCase()));
  const dismissPending=()=>{
    const row=pendingRow.current;setPending(null);
    requestAnimationFrame(()=>{if(row?.isConnected)(row.querySelector<HTMLButtonElement>('button:not(:disabled)')??row).focus({preventScroll:true});});
  };
  const work=async(action:()=>Promise<boolean|void>)=>{if(running.current||busy)return false;running.current=true;setWorking(true);onWorkingChange(true);try{return await action()!==false;}catch(error){setMessage(error instanceof Error?error.message:'操作未完成，请重试。');return false;}finally{running.current=false;setWorking(false);onWorkingChange(false);}};
  const fetchModels=()=>work(async()=>{
    if(!canDiscover)return false;
    setMessage('正在读取模型列表…');
    const result=await probe({type:'connection:probe',connection_id:connection.connection_id,adapter_id:adapter});
    if(!result.ok){setMessage(result.error??'读取失败，可以重试或手动添加。');return false;}
    setModels([...new Set(result.discovered_models??[])]);setLoaded(true);setPending(null);
    setMessage(result.discovered_models?.length?'模型列表已更新，点击需要的模型旁的添加按钮。':'平台没有返回模型，可以手动添加。');
  });
  const enroll=(id:string,selectedFamily:ModelFamily,selectedVision:boolean)=>work(async()=>{
    if(exists(id)||!eligibleFamilies(id).some(f=>f.id===selectedFamily))return false;
    setMessage('正在添加模型…');
    const {endpoint:_,executable:__,revision:___,...model}=modelForEnrollment(selectedFamily,adapter,newId('model'),connection.connection_id,id,adapter==='openai-chat-completions'?selectedVision:undefined);
    if(!await save({type:'model:save',model})){setMessage('添加未完成，当前选择已保留，可以重试。');return false;}
    added.current.add(id);setMessage(`已添加 ${id}，可以继续添加其他模型。`);onEnrolled(model.model_config_id);return true;
  });
  return <section className="settings-enrollment" aria-label="添加模型">
    <div className="enrollment-heading"><div><h3>添加模型</h3><p>添加到「{connection.title}」</p></div><button disabled={locked} onClick={onClose}>收起添加</button></div>
    {canDiscover&&<div className="settings-tabs enrollment-tabs" aria-label="添加方式"><button disabled={locked} aria-pressed={mode==='remote'} onClick={()=>setMode('remote')}>从平台列表选择</button><button disabled={locked} aria-pressed={mode==='manual'} onClick={()=>setMode('manual')}>手动添加</button></div>}
    <div hidden={mode!=='remote'}>
      <div className="enrollment-toolbar"><input disabled={locked} aria-label="筛选模型" placeholder="搜索平台模型 ID" value={query} onChange={e=>{setQuery(e.target.value);setPending(null);}}/><button disabled={locked||!canDiscover} onClick={()=>void fetchModels()}>{working?'正在处理…':loaded?'刷新列表':'获取模型列表'}</button></div>
      <p className="settings-hint">点击模型旁的添加按钮，再选择模型家族。</p>
      <div className="discovery-list">{visibleModels.map(id=>{const compatible=eligibleFamilies(id).length>0;return <div className="discovery-row" data-remote-id={id} key={id} tabIndex={-1}><div className="discovery-copy"><b>{id}</b><small>{!compatible?'当前平台协议不支持此模型家族':knownFamily(id)?`已识别 · ${modelFamilies.find(f=>f.id===knownFamily(id))?.title}`:'添加时选择模型家族'}</small></div><button aria-label={`添加 ${id} 到模型库`} aria-expanded={pending===id} disabled={locked||exists(id)||!compatible||pending===id} onClick={e=>{pendingRow.current=e.currentTarget.parentElement as HTMLDivElement;setPending(id);setMessage('');}}>{exists(id)?'已在模型库':!compatible?'接口不兼容':'添加到模型库'}</button>{pending===id&&<ModelEnrollmentForm key={id} modelId={id} families={eligibleFamilies(id)} adapter={adapter} busy={locked} onAdd={(selectedFamily,selectedVision)=>enroll(id,selectedFamily,selectedVision)} onDismiss={dismissPending}/>}</div>;})}</div>
      {!visibleModels.length&&<div className="enrollment-empty">{loaded?'没有匹配的模型，可以修改搜索或手动添加。':'获取平台模型列表，或切换到手动添加。'}</div>}
    </div>
    <form className="enrollment-manual" hidden={mode!=='manual'} onSubmit={e=>{e.preventDefault();if(!locked&&family&&!manualIncompatible&&!exists(manual.trim())&&manual.trim())void enroll(manual.trim(),family,vision);}}>
      <fieldset disabled={locked}>
        <label>平台模型 ID<input value={manual} onChange={e=>changeManual(e.target.value)} maxLength={100} placeholder="渠道提供的完整模型名称"/></label>
        <label>模型家族<select aria-label="模型家族" value={family} onChange={e=>changeFamily(e.target.value as ModelFamily)}><option value="" disabled>请选择模型家族</option>{available.map(f=><option key={f.id} value={f.id}>{f.title}</option>)}</select></label>
        {family==='reasoning'&&adapter==='openai-chat-completions'&&<label className="settings-check"><input type="checkbox" checked={vision} onChange={e=>setVision(e.target.checked)}/>此模型支持图片理解</label>}
      </fieldset>
      <p className="settings-hint">{manualIncompatible?`这个型号属于${modelFamilies.find(f=>f.id===manualFamily)?.title}，请选择对应家族或切换平台。`:manual.trim()&&matchingPreset(manual.trim())?'已识别型号，将自动使用对应参数。':family?`使用${familyTitle}家族默认配置，添加后可在右侧调整。`:'填写模型 ID，并选择这个模型的用途。'}</p>
      {exists(manual.trim())&&<p className="settings-hint">这个模型已在当前平台的模型库中，可以填写另一个模型 ID。</p>}
      <div className="enrollment-manual-actions"><button className="primary" type="submit" disabled={locked||!family||!manual.trim()||exists(manual.trim())||manualIncompatible}>{working?'正在添加…':'添加到模型库'}</button></div>
    </form>
    <p role="status" className="settings-hint enrollment-status">{message}</p>
  </section>;
}
