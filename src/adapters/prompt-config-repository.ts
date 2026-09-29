import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizePromptConfig } from '../core/prompt-config.js';
import { releasePromptConfig } from '../core/release-prompt-config.js';

export async function loadPromptConfig(runtimeDirectory:string){
  try{return normalizePromptConfig(JSON.parse(await readFile(path.join(runtimeDirectory,'prompt-config.v1.json'),'utf8')));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return normalizePromptConfig(releasePromptConfig);throw new Error('提示词配置无效，请检查 prompt-config.v1.json；不会静默使用默认规则。');}
}
