import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {newId} from '../core/domain.js';

export async function atomicJson(filename:string,data:unknown){
  await mkdir(path.dirname(filename),{recursive:true});
  const temporary=`${filename}.${newId('write')}.tmp`;
  await writeFile(temporary,JSON.stringify(data,null,2),{encoding:'utf8',flag:'wx'});
  await rename(temporary,filename);
}
