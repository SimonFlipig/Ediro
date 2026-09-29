import type { AdapterDescription } from '../core/model-library.js';
import type { CloudExecutionPort, CloudExecutionContext } from '../core/ports.js';

export interface ExecutionAdapter extends CloudExecutionPort { description: AdapterDescription; probe?(endpoint:string,key:string,signal:AbortSignal):Promise<string[]> }
export class ExecutionRegistry implements CloudExecutionPort {
  private adapters=new Map<string,ExecutionAdapter>();
  register(adapter:ExecutionAdapter) { if(this.adapters.has(adapter.description.adapter_id))throw new Error('执行适配器 ID 重复。');this.adapters.set(adapter.description.adapter_id,adapter);return this; }
  descriptions(){return [...this.adapters.values()].map(a=>structuredClone(a.description));}
  execute(context:CloudExecutionContext,signal:AbortSignal,progress:(stage:string,value:number)=>Promise<void>){
    const a=this.adapters.get(context.model.adapter_id);if(!a||a.description.kind!==context.model.kind)throw new Error('所选模型执行适配器未安装或种类不匹配。');
    return a.execute(context,signal,progress);
  }
  async probe(adapterId:string,endpoint:string,key:string,signal:AbortSignal){const a=this.adapters.get(adapterId);if(!a?.probe)throw new Error('此适配器不支持模型列表获取，请手动添加。');return a.probe(endpoint,key,signal);}
}
