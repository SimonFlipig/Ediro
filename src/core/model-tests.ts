import { z } from 'zod';
import { idSchema,newId,type ModelConfig,type Job } from './domain.js';
import type { CloudExecutionPort } from './ports.js';
import { ModuleRegistry } from './modules.js';
import { planExecution } from './execution-plan.js';
import { compileRecipe } from './compiler.js';

export const modelTestSchema=z.object({test_id:idSchema,model_config_id:idSchema,model_revision:z.number().int(),connection_revision:z.number().int(),adapter_version:z.number().int(),model:z.string(),adapter_id:z.string(),status:z.enum(['running','succeeded','failed']),created_at:z.string(),finished_at:z.string().optional(),duration_ms:z.number().optional(),response:z.string().max(64000).optional(),error:z.string().optional(),usage:z.record(z.string(),z.number()).optional(),fee:z.literal('unknown'),operation:z.literal('understand')});
export type ModelTestRecord=z.infer<typeof modelTestSchema>;
export class ModelTests {
  private active?:AbortController;
  constructor(private records:ModelTestRecord[],private persist:(records:ModelTestRecord[])=>Promise<void>,private executor:CloudExecutionPort,private credential:(model:ModelConfig)=>Promise<string>){}
  list(){return structuredClone(this.records);}
  async recover(){let changed=false;for(const r of this.records)if(r.status==='running'){r.status='failed';r.error='上次测试已中断，没有自动重试；上游计费状态未知。';r.finished_at=new Date().toISOString();changed=true;}if(changed)await this.persist(this.list());}
  shutdown(){this.active?.abort();}
  async run(model:ModelConfig){
    if(this.active)throw new Error('已有模型测试正在运行，请等待结束。');
    if(model.purpose!=='understanding'||!model.executable)throw new Error('此入口只测试已配置的理解／推理模型。');
    if(this.records.length>=200)throw new Error('测试记录已达当前 200 项上限。');
    const signal=new AbortController();this.active=signal;
    const record:ModelTestRecord={test_id:newId('test'),model_config_id:model.model_config_id,model_revision:model.revision,connection_revision:model.connection_revision??0,adapter_version:model.adapter_version??1,model:model.model,adapter_id:model.adapter_id,status:'running',created_at:new Date().toISOString(),fee:'unknown',operation:'understand'};
    const previous=this.list(),start=Date.now();this.records.push(record);
    try{
      try{await this.persist(this.list());}catch(error){this.records=previous;throw error;}
      const registry=new ModuleRegistry(),module=registry.create('prompt');module.user_instruction='连接测试：请计算 17 × 23，只返回最终整数，不解释。';
      const recipe={recipe_id:newId('recipe'),schema_version:1 as const,modules:[module],model_config_id:model.model_config_id,core_parameters:{...model.defaults}},chain=compileRecipe(recipe,registry);
      const plan=planExecution(recipe,[],model,registry,chain);
      const job:Job={task_id:record.test_id,status:'running',stage:'推理链路测试',progress:0,created_at:record.created_at,recipe_snapshot:plan.recipe,execution_plan:plan.summary,chain_snapshot:chain,model_snapshot:{model_config_id:model.model_config_id,title:model.title,provider:model.provider,model:model.model,adapter_id:model.adapter_id,revision:model.revision,kind:model.kind},adapted_input:plan.adapted,output_asset_ids:[]};
      try{
        const result=await this.executor.execute({model:structuredClone(model),job,readImage:async()=>{throw new Error('本次测试不发送参考图。');},resolveCredential:()=>this.credential(model)},signal.signal,async()=>{});
        if(signal.signal.aborted)throw new Error('测试已取消，上游计费状态未知。');
        const text=result.text?.trim();if(text!=='391')throw new Error('模型未返回预期的 391，推理链路未通过本次测试。');
        record.status='succeeded';record.response=text;if(result.usage)record.usage=result.usage;
      }catch(error){record.status='failed';record.error=error instanceof Error?error.message:'模型测试失败。';}
      record.duration_ms=Date.now()-start;record.finished_at=new Date().toISOString();
      try{await this.persist(this.list());}catch(error){record.status='failed';record.error='测试结果未成功保存，不能采用；请检查本地存储。';throw error;}
      return structuredClone(record);
    }finally{this.active=undefined;}
  }
  successful(id:string){const record=this.records.find(r=>r.test_id===id);if(!record||record.status!=='succeeded')throw new Error('没有可采用的成功测试记录。');return structuredClone(record);}
}
