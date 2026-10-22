import {parentPort,workerData} from 'node:worker_threads';

async function run(){
  const {kind,paths}=workerData,bytes=Buffer.from(workerData.bytes);
  const flag=new Int32Array(workerData.cancellation),isCancelled=()=>Atomics.load(flag,0)!==0;
  if(isCancelled())throw new Error('图像预处理已取消。');
  if(kind==='depth')return (await import('./depth-preprocessor.js')).depthImage(bytes,paths.model,isCancelled);
  if(kind==='segment')return (await import('./segmentation-preprocessor.js')).segmentImage(bytes,{encoder:paths.encoder,decoder:paths.decoder},isCancelled);
  throw new Error('不支持的参考图预处理方式。');
}
run().then(bytes=>{parentPort?.postMessage({bytes});parentPort?.close();},error=>{parentPort?.postMessage({error:error instanceof Error?error.message:'本地图像处理失败，请重试。'});parentPort?.close();});
