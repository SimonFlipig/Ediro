import {useRef,useState} from 'react';
import {defaultModuleSettings,type ModuleSettings} from '../core/module-settings.js';
import {promptRoles,type PromptRole} from '../core/prompt-roles.js';
import type {Command,WorkspaceView} from '../shared/api.js';
import {SettingsPageHeader} from './SettingsPageHeader.js';
import './model-settings.css';

const referenceModules=[{type:'composition',title:'构图'},{type:'style',title:'风格'}] as const;

export function ModuleSettingsPage({settings=defaultModuleSettings,models,onModels,onPrompts,onClose,onSave}: {
  settings?:ModuleSettings;models?:WorkspaceView['reference_models'];onModels:()=>void;onPrompts:()=>void;onClose:()=>void;onSave:(command:Command)=>Promise<boolean>;
}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [preparing,setPreparing]=useState<'depth'|'segment'|null>(null);
  const saving=useRef(false);
  const preparingRef=useRef(false);
  const save=async(next:ModuleSettings)=>{
    if(saving.current)return;
    saving.current=true;setBusy(true);setError('');
    try{
      const ok=await onSave({type:'module-settings:save',settings:next});
      if(!ok)setError('设置未保存，请重试。');
    }catch(error){setError(error instanceof Error?error.message:'设置未保存，请重试。');}
    finally{saving.current=false;setBusy(false);}
  };
  const update=async(type:'composition'|'style',patch:Partial<ModuleSettings['composition']>)=>{
    if(Object.entries(patch).every(([key,value])=>settings[type][key as keyof ModuleSettings['composition']]===value))return;
    await save({...settings,[type]:{...settings[type],...patch}});
  };
  const promptRole=settings.prompt?.role??defaultModuleSettings.prompt.role;
  const prepare=async(kind:'depth'|'segment')=>{
    if(preparingRef.current)return;
    preparingRef.current=true;setPreparing(kind);setError('');
    try{
      if(!await onSave({type:'reference-model:prepare',kind}))setError('资源下载失败，请重试。');
    }catch(error){setError(error instanceof Error?error.message:'资源下载失败，请重试。');}
    finally{preparingRef.current=false;setPreparing(null);}
  };
  return <section className="global-settings" aria-label="模块设置">
    <SettingsPageHeader page="modules" busy={busy} busyLabel="正在保存…" onModels={onModels} onModules={()=>{}} onPrompts={onPrompts} onClose={onClose}/>
    <div className="module-settings-body">
      <div className="module-settings-content">
        <header className="settings-detail-heading"><div><span className="settings-eyebrow">模块设置</span><h2>模块默认值</h2><p>用于新模块的默认参数，修改后自动保存，重新启动后保留。已有模块可在展开编辑中独立调整。</p></div></header>
        <div className="module-settings-list">
          <section className="module-settings-row" aria-labelledby="module-settings-prompt">
            <div className="module-settings-row-heading"><h3 id="module-settings-prompt">提示词</h3><p>推理角色</p></div>
            <div className="module-settings-fields module-settings-prompt-fields">
              <label><span className="module-settings-field-label">默认角色</span><select aria-label="提示词默认角色" aria-describedby="default-prompt-role-description" value={promptRole} disabled={busy} onChange={event=>{const role=event.target.value as PromptRole;if(role!==promptRole)void save({...settings,prompt:{role}});}}>{promptRoles.map(role=><option key={role.id} value={role.id}>{role.title}</option>)}</select></label>
              <p id="default-prompt-role-description">{promptRoles.find(role=>role.id===promptRole)?.description}新建提示词模块采用此角色，已有模块的选择保持不变。</p>
            </div>
          </section>
          {referenceModules.map(module=>{
            const current=settings[module.type],kind=current.preprocess;
            const modelKind=kind==='depth'||kind==='segment'?kind:null;
            const status=modelKind?(preparing===modelKind?'downloading':models?.[modelKind]??'missing'):null;
            return <section className="module-settings-row" key={module.type} aria-labelledby={`module-settings-${module.type}`}>
              <div className="module-settings-row-heading"><h3 id={`module-settings-${module.type}`}>{module.title}</h3><p>生图参考图</p></div>
              <div className="module-settings-fields">
                <label><span className="module-settings-field-label">最长边</span><select aria-label={`${module.title}参考图最长边`} value={current.max_edge} disabled={busy} onChange={event=>void update(module.type,{max_edge:Number(event.target.value) as 512|1024})}><option value={1024}>1K（1024 像素）</option><option value={512}>512 像素</option></select></label>
                <label><span className="module-settings-field-label">处理方式</span><select aria-label={`${module.title}参考图处理方式`} value={kind} disabled={busy} onChange={event=>void update(module.type,{preprocess:event.target.value as ModuleSettings['composition']['preprocess']})}><option value="none">仅缩图</option><option value="blur">模糊</option><option value="depth">深度</option><option value="segment">区域分割</option></select></label>
                {kind==='blur'&&<label><span className="module-settings-field-label">模糊强度</span><select aria-label={`${module.title}参考图模糊强度`} value={current.blur_strength} disabled={busy} onChange={event=>void update(module.type,{blur_strength:event.target.value as ModuleSettings['composition']['blur_strength']})}><option value="weak">弱</option><option value="medium">中</option><option value="strong">强</option></select></label>}
                {modelKind&&<div className="module-settings-resource" role="status"><span>{status==='ready'?'本地资源已就绪':status==='downloading'?'正在下载资源…':'需要下载一次本地资源'}</span>{status==='missing'&&<button disabled={busy||!!preparing} onClick={()=>void prepare(modelKind)}>下载资源</button>}</div>}
              </div>
            </section>;
          })}
        </div>
        <p className="settings-hint">处理结果用于生图，原图保持不变。缩图保持比例，小图不放大；主体图保持原样，推理模型仍读取清晰缩图。旧模块尚无独立参数时沿用此处默认值。</p>
        {error&&<p className="settings-notice" role="alert">{error}</p>}
      </div>
    </div>
  </section>;
}
