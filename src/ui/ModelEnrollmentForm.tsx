import { useId,useRef,useState } from 'react';
import { identifyPreset,type ModelFamily } from '../protocols/model-catalog.js';

export function ModelEnrollmentForm({modelId,families,adapter,busy,onAdd,onDismiss}:{modelId:string;families:{id:ModelFamily;title:string}[];adapter:string;busy:boolean;onAdd:(family:ModelFamily,vision:boolean)=>Promise<boolean>;onDismiss:()=>void}){
  const running=useRef(false),titleId=useId();
  const preset=identifyPreset(modelId),known=preset?.family;
  const [family,setFamily]=useState<ModelFamily|''>(()=>families.find(f=>f.id===known)?.id??(families.length===1?families[0].id:''));
  const [vision,setVision]=useState(false),[submitting,setSubmitting]=useState(false),[error,setError]=useState('');
  const locked=busy||submitting;
  const submit=async()=>{
    if(locked||running.current||!family)return;
    running.current=true;setSubmitting(true);setError('');
    try{if(await onAdd(family,vision))onDismiss();else setError('未能添加到模型库，当前选择已保留，可以重试。');}
    catch(cause){setError(cause instanceof Error?cause.message:'添加失败，请重试。');}
    finally{running.current=false;setSubmitting(false);}
  };
  return <form className="enrollment-confirmation" aria-labelledby={titleId} aria-busy={locked} onSubmit={e=>{e.preventDefault();void submit();}} onKeyDown={e=>{if(e.key==='Escape'&&!locked){e.preventDefault();e.stopPropagation();onDismiss();}}}>
    <span className="enrollment-confirmation-title" id={titleId}>为此模型选择家族</span>
    <fieldset disabled={locked}>
      <label>模型家族<select autoFocus aria-label="模型家族" value={family} onChange={e=>{setFamily(e.target.value as ModelFamily);setVision(false);setError('');}}><option value="" disabled>请选择模型家族</option>{families.map(f=><option key={f.id} value={f.id}>{f.title}</option>)}</select></label>
      <p className="settings-hint">{preset?.config.adapter_id===adapter?'已识别型号，将使用对应参数。':family?'将使用所选家族的默认参数，添加后可在右侧调整。':'选择这个模型的用途。'}</p>
      {family==='reasoning'&&adapter==='openai-chat-completions'&&<label className="settings-check"><input type="checkbox" checked={vision} onChange={e=>setVision(e.target.checked)}/>此模型支持图片理解</label>}
    </fieldset>
    {error&&<p role="alert" className="settings-notice">{error}</p>}
    <div className="enrollment-confirmation-actions"><button type="button" disabled={locked} onClick={onDismiss}>取消</button><button className="primary" type="submit" disabled={locked||!family}>{submitting?'正在添加…':'确认添加'}</button></div>
  </form>;
}
