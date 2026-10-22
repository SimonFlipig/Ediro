import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizePromptConfig, type CurrentPromptConfig } from '../core/prompt-config.js';
import { releasePromptConfig } from '../core/release-prompt-config.js';
import { ModuleRegistry } from '../core/modules.js';
import { applyPromptCustomizations, emptyPromptCustomizations, promptCustomizationsSchema, type PromptCustomizations } from '../core/prompt-customization.js';
import { atomicJson } from './atomic-json.js';

export const promptCustomizationsFilename='prompt-customizations.v1.json';
const editableModules=['subject','composition','style','viewpoint'] as const;
const instructionFields=['native_instruction','numbered_instruction'] as const;

async function loadLegacyPromptConfig(runtimeDirectory:string){
  try{return normalizePromptConfig(JSON.parse(await readFile(path.join(runtimeDirectory,'prompt-config.v1.json'),'utf8')));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return normalizePromptConfig(releasePromptConfig);throw new Error('提示词配置无效，请检查 prompt-config.v1.json；不会静默使用默认规则。');}
}

// Preserve the old Tuner's layout/name options without changing its file.
// Once the new file exists it owns editable text, so reset restores this
// release rather than reviving an older Tuner override.
export function customizationBase(legacy:CurrentPromptConfig):CurrentPromptConfig{
  const base=structuredClone(legacy);
  for(const type of editableModules){
    const options={...base.modules[type]};
    for(const field of instructionFields){
      const released=releasePromptConfig.modules[type]?.[field];
      if(released===undefined)delete options[field];else options[field]=released;
    }
    if(Object.keys(options).length)base.modules[type]=options;else delete base.modules[type];
  }
  return base;
}

function legacyCustomizations(config:CurrentPromptConfig):PromptCustomizations{
  const customizations=structuredClone(emptyPromptCustomizations);
  const defaults=new ModuleRegistry(undefined,releasePromptConfig);
  for(const type of editableModules){
    const definition=defaults.get(type);
    for(const field of instructionFields){
      const text=config.modules[type]?.[field];
      const defaultText=field==='native_instruction'?definition.base_instruction:definition.numbered_instruction??definition.base_instruction;
      if(text!==undefined&&text!==defaultText)(customizations.modules[type]??={})[field]=text;
    }
  }
  return promptCustomizationsSchema.parse(customizations);
}

export async function loadPromptSettings(runtimeDirectory:string){
  const legacy=await loadLegacyPromptConfig(runtimeDirectory);
  let customizations:PromptCustomizations;
  try{customizations=promptCustomizationsSchema.parse(JSON.parse(await readFile(path.join(runtimeDirectory,promptCustomizationsFilename),'utf8')));}
  catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT'){
      const customizations=legacyCustomizations(legacy);
      return {config:applyPromptCustomizations(customizationBase(legacy),customizations),customizations};
    }
    throw new Error('自定义指令配置无效，请检查 prompt-customizations.v1.json；原文件未修改。');
  }
  return {config:applyPromptCustomizations(customizationBase(legacy),customizations),customizations};
}

export async function loadPromptConfig(runtimeDirectory:string){return (await loadPromptSettings(runtimeDirectory)).config;}

export async function savePromptCustomizations(runtimeDirectory:string,input:PromptCustomizations){
  const customizations=promptCustomizationsSchema.parse(input);
  const config=applyPromptCustomizations(customizationBase(await loadLegacyPromptConfig(runtimeDirectory)),customizations);
  new ModuleRegistry(undefined,config,customizations.roles);
  await atomicJson(path.join(runtimeDirectory,promptCustomizationsFilename),customizations);
  return {config,customizations};
}

export async function importPromptCustomizations(filename:string):Promise<PromptCustomizations>{
  if((await stat(filename)).size>2*1024*1024)throw new Error('指令文件不能超过 2 MB。');
  try{return promptCustomizationsSchema.parse(JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,'')));}
  catch{throw new Error('指令文件格式无效，请选择 Ediro 导出的自定义指令 JSON；当前设置未改变。');}
}

export async function exportPromptCustomizations(filename:string,input:PromptCustomizations){
  await atomicJson(filename,promptCustomizationsSchema.parse(input));
}
