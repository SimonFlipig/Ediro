import { useEffect, useRef, useState } from 'react';
import type { SemanticModule } from '../core/domain.js';
import { referenceTools } from './module-tools.js';
import {ModuleInference,type ModuleInferenceOptions} from './ModuleInference.js';
import type {ModuleInferenceTask} from '../core/module-inference-tasks.js';
import {defaultModuleSettings,type ReferenceSettings} from '../core/module-settings.js';
import {promptRoles,resolvePromptRole,type PromptRole} from '../core/prompt-roles.js';
import {ReferencePreprocessPreview,type ReferencePreviewOptions} from './ReferencePreprocessPreview.js';

export function ModuleEditor({ module, description, initialText, functional, inference, inferenceTask, referencePreview, onClose, onSave }: {
  inference?:ModuleInferenceOptions;
  inferenceTask?:ModuleInferenceTask;
  referencePreview?:ReferencePreviewOptions;
  module: SemanticModule; description?: string; initialText: string; functional: boolean; onClose: () => void;
  onSave: (text: string, tool?: { png: string; state: Record<string,unknown> }, referenceSettings?:ReferenceSettings, promptRole?:PromptRole) => Promise<boolean>;
}) {
  const [text, setText] = useState(initialText), [saving, setSaving] = useState(false);
  const [inferring,setInferring]=useState(false);
  const isPrompt=module.reference_type==='prompt';
  const [promptRole,setPromptRole]=useState<PromptRole>(()=>resolvePromptRole(module));
  const role=promptRoles.find(item=>item.id===promptRole)!;
  const referenceType=module.reference_type==='composition'||module.reference_type==='style'?module.reference_type:null;
  const descriptionOnly=!!referenceType&&module.reference_mode==='text_only';
  const [referenceSettings,setReferenceSettings]=useState<ReferenceSettings|undefined>(()=>referenceType?structuredClone(module.reference_settings??referencePreview?.settings[referenceType]??defaultModuleSettings[referenceType]):undefined);
  const Tool=referenceTools.get(module.reference_type);
  const tool = useRef<{ png: string; state: Record<string,unknown> } | undefined>(undefined);
  const dialog = useRef<HTMLElement>(null), field = useRef<HTMLTextAreaElement>(null);
  const closing = useRef(onClose), busy = useRef(saving); closing.current = onClose; busy.current = saving;
  useEffect(()=>{const submit=(event:Event)=>{(event as CustomEvent<Promise<boolean>[]>).detail.push(inferring||saving?Promise.resolve(false):onSave(text,functional?tool.current:undefined,referenceType?referenceSettings:undefined,isPrompt?promptRole:undefined));};window.addEventListener('ediro:flush-editors',submit);return()=>window.removeEventListener('ediro:flush-editors',submit);});
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    field.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy.current) { event.preventDefault(); closing.current(); }
      if (event.key !== 'Tab') return;
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input, select, [tabindex="0"]') ?? [])];
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><section ref={dialog} className={`module-editor ${inference&&inferenceTask?'has-inference':''}`} role="dialog" aria-modal="true" aria-label={`${module.title}展开编辑`}>
    <header><div><span className="eyebrow">MODULE EDITOR</span><h2>{module.title} · 展开编辑</h2><code>{module.reference_id}</code></div><button aria-label="关闭展开编辑" className="icon-button" disabled={saving} onClick={onClose}>×</button></header>
    {module.base_instruction && <div className="editor-semantics" title={descriptionOnly?inferenceTask?.description:description}><span>功能说明</span><p>{(descriptionOnly?inferenceTask?.description:description)??'参考此模块提供的功能与方向。'}</p></div>}
    <div className={`editor-content ${functional ? 'with-tool' : ''}`}>
      {isPrompt&&<div className="editor-prompt-role"><label><span>推理角色</span><select aria-label="提示词角色" aria-describedby="prompt-role-description" value={promptRole} disabled={saving||inferring} onChange={event=>setPromptRole(event.target.value as PromptRole)}>{promptRoles.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label><p id="prompt-role-description">{role.description}</p></div>}
      {descriptionOnly?<p className="notice">参考图只用于推理识别，生图只接收文字描述。可在下方提取描述，或通过自动提示词统一整理。</p>:referencePreview&&referenceType&&referenceSettings&&<ReferencePreprocessPreview options={referencePreview} referenceType={referenceType} moduleId={module.module_id} assetIds={module.asset_ids} settings={referenceSettings} onChange={setReferenceSettings} disabled={saving}/>}
      {functional&&(Tool?<Tool state={module.tool_state??{}} onSnapshot={(png,state)=>{tool.current={png,state};}}/>:<p className="notice warning">此模块的参考工具尚未安装；现有图片仍可参与生成。</p>)}
      <label className="editor-text"><span>{module.reference_type === 'prompt' ? '生成要求' : module.reference_type === 'image_text' ? '文字说明' : '额外要求'}</span><textarea ref={field} aria-label="展开文本内容" value={text} maxLength={32000} onChange={event=>setText(event.target.value)} placeholder="清楚表达设计意图…" disabled={saving||inferring}/><small>{text.length.toLocaleString()} / 32,000</small></label>
    </div>
    {inference&&inferenceTask&&<ModuleInference options={inference} task={inferenceTask} module={isPrompt?{...module,prompt_role:promptRole}:module} text={text} onAdopt={setText} onBusy={setInferring} disabled={saving}/>}
    <footer><span>保存后同步原模块与输入链 · 不创建新模块</span><div><button disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={saving||inferring} onClick={async()=>{setSaving(true);try{if(await onSave(text,functional?tool.current:undefined,referenceType?referenceSettings:undefined,isPrompt?promptRole:undefined))onClose();}finally{setSaving(false);}}}>{saving?'保存中…':'保存并关闭'}</button></div></footer>
  </section></div>;
}
