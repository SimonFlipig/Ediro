import type { CloudExecutionContext } from '../core/ports.js';
import type { ModelInput } from '../core/model-input.js';

// Called with the very body passed to fetch. Never accepts headers or credentials.
export async function captureModelInput(context:CloudExecutionContext,route:string,body:string|FormData){
  if(!context.recordModelInput)return;
  let captured:ModelInput['body'];
  if(typeof body==='string')captured={encoding:'json',json:body};
  else{
    const fields:Extract<ModelInput['body'],{encoding:'multipart'}>['fields']=[];
    const entries:[string,FormDataEntryValue][]=[];body.forEach((value,name)=>entries.push([name,value]));
    for(const [name,value] of entries){
      if(typeof value==='string')fields.push({name,value});
      else fields.push({name,value:{filename:value.name,mime_type:value.type as 'image/png'|'image/jpeg'|'image/webp',data_base64:Buffer.from(await value.arrayBuffer()).toString('base64')}});
    }
    captured={encoding:'multipart',fields};
  }
  await context.recordModelInput({version:1,adapter_id:context.model.adapter_id,captured_at:new Date().toISOString(),route,body:captured});
}
