import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {referenceSettingsSchema,type ReferenceSettings} from '../core/module-settings.js';
import {blurReferenceImage} from './blur-preprocessor.js';
import {resolveLocalImageModel,type LocalImageModelKind} from './local-image-models.js';

export type ReferenceModelRunner=(bytes:Buffer,kind:LocalImageModelKind,paths:Record<string,string>,signal?:AbortSignal)=>Promise<Buffer>;
function cancelled(){return new Error('图像预处理已取消。');}
function interruptible<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(cancelled());
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

// ONNX is loaded only in a worker. A finished worker releases its sessions and
// native memory; the bounded cache reuses the exact bytes for preview and send.
export class ReferencePreprocessor {
  private queue:Promise<unknown>=Promise.resolve();
  private cache=new Map<string,Buffer>();
  private cacheBytes=0;
  private workers=new Map<Worker,Int32Array>();
  private closed=false;
  constructor(private readonly runtimeDirectory:string,private readonly runner?:ReferenceModelRunner){}

  process(bytes:Buffer,input:ReferenceSettings,signal?:AbortSignal):Promise<Buffer>{
    const settings=referenceSettingsSchema.parse(input);
    if(signal?.aborted||this.closed)return Promise.reject(cancelled());
    if(settings.preprocess==='none')return Promise.resolve(bytes);
    const key=createHash('sha256').update(bytes).update(JSON.stringify(settings)).digest('hex');
    const run=async()=>{
      if(signal?.aborted||this.closed)throw cancelled();
      const cached=this.cache.get(key);
      if(cached){this.cache.delete(key);this.cache.set(key,cached);return cached;}
      let result:Buffer;
      if(settings.preprocess==='blur')result=await blurReferenceImage(bytes,settings.blur_strength);
      else if(settings.preprocess==='depth'||settings.preprocess==='segment'){
        const paths=await resolveLocalImageModel(this.runtimeDirectory,settings.preprocess);
        if(signal?.aborted||this.closed)throw cancelled();
        result=await (this.runner??this.runWorker.bind(this))(bytes,settings.preprocess,paths,signal);
      }else return bytes;
      if(signal?.aborted||this.closed)throw cancelled();
      if(result.length<=32*1024*1024){
        this.cache.set(key,result);this.cacheBytes+=result.length;
        while(this.cache.size>12||this.cacheBytes>32*1024*1024){const oldest=this.cache.keys().next().value!;this.cacheBytes-=this.cache.get(oldest)!.length;this.cache.delete(oldest);}
      }
      return result;
    };
    const operation=this.queue.then(run);
    this.queue=operation.catch(()=>{});
    return interruptible(operation,signal);
  }

  private runWorker(bytes:Buffer,kind:LocalImageModelKind,paths:Record<string,string>,signal?:AbortSignal):Promise<Buffer>{
    return new Promise((resolve,reject)=>{
      const cancellation=new SharedArrayBuffer(4),flag=new Int32Array(cancellation);
      const worker=new Worker(new URL('./reference-preprocess-worker.js',import.meta.url),{workerData:{bytes,kind,paths,cancellation}});
      this.workers.set(worker,flag);let error:Error|undefined,result:Buffer|undefined;
      // Never forcibly terminate a thread inside ONNX native code. The caller
      // stops waiting immediately; queue/close wait for cooperative cleanup.
      const abort=()=>{Atomics.store(flag,0,1);};
      const timeout=setTimeout(()=>{error=new Error('本地图像处理超时，请重试。');abort();},180_000);
      worker.once('error',value=>{error=value;});
      worker.once('message',(message:{bytes?:Uint8Array;error?:string})=>{
        if(message.error||!message.bytes)error??=new Error(message.error??'图像处理未返回图片。');
        else result=Buffer.from(message.bytes);
      });
      worker.once('exit',code=>{
        clearTimeout(timeout);signal?.removeEventListener('abort',abort);this.workers.delete(worker);
        if(Atomics.load(flag,0)!==0)error??=cancelled();
        if(code!==0||!result)error??=new Error('本地图像处理进程已退出，请重试。');
        if(error)reject(error);else resolve(result!);
      });
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
  }

  async close(){
    this.closed=true;this.cache.clear();this.cacheBytes=0;
    for(const flag of this.workers.values())Atomics.store(flag,0,1);
    await this.queue;
  }
}
