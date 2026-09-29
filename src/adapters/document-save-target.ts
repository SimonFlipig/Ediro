import {lstat,stat} from 'node:fs/promises';
import path from 'node:path';

export interface DocumentSaveTarget {filename:string;stamp:string}

// Capture the exact file approved for replacement, then check it again after
// staging. A newly created/changed target requires a new user decision.
export async function inspectDocumentTarget(filename:string):Promise<DocumentSaveTarget|undefined>{
  const target=path.resolve(filename);
  try{
    const info=await lstat(target,{bigint:true});
    if(!info.isFile()||info.isSymbolicLink())throw new Error('保存目标不是普通文件，请选择其他位置。');
    return {filename:target,stamp:`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`};
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}

export async function sameDocumentFile(a:string,b:string){
  const normalize=(file:string)=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
  if(normalize(a)===normalize(b))return true;
  try{const [left,right]=await Promise.all([stat(a,{bigint:true}),stat(b,{bigint:true})]);return left.dev===right.dev&&left.ino===right.ino;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
