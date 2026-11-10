// Transport framing only; adapters validate their own event payloads and completion markers.
export async function* readServerSentEvents(response:Response,signal:AbortSignal,maximumBytes:number):AsyncGenerator<string>{
  const reader=response.body?.getReader();
  if(!reader)throw new Error('事件流响应为空。');
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let buffer='',size=0,frameOpen=false;
  let data:string[]=[];
  let rejectAbort:(reason:unknown)=>void=()=>{};
  const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
  // A consumer may be processing a yielded event when cancellation arrives.
  void aborted.catch(()=>{});
  const onAbort=()=>{rejectAbort(new DOMException('事件流已取消。','AbortError'));void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',onAbort,{once:true});
  try{
    if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='text/event-stream')throw new Error('响应不是事件流。');
    if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1)throw new Error('事件流读取限制无效。');
    if(signal.aborted)onAbort();
    while(true){
      signal.throwIfAborted();
      const {done,value}=await Promise.race([reader.read(),aborted]);
      signal.throwIfAborted();
      if(value){size+=value.byteLength;if(size>maximumBytes)throw new Error('事件流超过读取限制。');}
      buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
      while(true){
        const end=buffer.search(/[\r\n]/);
        if(end<0||!done&&buffer[end]==='\r'&&end===buffer.length-1)break;
        const line=buffer.slice(0,end),separator=buffer[end]==='\r'&&buffer[end+1]==='\n'?2:1;
        buffer=buffer.slice(end+separator);
        if(!line){
          const event=data.length?data.join('\n'):undefined;
          data=[];frameOpen=false;
          if(event!==undefined){signal.throwIfAborted();yield event;}
          continue;
        }
        frameOpen=true;
        if(line.startsWith(':'))continue;
        const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon);
        let value=colon<0?'':line.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);
        if(field==='data')data.push(value);
      }
      if(done){
        if(buffer||frameOpen)throw new Error('事件流在完整事件结束前断开。');
        return;
      }
    }
  }finally{
    signal.removeEventListener('abort',onAbort);
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
