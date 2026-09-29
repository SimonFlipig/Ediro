import { readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { modelConfigSchema } from '../core/domain.js';
import { librarySchema, migrateModels } from '../core/model-library.js';
import { seedModels } from '../core/models.js';
import { migrateGenerationModel } from '../protocols/legacy-generation.js';
import { atomicJson } from './project-repository.js';
import { migrateModelSettings } from '../core/model-settings.js';

export const modelLibraryFilename='model-library.v3.json';

async function openLegacyLibrary(directory:string) {
  const file=path.join(directory,'model-library.v1.json');
  try {
    const data=librarySchema.parse(JSON.parse(await readFile(file,'utf8')));
    // Only the old adapter identifier triggers migration; never infer protocol from a hostname.
    if(data.models.some(m=>m.adapter_id==='kuai-images')){
      try{await copyFile(file,path.join(directory,'model-library.pre-images-protocol-v1.json'),2);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
      for(const model of data.models){if(model.adapter_id!=='kuai-images')continue;model.adapter_id='openai-images';model.images_compatibility={format_field:'format',image_field:'image',send_response_format:true,max_prompt_chars:1000};model.revision++;delete model.validation;}
      await atomicJson(file,data);
    }
    return data;
  }
  catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('模型库文件无效；不会重置配置，请保留文件检查。'); }
  const legacy=path.join(directory,'models.json');
  let models;
  try { models=z.array(modelConfigSchema).parse(JSON.parse(await readFile(legacy,'utf8')));await copyFile(legacy,path.join(directory,'models.pre-library-v1.json'),2); }
  catch(e) { if((e as NodeJS.ErrnoException).code==='EEXIST') { models=z.array(modelConfigSchema).parse(JSON.parse(await readFile(legacy,'utf8'))); }
    else if((e as NodeJS.ErrnoException).code==='ENOENT')models=seedModels();else throw new Error('旧模型配置无效或无法备份；迁移未完成，不会覆盖原配置。'); }
  const data=migrateModels(models);await atomicJson(file,data);
  return librarySchema.parse(JSON.parse(await readFile(file,'utf8')));
}

async function openV2Library(directory:string){
  const file=path.join(directory,'model-library.v2.json');
  try{
    const parsed=librarySchema.parse(JSON.parse(await readFile(file,'utf8')));
    if(parsed.schema_version!==2)throw new Error('模型库版本不匹配。');
    return parsed;
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('模型库文件无效；不会重置配置，请保留文件检查。');}
  const old=await openLegacyLibrary(directory);
  const next=librarySchema.parse({...old,schema_version:2,models:old.models.map(migrateGenerationModel)});
  await copyFile(path.join(directory,'model-library.v1.json'),path.join(directory,'model-library.pre-generation-v2.json'),2).catch(e=>{if(e.code!=='EEXIST')throw e;});
  await atomicJson(file,next);
  return librarySchema.parse(JSON.parse(await readFile(file,'utf8')));
}

export async function openModelLibrary(directory:string){
  const file=path.join(directory,modelLibraryFilename);
  try{const data=librarySchema.parse(JSON.parse(await readFile(file,'utf8')));if(data.schema_version!==3)throw new Error('模型库版本不匹配。');return data;}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('模型库文件无效；不会重置配置，请保留文件检查。');}
  const old=await openV2Library(directory);
  await copyFile(path.join(directory,'model-library.v2.json'),path.join(directory,'model-library.pre-settings-v3.json'),2).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const next=migrateModelSettings(old);await atomicJson(file,next);return next;
}
