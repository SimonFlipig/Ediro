import {forwardRef,useEffect,useImperativeHandle,useMemo,useRef,useState} from 'react';
import {emptyPromptCustomizations,promptCustomizationsSchema,type PromptCustomizations,type CustomizableModuleType,type ModuleInstructionOverrides} from '../core/prompt-customization.js';
import {previewModuleInstructions} from '../core/prompt-customization-preview.js';
import type {PromptRole} from '../core/prompt-roles.js';
import type {PromptConfig} from '../core/prompt-config.js';
import type {ApiResponse,Command} from '../shared/api.js';
import {AppDialog} from './AppDialog.js';
import {SettingsPageHeader} from './SettingsPageHeader.js';
import './model-settings.css';
import './prompt-settings.css';

const modules=[{id:'subject',title:'主体'},{id:'composition',title:'构图'},{id:'style',title:'风格'},{id:'viewpoint',title:'视角'}] as const;
const roles=[{id:'general',title:'通用'},{id:'merchandiser',title:'陈列师'}] as const;
const expressions=[{key:'native_instruction',title:'原生图文顺序'},{key:'numbered_instruction',title:'文字＋图片集合'}] as const;
type Selection={kind:'module';id:CustomizableModuleType}|{kind:'role';id:PromptRole};
type Pending={action:()=>void;resolve?:(proceed:boolean)=>void};
export interface PromptSettingsPageHandle {requestClose:()=>void;beforeClose:()=>Promise<boolean>;save:()=>Promise<boolean>}
interface Props {customizations?:PromptCustomizations;config?:PromptConfig;onModels:()=>void;onModules:()=>void;onClose:()=>void;onExecute:(command:Command)=>Promise<ApiResponse>}

export const PromptSettingsPage=forwardRef<PromptSettingsPageHandle,Props>(function PromptSettingsPage({customizations=emptyPromptCustomizations,config,onModels,onModules,onClose,onExecute},ref){
  const incoming=JSON.stringify(customizations);
  const [draft,setDraft]=useState<PromptCustomizations>(()=>structuredClone(customizations));
  const [baseline,setBaseline]=useState(incoming);
  const [selection,setSelection]=useState<Selection>({kind:'module',id:'subject'});
  const [imageCount,setImageCount]=useState(1),[yaw,setYaw]=useState(30),[pitch,setPitch]=useState(-20);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [pending,setPending]=useState<Pending|null>(null),[resetAll,setResetAll]=useState(false);
  const working=useRef(false),latest=useRef({draft,baseline}),pendingRef=useRef(pending);
  latest.current={draft,baseline};pendingRef.current=pending;
  const dirty=JSON.stringify(draft)!==baseline;
  const applied=useMemo(()=>JSON.parse(baseline) as PromptCustomizations,[baseline]);
  useEffect(()=>{
    const current=latest.current;
    if(JSON.stringify(current.draft)===current.baseline||JSON.stringify(current.draft)===incoming){setDraft(structuredClone(customizations));setBaseline(incoming);}
    else if(current.baseline!==incoming)setNotice('已应用的配置发生了变化。当前未应用的编辑仍保留。');
  },[incoming]);
  useEffect(()=>()=>pendingRef.current?.resolve?.(false),[]);
  const validation=useMemo(()=>promptCustomizationsSchema.safeParse(draft),[draft]);
  const validationError=validation.success?'':validation.error.issues.map(issue=>issue.message).filter((message,index,list)=>list.indexOf(message)===index).join(' ');
  const hasCustomizations=Object.values(draft.modules).some(value=>value&&Object.keys(value).length>0)||Object.keys(draft.roles).length>0;
  const instructions:ModuleInstructionOverrides=selection.kind==='module'?draft.modules[selection.id]??{}:{};
  const roleText=selection.kind==='role'?draft.roles[selection.id]:undefined;
  const currentDirty=selection.kind==='module'?JSON.stringify(draft.modules[selection.id])!==JSON.stringify(applied.modules[selection.id]):draft.roles[selection.id]!==applied.roles[selection.id];
  const title=selection.kind==='module'?modules.find(item=>item.id===selection.id)!.title:roles.find(item=>item.id===selection.id)!.title;
  const currentCustom=selection.kind==='module'?Object.keys(instructions).length>0:roleText!==undefined;
  const preview=useMemo(()=>{
    if(selection.kind!=='module')return {native:[],numbered:'',images:[],error:''};
    try{return {...previewModuleInstructions(selection.id,instructions,{imageCount,toolState:{yaw,pitch,roll:0,projection:'orthographic'},config}),error:''};}
    catch(error){return {native:[],numbered:'',images:[],error:error instanceof Error?error.message:'请检查当前指令。'};}
  },[selection,instructions,imageCount,yaw,pitch,config]);
  const edit=(next:PromptCustomizations)=>{setDraft(next);setError('');setNotice('');};
  const setInstruction=(key:keyof ModuleInstructionOverrides,value:string|undefined)=>{
    if(selection.kind!=='module')return;
    const next=structuredClone(draft),entry={...next.modules[selection.id]};
    if(value===undefined)delete entry[key];else entry[key]=value;
    if(Object.keys(entry).length)next.modules[selection.id]=entry;else delete next.modules[selection.id];
    edit(next);
  };
  const setRole=(value:string|undefined)=>{
    if(selection.kind!=='role')return;
    const next=structuredClone(draft);
    if(value===undefined)delete next.roles[selection.id];else next.roles[selection.id]=value;
    edit(next);
  };
  const resetCurrent=()=>{
    const next=structuredClone(draft);
    if(selection.kind==='module')delete next.modules[selection.id];else delete next.roles[selection.id];
    edit(next);setNotice('此项将在保存并应用后恢复当前版本默认指令。');
  };
  const save=async()=>{
    if(working.current)return false;
    const parsed=promptCustomizationsSchema.safeParse(draft);
    if(!parsed.success){setError(validationError||'请检查自定义指令。');return false;}
    working.current=true;setBusy(true);setError('');setNotice('');
    try{
      const response=await onExecute({type:'prompt-customizations:save',customizations:parsed.data});
      if(!response.ok)throw Error(response.error??'核心指令未保存，请重试。');
      if(response.cancelled)return false;
      const applied=response.state?.prompt_customizations??parsed.data;
      setDraft(structuredClone(applied));setBaseline(JSON.stringify(applied));setNotice('已应用于后续任务。');return true;
    }catch(error){setError(error instanceof Error?error.message:'核心指令未保存，请重试。');return false;}
    finally{working.current=false;setBusy(false);}
  };
  const guard=(action:()=>void)=>{if(working.current||pending||resetAll)return;if(dirty)setPending({action});else action();};
  const cancelPending=()=>{pending?.resolve?.(false);setPending(null);};
  useImperativeHandle(ref,()=>({requestClose:()=>guard(onClose),save,beforeClose:()=>{
    if(working.current||pending||resetAll)return Promise.resolve(false);
    if(!dirty)return Promise.resolve(true);
    return new Promise<boolean>(resolve=>setPending({action:()=>{},resolve}));
  }}));
  const importDraft=async()=>{
    if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');
    try{
      const response=await onExecute({type:'prompt-customizations:import'});
      if(!response.ok)throw Error(response.error??'导入失败。');
      if(response.cancelled)return;
      const next=promptCustomizationsSchema.parse(response.prompt_customizations);
      setDraft(next);
      const module=modules.find(item=>next.modules[item.id]),role=roles.find(item=>next.roles[item.id]!==undefined);
      if(module)setSelection({kind:'module',id:module.id});else if(role)setSelection({kind:'role',id:role.id});
      setNotice('已导入为未应用的编辑，请检查后保存并应用。');
    }catch(error){setError(error instanceof Error?error.message:'导入失败。');}
    finally{working.current=false;setBusy(false);}
  };
  const exportDraft=async()=>{
    if(working.current)return;
    if(!validation.success){setError(validationError);return;}
    working.current=true;setBusy(true);setError('');setNotice('');
    try{
      const response=await onExecute({type:'prompt-customizations:export',customizations:validation.data});
      if(!response.ok)throw Error(response.error??'导出失败。');
      if(!response.cancelled)setNotice(dirty?'已导出当前未应用的编辑。':'已导出自定义指令。');
    }catch(error){setError(error instanceof Error?error.message:'导出失败。');}
    finally{working.current=false;setBusy(false);}
  };
  const selectedKey=selection.kind+':'+selection.id;
  const modal=!!pending||resetAll;
  return <section className="global-settings prompt-settings" aria-label="核心指令设置">
    <div inert={modal?true:undefined}><SettingsPageHeader page="prompts" busy={busy} onModels={()=>guard(onModels)} onModules={()=>guard(onModules)} onPrompts={()=>{}} onClose={()=>guard(onClose)}/></div>
    <div className="prompt-settings-intro" inert={modal?true:undefined}>
      <div><h2>核心指令</h2><p>自定义模块与角色的工作要求。保存后用于当前这份 Ediro 的后续任务。</p></div>
      <div className="prompt-settings-transfer"><button disabled={busy} onClick={()=>guard(()=>void importDraft())}>导入配置</button><button disabled={busy||!validation.success} onClick={()=>void exportDraft()}>{dirty?'导出当前编辑':'导出配置'}</button><button disabled={busy||!hasCustomizations} onClick={()=>setResetAll(true)}>全部恢复默认</button></div>
    </div>
    <div className="prompt-settings-body" inert={modal?true:undefined}>
      <nav className="prompt-settings-items" aria-label="自定义指令分类">
        <h3>模块指令</h3>
        {modules.map(item=><button key={item.id} data-prompt-item={`module:${item.id}`} aria-pressed={selectedKey===`module:${item.id}`} disabled={busy} onClick={()=>{setSelection({kind:'module',id:item.id});setError('');}}><span>{item.title}</span><small>{Object.keys(draft.modules[item.id]??{}).length?'自定义':'默认'}</small></button>)}
        <h3>角色指令</h3>
        {roles.map(item=><button key={item.id} data-prompt-item={`role:${item.id}`} aria-pressed={selectedKey===`role:${item.id}`} disabled={busy} onClick={()=>{setSelection({kind:'role',id:item.id});setError('');}}><span>{item.title}</span><small>{draft.roles[item.id]!==undefined?'自定义':'默认'}</small></button>)}
      </nav>
      <div className="prompt-settings-main">
        <div className="prompt-settings-current"><div><h3>{title}{selection.kind==='module'?'模块指令':'角色指令'}</h3><span className="settings-status">{currentDirty?'有未应用修改':currentCustom?'已应用自定义':'使用默认'}</span></div><button disabled={busy||!currentCustom} onClick={resetCurrent}>恢复此项默认</button></div>
        <div className="prompt-settings-workspace">
          <section className="prompt-settings-editor" aria-label="自定义指令编辑">
            {selection.kind==='module'?<>
              {expressions.map(expression=><div className="prompt-instruction-field" key={expression.key}>
                <div className="prompt-instruction-heading"><label htmlFor={`prompt-${expression.key}`}>{expression.title}</label><label className="settings-check"><input type="checkbox" aria-label={`自定义${expression.title}`} checked={instructions[expression.key]!==undefined} disabled={busy} onChange={event=>setInstruction(expression.key,event.target.checked?'':undefined)}/>自定义</label></div>
                <textarea id={`prompt-${expression.key}`} aria-label={`${title}${expression.title}指令`} value={instructions[expression.key]??''} disabled={busy||instructions[expression.key]===undefined} maxLength={32000} spellCheck={false} placeholder={instructions[expression.key]===undefined?'勾选自定义后填写':'填写你的指令'} onChange={event=>setInstruction(expression.key,event.target.value)}/>
              </div>)}
              <p className="settings-hint"><code>{'{images}'}</code> 表示此模块的图片编号。{selection.id==='viewpoint'&&<><code>{'{viewpoint}'}</code> 表示当前视角。</>}两种表达分别生效。</p>
            </>:<div className="prompt-instruction-field prompt-role-field">
              <div className="prompt-instruction-heading"><label htmlFor="prompt-role-instruction">角色工作要求</label><label className="settings-check"><input type="checkbox" aria-label="自定义角色指令" checked={roleText!==undefined} disabled={busy} onChange={event=>setRole(event.target.checked?'':undefined)}/>自定义</label></div>
              <textarea id="prompt-role-instruction" aria-label={`${title}角色指令`} value={roleText??''} disabled={busy||roleText===undefined} maxLength={32000} spellCheck={false} placeholder={roleText===undefined?'勾选自定义后填写':'填写这个角色的工作要求'} onChange={event=>setRole(event.target.value)}/>
              <p className="settings-hint">用于提示词推理时的角色要求。</p>
            </div>}
            <p className="prompt-empty-hint">留空并保存可清空此项指令；取消自定义则使用默认。</p>
            {validationError&&<p className="settings-notice" role="alert">{validationError}</p>}
          </section>
          <section className="prompt-settings-preview" aria-label="当前项编译预览">
            <div className="prompt-preview-heading"><h4>{selection.kind==='module'?'当前模块编译预览':'当前角色指令预览'}</h4><span>{currentDirty?'未应用预览':'当前配置'}</span></div>
            {selection.kind==='module'?<>
              <div className="prompt-preview-options">
                <label>试编译图片数<select aria-label="试编译图片数" value={imageCount} disabled={busy} onChange={event=>setImageCount(Number(event.target.value))}>{Array.from({length:16},(_,index)=>index+1).map(number=><option key={number} value={number}>{number} 张</option>)}</select></label>
                {selection.id==='viewpoint'&&<><label>水平角度<input type="number" aria-label="试编译水平角度" min={-180} max={180} value={yaw} disabled={busy} onChange={event=>setYaw(Number(event.target.value))}/></label><label>俯仰角度<input type="number" aria-label="试编译俯仰角度" min={-90} max={90} value={pitch} disabled={busy} onChange={event=>setPitch(Number(event.target.value))}/></label></>}
              </div>
              <p className="prompt-preview-note">只试编译当前项；图片用编号表示，不调用模型。</p>
              {preview.error&&<p className="settings-notice" role="alert">{preview.error}</p>}
              <div className="prompt-compiled-group"><h5>原生图文顺序</h5><div className="prompt-compiled-output" data-prompt-preview="native">{preview.native.map((block,index)=>block.type==='text'?<pre key={index}>{block.text}</pre>:<span className="prompt-preview-image" key={index}>▧ {block.image_name}</span>)}</div></div>
              <div className="prompt-compiled-group"><h5>文字＋图片集合</h5><div className="prompt-compiled-output" data-prompt-preview="numbered">{preview.numbered&&<><pre>{preview.numbered}</pre>{preview.images.length>0&&<div className="prompt-preview-images">{preview.images.map(name=><span className="prompt-preview-image" key={name}>▧ {name}</span>)}</div>}</>}</div></div>
            </>:<div className="prompt-compiled-output prompt-role-output" data-prompt-preview="role">{roleText&&<pre>{roleText}</pre>}</div>}
          </section>
        </div>
        <div className="prompt-settings-savebar">
          <div className="prompt-settings-save-actions"><button className="primary" disabled={busy||!dirty||!validation.success} onClick={()=>void save()}>保存并应用</button><button disabled={busy||!dirty} onClick={()=>{setDraft(JSON.parse(baseline) as PromptCustomizations);setError('');setNotice('');}}>还原未应用修改</button></div>
          {error?<p role="alert" className="prompt-settings-error">{error}</p>:<p role="status">{notice||(dirty?'修改尚未应用。':'修改仅作用于当前这份 Ediro。')}</p>}
        </div>
      </div>
    </div>
    {resetAll&&<AppDialog title="恢复全部默认指令" onDismiss={()=>setResetAll(false)} actions={[{label:'取消',run:()=>setResetAll(false)},{label:'恢复默认',primary:true,run:()=>{edit(structuredClone(emptyPromptCustomizations));setNotice('全部指令将在保存并应用后恢复当前版本默认。');setResetAll(false);}}]}>移除模块与角色的全部自定义内容，保存并应用后生效。</AppDialog>}
    {pending&&<AppDialog title="核心指令尚未应用" onDismiss={cancelPending} actions={[{label:'继续编辑',run:cancelPending},{label:'放弃修改',run:()=>{const next=pending;setDraft(JSON.parse(baseline) as PromptCustomizations);setPending(null);next.action();next.resolve?.(true);}},{label:'保存并继续',primary:true,run:async()=>{if(!await save())throw Error('请检查自定义指令后重试。');const next=pending;setPending(null);next.action();next.resolve?.(true);}}]}>当前修改尚未应用。保存后继续，或放弃本次修改。</AppDialog>}
  </section>;
});
