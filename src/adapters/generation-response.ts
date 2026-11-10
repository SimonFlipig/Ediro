import type { ExecutionDiagnostics } from '../core/execution-diagnostics.js';

export const GENERATION_TIMEOUT_MS=600_000;
export const UNDERSTANDING_TIMEOUT_MS=180_000;

export function recordRequestId(diagnostics:ExecutionDiagnostics|undefined,value:unknown){
  if(diagnostics&&typeof value==='string'&&/^[A-Za-z0-9_.:/=-]{1,200}$/.test(value))diagnostics.upstream_request_id=value;
}

export function recordResponse(diagnostics:ExecutionDiagnostics|undefined,response:Response){
  if(!diagnostics)return;
  diagnostics.http_status=response.status;
  diagnostics.stage='response_body';
  diagnostics.received_bytes=0;
  for(const name of ['x-request-id','request-id','x-goog-request-id']){
    recordRequestId(diagnostics,response.headers.get(name));
    if(diagnostics.upstream_request_id)break;
  }
}

export function recordExecutionError(diagnostics:ExecutionDiagnostics|undefined,error:unknown,signal:AbortSignal){
  if(!diagnostics)return;
  const cause=error instanceof Error?error:undefined;
  // Messages can contain response fragments, credentials or prompt text. Keep
  // only bounded error identifiers and our own classification.
  diagnostics.error_name=signal.aborted&&signal.reason?.name==='TimeoutError'?'TimeoutError':cause&&['Error','TypeError','SyntaxError','AbortError','TimeoutError'].includes(cause.name)?cause.name:'Error';
  const code=(cause?.cause as {code?:unknown}|undefined)?.code??(cause as {code?:unknown}|undefined)?.code;
  if(typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code))diagnostics.error_code=code;
  if(signal.aborted)diagnostics.reason=signal.reason?.name==='TimeoutError'?'timeout':'cancelled';
  else diagnostics.reason??=diagnostics.stage==='response_parse'?'invalid_json':diagnostics.stage==='response_body'?'response_read_error':diagnostics.stage==='request'?'network_error':diagnostics.stage==='image_decode'?'image_decode_error':diagnostics.stage==='response_validation'?'validation_error':'execution_error';
}

export function requestAbortMessage(service:string,signal:AbortSignal,timeoutMs?:number){
  return signal.reason?.name==='TimeoutError'
    ?`${timeoutMs===undefined?`${service} 请求超时`:`等待 ${service} 服务超过 ${timeoutMs/60_000} 分钟`}，客户端已停止等待；上游可能仍在处理，计费状态未知，未自动重试。`
    :'请求已取消，上游计费状态未知；未自动重试。';
}

export async function readGenerationJson(response:Response,signal:AbortSignal,diagnostics?:ExecutionDiagnostics){
  const reader=response.body?.getReader();
  if(!reader){if(diagnostics)diagnostics.reason='empty_response';throw new Error('上游返回空响应。');}
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.length;if(diagnostics)diagnostics.received_bytes=size;
      if(size>60*1024*1024){if(diagnostics)diagnostics.reason='response_too_large';throw new Error('上游响应超过当前传输限制。');}
      chunks.push(value);
    }
    if(signal.aborted)throw signal.reason;
    if(diagnostics)diagnostics.stage='response_parse';
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }finally{await reader.cancel().catch(()=>{});}
}
