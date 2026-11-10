import type { AdapterDescription } from '../core/model-library.js';
import type { CloudExecutionPort, CloudExecutionContext } from '../core/ports.js';
import type { ReferenceSettings } from '../core/module-settings.js';
import { MAX_SYSTEM_INSTRUCTION_CHARS,systemInstructionSchema } from '../core/domain.js';
import type { ExecutionDiagnostics } from '../core/execution-diagnostics.js';
import type { GenerationFailureRecord } from './generation-failure-log.js';
import { recordExecutionError } from './generation-response.js';

export interface ExecutionAdapter extends CloudExecutionPort { description: AdapterDescription; probe?(endpoint:string,key:string,signal:AbortSignal):Promise<string[]> }
export class ExecutionRegistry implements CloudExecutionPort {
  constructor(private readonly preprocess?:(bytes:Buffer,settings:ReferenceSettings,signal:AbortSignal)=>Promise<Buffer>,private readonly recordFailure?:(record:GenerationFailureRecord)=>Promise<void>){}
  private adapters=new Map<string,ExecutionAdapter>();
  register(adapter:ExecutionAdapter) { if(this.adapters.has(adapter.description.adapter_id))throw new Error('执行适配器 ID 重复。');this.adapters.set(adapter.description.adapter_id,adapter);return this; }
  descriptions(){return [...this.adapters.values()].map(a=>structuredClone(a.description));}
  execute(context:CloudExecutionContext,signal:AbortSignal,progress:(stage:string,value:number)=>Promise<void>){
    const a=this.adapters.get(context.model.adapter_id);if(!a||a.description.kind!==context.model.kind)throw new Error('所选模型执行适配器未安装或种类不匹配。');
    const instruction=context.job.adapted_input.system_instruction;
    if(instruction!==undefined){
      const parsed=systemInstructionSchema.safeParse(instruction);
      if(!parsed.success)throw new Error(`推理系统指令须为不超过 ${MAX_SYSTEM_INSTRUCTION_CHARS} 字符的纯文字。`);
      if(parsed.data.trim()){
        if(context.model.purpose!=='understanding')throw new Error('系统指令仅用于推理任务，不能发送到生图链路。');
        if(!a.description.supports_system_instruction)throw new Error('此推理适配器未声明系统指令支持；未发送请求，也不会合并回用户内容。');
      }
    }
    const prepared=this.preprocess?{...context,preprocessReferenceImage:(bytes:Buffer,settings:ReferenceSettings)=>this.preprocess!(bytes,settings,signal)}:context;
    if(!this.recordFailure||context.model.kind!=='cloud'||context.model.purpose==='understanding')return a.execute(prepared,signal,progress);
    // One fresh trace per attempt, separate from the project and request capture.
    const diagnostics:ExecutionDiagnostics={stage:'preparing'},started=performance.now();
    return this.executeWithDiagnostics(a,{...prepared,diagnostics},signal,progress,started);
  }
  private async executeWithDiagnostics(adapter:ExecutionAdapter,context:CloudExecutionContext,signal:AbortSignal,progress:(stage:string,value:number)=>Promise<void>,started:number){
    try{return await adapter.execute(context,signal,progress);}
    catch(error){
      const diagnostics=context.diagnostics!;
      if(!diagnostics.reason)recordExecutionError(diagnostics,error,signal);
      // Explicit user cancellation is not a failed generation. A deadline can
      // abort the request too, but must remain in the failure log.
      if(diagnostics.reason!=='cancelled'){
        try{await this.recordFailure!({timestamp:new Date().toISOString(),task_id:context.job.task_id,model:context.model.model,adapter_id:context.model.adapter_id,duration_ms:Math.round(performance.now()-started),...diagnostics,reason:diagnostics.reason??'execution_error'});}
        catch{console.warn('本地生成失败日志无法写入；原始任务错误已保留。');}
      }
      throw error;
    }
  }
  async probe(adapterId:string,endpoint:string,key:string,signal:AbortSignal){const a=this.adapters.get(adapterId);if(!a?.probe)throw new Error('此适配器不支持模型列表获取，请手动添加。');return a.probe(endpoint,key,signal);}
}
