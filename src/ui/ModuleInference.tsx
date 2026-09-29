import {useEffect,useRef,useState} from 'react';
import type {PublicModel,SemanticModule} from '../core/domain.js';
import type {DesktopApi} from '../shared/api.js';
import type {ModuleInferenceSuggestion} from '../core/module-inference.js';
import {inferenceInputError,type ModuleInferenceTask} from '../core/module-inference-tasks.js';

export interface ModuleInferenceOptions {api:DesktopApi;project_id:string;models:PublicModel[];default_model_id?:string}
export function ModuleInference({options,task,module,text,onAdopt,onBusy,disabled=false}:{options:ModuleInferenceOptions;task:ModuleInferenceTask;module:SemanticModule;text:string;onAdopt:(value:string)=>void;onBusy:(value:boolean)=>void;disabled?:boolean}){
  const models=options.models.filter(m=>m.purpose==='understanding'&&m.enabled);
  const [modelId,setModelId]=useState(options.default_model_id??models.find(m=>m.executable)?.model_config_id??models[0]?.model_config_id??'');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[suggestion,setSuggestion]=useState<ModuleInferenceSuggestion|null>(null);
  const active=useRef<string|null>(null),model=models.find(m=>m.model_config_id===modelId);
  const textOnly=model?.capabilities.max_images===0;
  const inputError=inferenceInputError(task,text,module.asset_ids.length,model?.capabilities.max_images);
  const inputKey=JSON.stringify([options.project_id,module.module_id,module.reference_id,module.asset_ids,task,model?.revision]);
  useEffect(()=>{
    setSuggestion(null);setError('');setBusy(false);onBusy(false);
    return ()=>{
      const id=active.current;active.current=null;
      if(id)void options.api.execute({type:'module:cancel-inference',request_id:id}).catch(()=>{});
    };
  },[text,modelId,inputKey,options.api,onBusy]);
  const cancel=()=>{
    const id=active.current;active.current=null;setBusy(false);onBusy(false);
    if(id)void options.api.execute({type:'module:cancel-inference',request_id:id}).catch(()=>{});
    setError('已取消，原文未修改；上游计费状态未知。');
  };
  const run=async()=>{
    if(!model?.executable||active.current||disabled||inputError)return;
    const id=`infer_${crypto.randomUUID()}`;active.current=id;setBusy(true);onBusy(true);setError('');setSuggestion(null);
    try{
      const response=await options.api.execute({type:'module:infer',request_id:id,project_id:options.project_id,module_id:module.module_id,model_config_id:model.model_config_id,text,allow_text_only:!!textOnly});
      if(active.current!==id)return;
      if(!response.ok||!response.suggestion)throw new Error(response.error??'推理模型没有返回建议。');
      setSuggestion(response.suggestion);
    }catch(e){if(active.current===id)setError(e instanceof Error?e.message:'推理失败，原文未修改。');}
    finally{if(active.current===id){active.current=null;setBusy(false);onBusy(false);}}
  };
  return <section className="module-inference" aria-label={task.action_label}>
    <div className="inference-actions"><label>推理模型<select aria-label="模块推理模型" value={modelId} disabled={busy||disabled} onChange={e=>setModelId(e.target.value)}><option value="">选择理解／推理模型</option>{models.map(m=><option key={m.model_config_id} value={m.model_config_id}>{m.title}{m.executable?'':'（未就绪）'}</option>)}</select></label>{busy?<button onClick={cancel}>取消推理</button>:<button disabled={disabled||!model?.executable||!!inputError} onClick={()=>void run()}>{textOnly&&task.text_only_label?task.text_only_label:task.action_label}</button>}</div>
    {!models.length?<p>请先在模型库配置“理解／推理模型”。</p>:model&&!model.executable?<p className="error-text">{model.readiness_error??'模型尚未就绪，请检查模型库配置。'}</p>:inputError?<p className="inference-warning">{inputError}</p>:textOnly?<p className="inference-warning">所选模型不支持看图。本次仅根据文字处理，未读取参考图。调用将使用所选模型的 API 额度。</p>:<p>{task.description}调用将使用所选模型的 API 额度。</p>}
    {busy&&<p role="status">正在生成建议…</p>}{error&&<p role="alert" className="error-text">{error}</p>}
    {suggestion&&<div className="inference-result"><div className="inference-comparison"><section><h3>当前文字</h3><pre>{suggestion.original_text||'（尚未填写）'}</pre></section><section><h3>{task.action_label}建议</h3><pre>{suggestion.text}</pre></section></div><div className="inference-adopt"><small>{suggestion.model_title} · {suggestion.text_only?'仅文字':`已读取 ${suggestion.images_sent} 张图片`}</small><button onClick={()=>setSuggestion(null)}>放弃建议</button><button className="primary" disabled={disabled||suggestion.original_text!==text} onClick={()=>{onAdopt(suggestion.text);setSuggestion(null);}}>采用到编辑框</button></div></div>}
  </section>;
}
