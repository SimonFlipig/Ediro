import {forwardRef,useEffect,useImperativeHandle,useMemo,useRef,useState} from 'react';
import {emptyPromptCustomizations,type PromptCustomizations,type CustomizableModuleType,type ModuleInstructionOverrides} from '../core/prompt-customization.js';
import {createPromptSettings,mergeImportedPromptSettings,moduleInstructionPresetSchema,roleInstructionPresetSchema,inferenceInstructionPresetSchema,presetTarget,promptPresetLibrarySchema,promptSettingsSchema,type InstructionPreset,type PromptSettingsDocument} from '../core/prompt-settings.js';
import {defaultModuleInferenceInstructions} from '../core/module-inference-instructions.js';
import {previewModuleInstructions} from '../core/prompt-customization-preview.js';
import {promptRoles,type PromptRole} from '../core/prompt-roles.js';
import {releasePromptConfig} from '../core/release-prompt-config.js';
import type {PromptConfig} from '../core/prompt-config.js';
import type {ApiResponse,Command} from '../shared/api.js';
import {AppDialog} from './AppDialog.js';
import {SettingsPageHeader} from './SettingsPageHeader.js';
import './model-settings.css';
import './prompt-settings.css';

const modules=[
  {id:'subject',title:'主体',description:'明确需要保留的主体特征。'},
  {id:'composition',title:'构图',description:'约束画面布局、主体位置与空间关系。'},
  {id:'style',title:'风格',description:'引导环境、道具、色彩与光线。'},
  {id:'viewpoint',title:'视角',description:'定义相机观察方向与画面透视。'},
] as const;
const expressions=[{key:'native_instruction',title:'原生图文顺序',description:'文字与参考图片按顺序交替输入。'},{key:'numbered_instruction',title:'文字＋图片集合',description:'通过图片编号关联文字与参考图片。'}] as const;
type Selection={kind:'module';id:CustomizableModuleType}|{kind:'role';id:PromptRole};
type PresetTarget=keyof PromptSettingsDocument['selected_presets'];
type ModuleMode='generation'|'inference';
type Pending={action:()=>void;resolve?:(proceed:boolean)=>void};
type NameDialog={mode:'new'|'rename';afterSave?:()=>void};
export interface PromptSettingsPageHandle {requestClose:()=>void;beforeClose:()=>Promise<boolean>;save:()=>Promise<boolean>}
interface Props {customizations?:PromptCustomizations;settings?:PromptSettingsDocument;config?:PromptConfig;onModels:()=>void;onModules:()=>void;onClose:()=>void;onExecute:(command:Command)=>Promise<ApiResponse>}
const instructionKey=(value:ModuleInstructionOverrides={})=>JSON.stringify([value.native_instruction,value.numbered_instruction]);
const cleanSelections=(value:PromptSettingsDocument)=>{
  for(const [target,id] of Object.entries(value.selected_presets))if(!value.presets.some(preset=>preset.id===id&&presetTarget(preset)===target))delete value.selected_presets[target as PresetTarget];
  return value;
};
const writeInferenceInstruction=(settings:PromptSettingsDocument,module:CustomizableModuleType,value:string|undefined)=>{
  if(value===undefined){
    if(settings.inference_instructions){delete settings.inference_instructions[module];if(!Object.keys(settings.inference_instructions).length)delete settings.inference_instructions;}
  }else (settings.inference_instructions??={})[module]=value;
};

export const PromptSettingsPage=forwardRef<PromptSettingsPageHandle,Props>(function PromptSettingsPage({customizations=emptyPromptCustomizations,settings,config,onModels,onModules,onClose,onExecute},ref){
  const incoming=JSON.stringify(settings??createPromptSettings(customizations));
  const [draft,setDraft]=useState<PromptSettingsDocument>(()=>JSON.parse(incoming));
  const [baseline,setBaseline]=useState(incoming);
  const [selection,setSelection]=useState<Selection>({kind:'module',id:'subject'});
  const [moduleMode,setModuleMode]=useState<ModuleMode>('generation');
  const [imageCount,setImageCount]=useState(1),[yaw,setYaw]=useState(30),[pitch,setPitch]=useState(-20);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [pending,setPending]=useState<Pending|null>(null),[resetAll,setResetAll]=useState(false);
  const [nameDialog,setNameDialog]=useState<NameDialog|null>(null),[presetName,setPresetName]=useState('');
  const [deletePreset,setDeletePreset]=useState(false),[switchPreset,setSwitchPreset]=useState<string|null>(null);
  const working=useRef(false),latest=useRef({draft,baseline}),pendingRef=useRef(pending);
  latest.current={draft,baseline};pendingRef.current=pending;
  const dirty=JSON.stringify(draft)!==baseline;
  const applied=useMemo(()=>JSON.parse(baseline) as PromptSettingsDocument,[baseline]);
  const libraryDirty=JSON.stringify(draft.presets)!==JSON.stringify(applied.presets);
  useEffect(()=>{
    const current=latest.current;
    if(JSON.stringify(current.draft)===current.baseline||JSON.stringify(current.draft)===incoming){setDraft(JSON.parse(incoming));setBaseline(incoming);}
    else if(current.baseline!==incoming)setNotice('已应用的配置发生了变化。当前未应用的编辑仍保留。');
  },[incoming]);
  useEffect(()=>()=>pendingRef.current?.resolve?.(false),[]);
  const validation=useMemo(()=>promptSettingsSchema.safeParse(draft),[draft]);
  const validationError=validation.success?'':validation.error.issues.map(issue=>issue.message).filter((message,index,list)=>list.indexOf(message)===index).join(' ');
  const hasCustomizations=Object.values(draft.customizations.modules).some(value=>value&&Object.keys(value).length>0)||Object.keys(draft.customizations.roles).length>0||Object.keys(draft.inference_instructions??{}).length>0||Object.keys(draft.selected_presets).length>0;
  const isGeneration=selection.kind==='module'&&moduleMode==='generation';
  const isInference=selection.kind==='module'&&moduleMode==='inference';
  const target:PresetTarget=isInference?`inference:${selection.id as CustomizableModuleType}`:selection.id;
  const instructions:ModuleInstructionOverrides=selection.kind==='module'?draft.customizations.modules[selection.id]??{}:{};
  const defaults=selection.kind==='module'?releasePromptConfig.modules[selection.id]:undefined;
  const roleText=selection.kind==='role'?draft.customizations.roles[selection.id]:undefined;
  const defaultRole=selection.kind==='role'?promptRoles.find(role=>role.id===selection.id)!.instruction:'';
  const inferenceText=selection.kind==='module'?draft.inference_instructions?.[selection.id]:undefined;
  const defaultInference=selection.kind==='module'?defaultModuleInferenceInstructions[selection.id]:'';
  const plainText=isInference?inferenceText:roleText;
  const defaultPlainText=isInference?defaultInference:defaultRole;
  const currentDirty=(selection.kind==='module'
    ?isInference?inferenceText!==applied.inference_instructions?.[selection.id]:instructionKey(instructions)!==instructionKey(applied.customizations.modules[selection.id])
    :roleText!==applied.customizations.roles[selection.id])||draft.selected_presets[target]!==applied.selected_presets[target];
  const title=selection.kind==='module'?modules.find(item=>item.id===selection.id)!.title:promptRoles.find(item=>item.id===selection.id)!.title;
  const description=selection.kind==='module'?modules.find(item=>item.id===selection.id)!.description:promptRoles.find(item=>item.id===selection.id)!.description;
  const currentCustom=isGeneration?Object.keys(instructions).length>0:plainText!==undefined;
  const presets=draft.presets.filter(preset=>presetTarget(preset)===target);
  const currentPreset=presets.find(preset=>preset.id===draft.selected_presets[target]);
  const presetModified=!!currentPreset&&('instructions' in currentPreset?instructionKey(instructions)!==instructionKey(currentPreset.instructions):plainText!==currentPreset.instruction);
  const currentInstructionsValid=selection.kind==='module'
    ?isInference?inferenceInstructionPresetSchema.safeParse({id:'draft',name:'当前编辑',kind:'inference',module:selection.id,instruction:inferenceText}).success:moduleInstructionPresetSchema.safeParse({id:'draft',name:'当前编辑',module:selection.id,instructions}).success
    :roleInstructionPresetSchema.safeParse({id:'draft',name:'当前编辑',role:selection.id,instruction:roleText}).success;
  const effectiveInstructions={native_instruction:instructions.native_instruction??defaults?.native_instruction??'',numbered_instruction:instructions.numbered_instruction??defaults?.numbered_instruction??''};
  const preview=useMemo(()=>{
    if(selection.kind!=='module'||!isGeneration)return {native:[],numbered:'',images:[],error:''};
    try{return {...previewModuleInstructions(selection.id,effectiveInstructions,{imageCount,toolState:{yaw,pitch,roll:0,projection:'orthographic'},config}),error:''};}
    catch(error){return {native:[],numbered:'',images:[],error:error instanceof Error?error.message:'请检查当前指令。'};}
  },[selection,isGeneration,effectiveInstructions.native_instruction,effectiveInstructions.numbered_instruction,imageCount,yaw,pitch,config]);
  const edit=(next:PromptSettingsDocument)=>{setDraft(next);setError('');setNotice('');};
  const setInstruction=(key:keyof ModuleInstructionOverrides,value:string|undefined)=>{
    if(selection.kind!=='module')return;
    const next=structuredClone(draft),entry={...next.customizations.modules[selection.id]};
    if(value===undefined)delete entry[key];else entry[key]=value;
    if(Object.keys(entry).length)next.customizations.modules[selection.id]=entry;else delete next.customizations.modules[selection.id];
    edit(next);
  };
  const setRole=(value:string|undefined)=>{
    if(selection.kind!=='role')return;
    const next=structuredClone(draft);
    if(value===undefined)delete next.customizations.roles[selection.id];else next.customizations.roles[selection.id]=value;
    edit(next);
  };
  const setInference=(value:string|undefined)=>{
    if(selection.kind!=='module')return;
    const next=structuredClone(draft);writeInferenceInstruction(next,selection.id,value);edit(next);
  };
  const resetCurrent=()=>{
    const next=structuredClone(draft);
    delete next.selected_presets[target];
    if(selection.kind==='module'){
      if(isInference)writeInferenceInstruction(next,selection.id,undefined);else delete next.customizations.modules[selection.id];
    }
    else delete next.customizations.roles[selection.id];
    edit(next);setNotice('此项将在保存并应用后恢复默认，已保存的预设会保留。');
  };
  const save=async()=>{
    if(working.current)return false;
    const parsed=promptSettingsSchema.safeParse(latest.current.draft);
    if(!parsed.success){setError(validationError||'请检查自定义指令。');return false;}
    working.current=true;setBusy(true);setError('');setNotice('');
    try{
      const response=await onExecute({type:'prompt-settings:save',settings:parsed.data});
      if(!response.ok)throw Error(response.error??'核心指令未保存，请重试。');
      if(response.cancelled)return false;
      const next=response.state?.prompt_settings??parsed.data;
      setDraft(structuredClone(next));setBaseline(JSON.stringify(next));setNotice('全部编辑已应用于后续任务。');return true;
    }catch(error){setError(error instanceof Error?error.message:'核心指令未保存，请重试。');return false;}
    finally{working.current=false;setBusy(false);}
  };
  const modal=!!pending||resetAll||!!nameDialog||deletePreset||switchPreset!==null;
  const guard=(action:()=>void)=>{if(working.current||modal)return;if(dirty)setPending({action});else action();};
  const cancelPending=()=>{pending?.resolve?.(false);setPending(null);};
  useImperativeHandle(ref,()=>({requestClose:()=>guard(onClose),save,beforeClose:()=>{
    if(working.current||modal)return Promise.resolve(false);
    if(!dirty)return Promise.resolve(true);
    return new Promise<boolean>(resolve=>setPending({action:()=>{},resolve}));
  }}));
  const importDraft=async()=>{
    if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');
    try{
      const response=await onExecute({type:'prompt-customizations:import'});
      if(!response.ok)throw Error(response.error??'导入失败。');
      if(response.cancelled)return;
      const imported=response.prompt_settings??response.prompt_customizations;
      if(!imported)throw Error('导入文件没有可用的提示词配置。');
      const next=mergeImportedPromptSettings(latest.current.draft,imported);
      setDraft(next);
      const module=modules.find(item=>next.customizations.modules[item.id]||next.presets.some(preset=>presetTarget(preset)===item.id)),role=promptRoles.find(item=>next.customizations.roles[item.id]!==undefined||next.presets.some(preset=>presetTarget(preset)===item.id));
      const inferenceModule=modules.find(item=>next.inference_instructions?.[item.id]!==undefined||next.presets.some(preset=>presetTarget(preset)===`inference:${item.id}`));
      if(module){setSelection({kind:'module',id:module.id});setModuleMode('generation');}else if(role)setSelection({kind:'role',id:role.id});
      else if(inferenceModule){setSelection({kind:'module',id:inferenceModule.id});setModuleMode('inference');}
      setNotice(imported.version===2?`已载入整套配置（${next.presets.length} 个预设）。保存并应用后替换当前指令与预设库。`:'已载入旧版配置，现有预设库保留。检查后保存并应用。');
    }catch(error){setError(error instanceof Error?error.message:'导入失败。');}
    finally{working.current=false;setBusy(false);}
  };
  const exportDraft=async()=>{
    if(working.current)return;
    if(!validation.success){setError(validationError);return;}
    working.current=true;setBusy(true);setError('');setNotice('');
    try{
      const response=await onExecute({type:'prompt-customizations:export',customizations:validation.data.customizations,settings:validation.data});
      if(!response.ok)throw Error(response.error??'导出失败。');
      if(!response.cancelled)setNotice(`已导出${dirty?'当前编辑及':'整套配置和'}全部 ${draft.presets.length} 个预设。`);
    }catch(error){setError(error instanceof Error?error.message:'导出失败。');}
    finally{working.current=false;setBusy(false);}
  };
  const persistLibrary=async(next:PromptSettingsDocument,message:string)=>{
    if(working.current||libraryDirty)return false;
    const parsed=promptPresetLibrarySchema.safeParse(next.presets);
    if(!parsed.success){setError(parsed.error.issues.map(issue=>issue.message).join(' '));return false;}
    working.current=true;setBusy(true);setError('');
    try{
      const response=await onExecute({type:'prompt-presets:save',presets:parsed.data});
      if(!response.ok)throw Error(response.error??'预设未保存，请重试。');
      if(response.cancelled)return false;
      const saved=response.state?.prompt_settings??cleanSelections({...structuredClone(applied),presets:parsed.data});
      const nextDraft={...next,presets:parsed.data};
      setBaseline(JSON.stringify(saved));setDraft(nextDraft);
      setNotice(message+(JSON.stringify(nextDraft)!==JSON.stringify(saved)?' 当前编辑尚未应用。':''));return true;
    }catch(error){setError(error instanceof Error?error.message:'预设未保存，请重试。');return false;}
    finally{working.current=false;setBusy(false);}
  };
  const openName=(mode:NameDialog['mode'],afterSave?:()=>void)=>{
    setPresetName(mode==='rename'?currentPreset?.name??'':'');setNameDialog({mode,afterSave});
  };
  const saveName=async()=>{
    if(!nameDialog)return;
    const name=presetName.trim();
    if(!name)throw Error('请输入预设名称。');
    if(name.length>80)throw Error('预设名称不能超过 80 个字符。');
    if(presets.some(preset=>preset.name===name&&(nameDialog.mode==='new'||preset.id!==currentPreset?.id)))throw Error('此指令项已有同名预设，请换一个名称。');
    const next=structuredClone(draft);
    if(nameDialog.mode==='rename'){
      const preset=next.presets.find(preset=>preset.id===currentPreset?.id);
      if(!preset)throw Error('预设已不存在，请重新选择。');
      preset.name=name;
    }else{
      const id=crypto.randomUUID();
      const preset:InstructionPreset=selection.kind==='module'
        ?isInference?{id,name,kind:'inference',module:selection.id,...(inferenceText===undefined?{}:{instruction:inferenceText})}:{id,name,module:selection.id,instructions:structuredClone(instructions)}
        :{id,name,role:selection.id,...(roleText===undefined?{}:{instruction:roleText})};
      next.presets.push(preset);
      next.selected_presets[target]=id;
    }
    if(!await persistLibrary(next,nameDialog.mode==='rename'?'预设名称已保存。':'预设已保存。'))throw Error('预设未保存，请检查指令后重试。');
    const afterSave=nameDialog.afterSave;setNameDialog(null);afterSave?.();
  };
  const updatePreset=async()=>{
    if(!currentPreset)return;
    const next=structuredClone(draft);
    const preset=next.presets.find(preset=>preset.id===currentPreset.id)!;
    if('instructions' in preset)preset.instructions=structuredClone(instructions);
    else if(plainText===undefined)delete preset.instruction;else preset.instruction=plainText;
    await persistLibrary(next,'预设已更新。');
  };
  const removePreset=async()=>{
    if(!currentPreset)return;
    const next=cleanSelections({...structuredClone(draft),presets:draft.presets.filter(preset=>preset.id!==currentPreset.id)});
    if(!await persistLibrary(next,'预设已删除，当前指令文字已保留为自定义。'))throw Error('预设未删除，请重试。');
    setDeletePreset(false);
  };
  const loadPreset=(value:string)=>{
    setDraft(previous=>{
      const next=structuredClone(previous);
      delete next.selected_presets[target];
      if(value==='default'){
        if(selection.kind==='module'){
          if(isInference)writeInferenceInstruction(next,selection.id,undefined);else delete next.customizations.modules[selection.id];
        }
        else delete next.customizations.roles[selection.id];
      }
      else if(value==='custom'){
        if(selection.kind==='module'){
          if(isInference){if(next.inference_instructions?.[selection.id]===undefined)writeInferenceInstruction(next,selection.id,defaultInference);}
          else if(!Object.keys(next.customizations.modules[selection.id]??{}).length)next.customizations.modules[selection.id]={native_instruction:defaults?.native_instruction??'',numbered_instruction:defaults?.numbered_instruction??''};
        }else if(next.customizations.roles[selection.id]===undefined)next.customizations.roles[selection.id]=defaultRole;
      }else{
        const preset=next.presets.find(preset=>`preset:${preset.id}`===value&&presetTarget(preset)===target);
        if(!preset)return previous;
        if('kind' in preset)writeInferenceInstruction(next,preset.module,preset.instruction);
        else if('module' in preset)next.customizations.modules[preset.module]=structuredClone(preset.instructions);
        else if(preset.instruction===undefined)delete next.customizations.roles[preset.role];else next.customizations.roles[preset.role]=preset.instruction;
        next.selected_presets[target]=preset.id;
      }
      return next;
    });
    setError('');setNotice('已载入当前项，保存并应用后用于后续任务。');
  };
  const choosePreset=(value:string)=>{
    const unsaved=currentPreset?presetModified:currentCustom&&currentDirty;
    if(unsaved&&value!=='custom')setSwitchPreset(value);else loadPreset(value);
  };
  const selectedKey=selection.kind+':'+selection.id;
  const presetControlsDisabled=busy||libraryDirty;
  return <section className="global-settings prompt-settings" aria-label="核心指令设置">
    <div inert={modal?true:undefined}><SettingsPageHeader page="prompts" busy={busy} onModels={()=>guard(onModels)} onModules={()=>guard(onModules)} onPrompts={()=>{}} onClose={()=>guard(onClose)}/></div>
    <div className="prompt-settings-intro" inert={modal?true:undefined}>
      <div className="prompt-intro-title"><h2>核心指令</h2><p>阅读默认指令，调整并保存常用预设。</p></div>
      <div className="prompt-settings-transfer"><span>{draft.presets.length} 个预设</span><div><button disabled={busy} onClick={()=>guard(()=>void importDraft())}>导入配置</button><button disabled={busy||!validation.success} onClick={()=>void exportDraft()}>{dirty?'导出当前编辑':'导出配置'}</button><button disabled={busy||!hasCustomizations} onClick={()=>setResetAll(true)}>全部恢复默认</button></div></div>
    </div>
    <div className="prompt-settings-body" inert={modal?true:undefined}>
      <nav className="prompt-settings-items" aria-label="自定义指令分类">
        <h3>模块指令</h3>
        {modules.map((item,index)=><button key={item.id} data-prompt-item={`module:${item.id}`} aria-pressed={selectedKey===`module:${item.id}`} disabled={busy} onClick={()=>{setSelection({kind:'module',id:item.id});setError('');}}><span className="prompt-item-index">0{index+1}</span><span><b>{item.title}</b><small>{draft.selected_presets[item.id]||draft.selected_presets[`inference:${item.id}`]?'预设':Object.keys(draft.customizations.modules[item.id]??{}).length||draft.inference_instructions?.[item.id]!==undefined?'自定义':'默认'}</small></span><span className="prompt-item-dot" aria-hidden="true"/></button>)}
        <h3>角色指令</h3>
        {promptRoles.map(item=><button key={item.id} data-prompt-item={`role:${item.id}`} aria-pressed={selectedKey===`role:${item.id}`} disabled={busy} onClick={()=>{setSelection({kind:'role',id:item.id});setError('');}}><span className="prompt-item-index">↗</span><span><b>{item.title}</b><small>{draft.selected_presets[item.id]?'预设':draft.customizations.roles[item.id]!==undefined?'自定义':'默认'}</small></span><span className="prompt-item-dot" aria-hidden="true"/></button>)}
        <p className="prompt-nav-note">预设保存在当前这份 Ediro。<br/>导出配置可备份或迁移。</p>
      </nav>
      <div className="prompt-settings-main">
        <div className="prompt-settings-context" data-kind={selection.kind} data-mode={selection.kind==='module'?moduleMode:'role'}>
        <div className="prompt-settings-current"><div className="prompt-current-heading"><h3>{title}{selection.kind==='module'?'模块指令':'角色指令'}</h3><span className="settings-status" data-dirty={currentDirty}>{currentDirty?'有未应用修改':currentCustom?'已应用自定义':'使用默认'}</span></div>{selection.kind==='module'?<div className="prompt-module-mode" role="group" aria-label={`${title}指令类型`}><button aria-pressed={isGeneration} disabled={busy} title={description} onClick={()=>{setModuleMode('generation');setError('');setNotice('');}}>生图指令</button><button aria-pressed={isInference} disabled={busy} title={`设置${title}模块的识别与文字整理要求`} onClick={()=>{setModuleMode('inference');setError('');setNotice('');}}>推理指令</button></div>:<p>{description}</p>}</div>
        <div className="prompt-preset-bar">
          <label htmlFor="prompt-preset-select">指令预设<select id="prompt-preset-select" aria-label={`${title}${isInference?'推理':''}指令预设`} value={currentPreset?`preset:${currentPreset.id}`:currentCustom?'custom':'default'} disabled={busy} onChange={event=>choosePreset(event.target.value)}><option value="default">出厂默认</option><option value="custom">当前自定义</option>{presets.map(preset=><option key={preset.id} value={`preset:${preset.id}`}>{preset.name}</option>)}</select></label>
          <div className="prompt-preset-actions"><button disabled={presetControlsDisabled||!currentCustom||!currentInstructionsValid} onClick={()=>openName('new')}>另存为预设</button>{currentPreset&&<><button disabled={presetControlsDisabled||!presetModified||!currentInstructionsValid} onClick={()=>void updatePreset()}>更新此预设</button><details className="prompt-preset-menu" key={selectedKey+currentPreset.id}><summary aria-label="预设管理">更多 <span aria-hidden="true">⌄</span></summary><div><button disabled={presetControlsDisabled} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');openName('rename');}}>重命名预设</button><button disabled={presetControlsDisabled} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');setDeletePreset(true);}}>删除预设</button></div></details></>}</div>
          <p>{libraryDirty?'导入的预设库尚未应用，请先保存并应用，再管理预设。':presetModified?'此预设有未保存的修改。':currentPreset?'保存预设用于收藏；保存并应用用于后续任务。':currentCustom?'可直接应用，也可命名后保存为预设。':'出厂默认只读；开启下方自定义，即可从默认内容开始编辑。'}</p>
        </div>
        <button className="prompt-current-reset" disabled={busy||(!currentCustom&&!currentPreset)} onClick={resetCurrent}>恢复此项默认</button>
        </div>
        <div className="prompt-settings-workspace">
          <section className="prompt-settings-editor" aria-label="自定义指令编辑">
            <div className="prompt-column-heading"><h4>{isInference?'推理工作要求':'指令内容'}</h4><span>{currentCustom?'自定义编辑':'出厂默认 · 只读'}</span></div>
            {isGeneration?<>
              {expressions.map(expression=>{
                const custom=instructions[expression.key]!==undefined;
                return <div className="prompt-instruction-field" key={expression.key}>
                  <div className="prompt-instruction-heading"><label htmlFor={`prompt-${expression.key}`}>{expression.title}</label><label className="settings-check"><input type="checkbox" aria-label={`自定义${expression.title}`} checked={custom} disabled={busy} onChange={event=>setInstruction(expression.key,event.target.checked?defaults?.[expression.key]??'':undefined)}/>自定义</label></div>
                  <p className="prompt-field-description">{expression.description}<span>{custom?'编辑中':'默认 · 只读'}</span></p>
                  <textarea id={`prompt-${expression.key}`} aria-label={`${title}${expression.title}指令`} value={instructions[expression.key]??defaults?.[expression.key]??''} readOnly={!custom||busy} aria-readonly={!custom||busy} data-default={!custom} maxLength={32000} spellCheck={false} placeholder={custom?'填写你的指令':''} onChange={event=>setInstruction(expression.key,event.target.value)}/>
                </div>;
              })}
              <div className="prompt-template-help" aria-label="可用字段说明"><p><strong>可用字段</strong><code>{'{images}'}</code> 本模块的图片编号，如 image_1、image_2。{selection.id==='viewpoint'&&<><br/><code>{'{viewpoint}'}</code> 当前视角描述。</>}</p><p>适用于上方两种表达。</p></div>
            </>:isInference?<div className="prompt-instruction-field prompt-inference-field">
              <div className="prompt-instruction-heading"><label htmlFor="prompt-inference-instruction">{title}推理指令</label><label className="settings-check"><input type="checkbox" aria-label="自定义推理指令" checked={inferenceText!==undefined} disabled={busy} onChange={event=>setInference(event.target.checked?defaultInference:undefined)}/>自定义</label></div>
              <textarea id="prompt-inference-instruction" aria-label={`${title}推理指令`} value={inferenceText??defaultInference} readOnly={busy||inferenceText===undefined} aria-readonly={busy||inferenceText===undefined} data-default={inferenceText===undefined} maxLength={32000} spellCheck={false} placeholder="填写这个模块的识别与整理要求" onChange={event=>setInference(event.target.value)}/>
              <p className="settings-hint">{selection.id==='composition'||selection.id==='style'?'用于提取描述和整体提示词推理。':'用于整体提示词推理，控制如何参考当前模块。'}</p>
            </div>:<div className="prompt-instruction-field prompt-role-field">
              <div className="prompt-instruction-heading"><label htmlFor="prompt-role-instruction">角色工作要求</label><label className="settings-check"><input type="checkbox" aria-label="自定义角色指令" checked={roleText!==undefined} disabled={busy} onChange={event=>setRole(event.target.checked?defaultRole:undefined)}/>自定义</label></div>
              <textarea id="prompt-role-instruction" aria-label={`${title}角色指令`} value={roleText??defaultRole} readOnly={busy||roleText===undefined} aria-readonly={busy||roleText===undefined} data-default={roleText===undefined} maxLength={32000} spellCheck={false} placeholder="填写这个角色的工作要求" onChange={event=>setRole(event.target.value)}/>
              <p className="settings-hint">作为推理模型的系统指令，指导提示词的整理与设计。</p>
            </div>}
            <p className="prompt-empty-hint">自定义留空并保存会清空此项指令；取消自定义则使用默认。{isInference&&<><br/>推理配置保存在程序设置中，不随工程保存。</>}</p>
            {validationError&&<p className="settings-notice" role="alert">{validationError}</p>}
          </section>
          <section className="prompt-settings-preview" aria-label="当前项编译预览">
            <div className="prompt-column-heading prompt-preview-heading"><h4>{isGeneration?'当前模块编译预览':isInference?'当前推理指令预览':'当前角色指令预览'}</h4><span>{currentDirty?'未应用预览':'当前配置'}</span></div>
            {isGeneration?<>
              <div className="prompt-preview-options">
                <label>试编译图片数<select aria-label="试编译图片数" value={imageCount} disabled={busy} onChange={event=>setImageCount(Number(event.target.value))}>{Array.from({length:16},(_,index)=>index+1).map(number=><option key={number} value={number}>{number} 张</option>)}</select></label>
                {selection.id==='viewpoint'&&<><label>水平角度<input type="number" aria-label="试编译水平角度" min={-180} max={180} value={yaw} disabled={busy} onChange={event=>setYaw(Number(event.target.value))}/></label><label>俯仰角度<input type="number" aria-label="试编译俯仰角度" min={-90} max={90} value={pitch} disabled={busy} onChange={event=>setPitch(Number(event.target.value))}/></label></>}
              </div>
              <p className="prompt-preview-note">只试编译当前项；图片用编号表示，不调用模型。</p>
              {preview.error&&<p className="settings-notice" role="alert">{preview.error}</p>}
              <div className="prompt-compiled-group"><h5>原生图文顺序</h5><div className="prompt-compiled-output" data-prompt-preview="native">{preview.native.length?preview.native.map((block,index)=>block.type==='text'?<pre key={index}>{block.text}</pre>:<span className="prompt-preview-image" key={index}>▧ {block.image_name}</span>):<span className="prompt-preview-empty">此表达已清空</span>}</div></div>
              <div className="prompt-compiled-group"><h5>文字＋图片集合</h5><div className="prompt-compiled-output" data-prompt-preview="numbered">{preview.numbered?<><pre>{preview.numbered}</pre>{preview.images.length>0&&<div className="prompt-preview-images">{preview.images.map(name=><span className="prompt-preview-image" key={name}>▧ {name}</span>)}</div>}</>:<span className="prompt-preview-empty">此表达已清空</span>}</div></div>
            </>:<>{isInference&&<p className="prompt-preview-note">只预览当前模块的推理指令，不调用模型。</p>}<div className={`prompt-compiled-output ${isInference?'prompt-inference-output':'prompt-role-output'}`} data-prompt-preview={isInference?'inference':'role'}>{(plainText??defaultPlainText)?<pre>{plainText??defaultPlainText}</pre>:<span className="prompt-preview-empty">此{isInference?'推理':'角色'}指令已清空</span>}</div></>}
          </section>
        </div>
        <div className="prompt-settings-savebar">
          <div className="prompt-settings-save-actions"><button className="primary" disabled={busy||!dirty||!validation.success} onClick={()=>void save()}>保存并应用</button><button disabled={busy||!dirty} onClick={()=>{setDraft(JSON.parse(baseline));setError('');setNotice('');}}>还原未应用修改</button></div>
          {error?<p role="alert" className="prompt-settings-error">{error}</p>:<p role="status">{notice||(dirty?'所有模块与角色的修改将在保存并应用后生效。':'默认指令可直接阅读；自定义仅作用于当前这份 Ediro。')}</p>}
        </div>
      </div>
    </div>
    {resetAll&&<AppDialog title="恢复全部默认指令" onDismiss={()=>setResetAll(false)} actions={[{label:'取消',run:()=>setResetAll(false)},{label:'恢复默认',primary:true,run:()=>{const next={...structuredClone(draft),customizations:structuredClone(emptyPromptCustomizations),selected_presets:{}};delete next.inference_instructions;edit(next);setNotice('全部指令将在保存并应用后恢复默认，预设库保留。');setResetAll(false);}}]}>恢复所有模块的生图、推理指令与角色指令，保存并应用后生效。已保存的预设不会删除。</AppDialog>}
    {pending&&<AppDialog title="核心指令尚未应用" onDismiss={cancelPending} actions={[{label:'继续编辑',run:cancelPending},{label:'放弃修改',run:()=>{const next=pending;setDraft(JSON.parse(baseline));setPending(null);next.action();next.resolve?.(true);}},{label:'保存并继续',primary:true,run:async()=>{if(!await save())throw Error('请检查自定义指令后重试。');const next=pending;setPending(null);next.action();next.resolve?.(true);}}]}>当前修改尚未应用。保存后继续，或放弃本次修改。已经保存到预设库的内容会保留。</AppDialog>}
    {nameDialog&&<AppDialog title={nameDialog.mode==='new'?'保存为命名预设':'重命名预设'} onDismiss={()=>{if(!busy)setNameDialog(null);}} actions={[{label:'取消',run:()=>setNameDialog(null)},{label:nameDialog.mode==='new'?'保存预设':'保存名称',primary:true,run:saveName}]}><p>{nameDialog.mode==='new'?(isInference?`保存${title}模块的推理指令及其默认／自定义状态。`:selection.kind==='module'?`保存${title}模块的两种生图表达及其默认／自定义状态。`:`保存${title}角色的系统指令及其默认／自定义状态。`):'修改显示名称，指令内容和当前选择保持不变。'}</p><label className="prompt-preset-name">预设名称<input aria-label="预设名称" value={presetName} maxLength={80} disabled={busy} placeholder={selection.kind==='module'?isInference?'例如：只提取商品细节':'例如：严格保留商品细节':'例如：精修、场景设计'} onChange={event=>setPresetName(event.target.value)}/></label><p>预设保存在当前这份 Ediro 的用户设置中，导出配置时一起打包。</p></AppDialog>}
    {deletePreset&&currentPreset&&<AppDialog title="删除指令预设" onDismiss={()=>{if(!busy)setDeletePreset(false);}} actions={[{label:'取消',run:()=>setDeletePreset(false)},{label:'删除预设',primary:true,run:removePreset}]}>删除“{currentPreset.name}”？当前指令文字会保留为自定义，已经应用的任务配置不变。</AppDialog>}
    {switchPreset!==null&&<AppDialog title="保留当前指令修改" onDismiss={()=>setSwitchPreset(null)} actions={[{label:'继续编辑',run:()=>setSwitchPreset(null)},{label:'放弃修改并切换',run:()=>{loadPreset(switchPreset);setSwitchPreset(null);}},...(!libraryDirty&&currentInstructionsValid?[{label:'先存为预设',primary:true,run:()=>{const value=switchPreset;setSwitchPreset(null);openName('new',()=>loadPreset(value));}}]:[])]}>{libraryDirty?'导入的预设库尚未应用。继续编辑并保存应用后，即可另存为预设；直接切换会放弃当前项的编辑。':!currentInstructionsValid?'当前指令未通过校验，请继续编辑修正，或放弃修改后切换。':'切换预设会替换当前项的编辑。可以先另存为预设，也可以放弃修改后切换。'}</AppDialog>}
  </section>;
});
