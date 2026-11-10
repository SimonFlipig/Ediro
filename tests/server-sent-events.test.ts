import test from 'node:test';
import assert from 'node:assert/strict';
import { readServerSentEvents } from '../src/adapters/server-sent-events.js';

const encoder=new TextEncoder();
const signal=()=>new AbortController().signal;
function response(chunks:Uint8Array[],onCancel=()=>{}){
  return new Response(new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();},cancel:onCancel}),{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
}
async function collect(source:Response,maximum=1024){const events:string[]=[];for await(const event of readServerSentEvents(source,signal(),maximum))events.push(event);return events;}

test('SSE reads arbitrarily split UTF-8, CRLF, CR and LF frames, comments and multiline data',async()=>{
  const bytes=encoder.encode('\uFEFF: heartbeat\r\nevent: message\r\nid: unused\r\ndata: 你好🟢\r\ndata: second\r\n\r\ndata: third\r\rdata:\n\n');
  const chunks=Array.from(bytes,byte=>new Uint8Array([byte]));
  assert.deepEqual(await collect(response(chunks)),['你好🟢\nsecond','third','']);
});

test('SSE yields a completed frame while the transport remains open and cancels when consumer exits',async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>,cancelled=false;
  const source=new Response(new ReadableStream<Uint8Array>({start(value){controller=value;},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});
  const events=readServerSentEvents(source,signal(),1024),first=events.next();
  controller.enqueue(encoder.encode('data: early\n\n'));
  assert.deepEqual(await first,{done:false,value:'early'});
  await events.return(undefined);assert.equal(cancelled,true);assert.equal(source.body!.locked,false);
});

test('SSE rejects an incomplete final frame, invalid UTF-8, wrong content type and byte overflow',async()=>{
  for(const text of ['data: partial','data: partial\n','data: complete\n\ndata: partial\n'])await assert.rejects(collect(response([encoder.encode(text)])),/完整事件/);
  await assert.rejects(collect(response([new Uint8Array([0xff,10,10])])));
  await assert.rejects(collect(new Response('data: not SSE\n\n')),/不是事件流/);
  await assert.rejects(collect(response([encoder.encode('data: 你好\n\n')]),10),/读取限制/);
});

test('SSE cancellation interrupts a pending read, cleans up its reader and does not yield later data',async()=>{
  const abort=new AbortController();let cancelled=false;
  const source=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});
  const events=readServerSentEvents(source,abort.signal,1024),pending=events.next();abort.abort();
  await assert.rejects(pending);assert.equal(cancelled,true);assert.equal(source.body!.locked,false);
});

test('SSE cancellation between yielded frames stops already buffered events',async()=>{
  const abort=new AbortController(),events=readServerSentEvents(response([encoder.encode('data: first\n\ndata: second\n\n')]),abort.signal,1024);
  assert.deepEqual(await events.next(),{done:false,value:'first'});abort.abort();await assert.rejects(events.next());
});
