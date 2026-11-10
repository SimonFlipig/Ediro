import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingTextReveal,type StreamingTextScheduler } from '../src/ui/streaming-text.js';

class FrameClock implements StreamingTextScheduler {
  time=0;
  nextId=1;
  frames=new Map<number,(now:number)=>void>();
  now=()=>this.time;
  request=(callback:(now:number)=>void)=>{const id=this.nextId++;this.frames.set(id,callback);return id;};
  cancel=(id:number)=>{this.frames.delete(id);};
  tick(ms=16){this.time+=ms;const callbacks=[...this.frames.values()];this.frames.clear();for(const callback of callbacks)callback(this.time);}
  advance(ms:number){const end=this.time+ms;while(this.time<end)this.tick(Math.min(16,end-this.time));}
}

test('大块网络正文逐帧追赶，首次更新不会同步整段显示',()=>{
  const clock=new FrameClock(),shown:string[]=[],reveal=new StreamingTextReveal(text=>shown.push(text),clock),target='流式内容'.repeat(300);
  reveal.update(target);assert.deepEqual(shown,[]);
  clock.tick();assert.ok(shown[0].length>0&&shown[0].length<target.length/10);
  clock.advance(160);assert.ok(shown.length>5);assert.ok(shown.at(-1)!.length<target.length);
  for(let index=0;index<shown.length;index++){assert.ok(target.startsWith(shown[index]));if(index)assert.ok(shown[index].length>shown[index-1].length);}
});

test('完成时保留动画并在 1400ms 内显示剩余尾段',async()=>{
  const clock=new FrameClock(),shown:string[]=[],reveal=new StreamingTextReveal(text=>shown.push(text),clock),target='长'.repeat(32000);
  reveal.update(target);clock.advance(64);const before=shown.at(-1)!;
  let finished=false;const pending=reveal.finish(target).then(()=>{finished=true;});
  assert.equal(shown.at(-1),before);await Promise.resolve();assert.equal(finished,false);
  clock.advance(500);assert.ok(shown.at(-1)!.length>before.length);assert.ok(shown.at(-1)!.length<target.length);
  clock.advance(900);await pending;
  assert.equal(shown.at(-1),target);assert.equal(finished,true);assert.equal(clock.frames.size,0);
  reveal.update(target+'迟到');clock.advance(100);assert.equal(shown.at(-1),target);
});

test('没有增量的最终结果也必须分帧显示，且 trim 不使前缀回跳',async()=>{
  const clock=new FrameClock(),shown:string[]=[],reveal=new StreamingTextReveal(text=>shown.push(text),clock),target='完整建议。'.repeat(60);
  const pending=reveal.finish(' \n'+target+' \n');assert.deepEqual(shown,[]);
  clock.tick();assert.ok(shown[0].length>0&&shown[0].length<target.length);
  clock.advance(1400);await pending;assert.equal(shown.at(-1),target);
  const later=new StreamingTextReveal(text=>shown.push(text),clock);later.update('  开头  ');clock.advance(300);
  assert.equal(shown.at(-1),'开头');later.update('  开头 后续  ');clock.advance(300);
  const previous=shown.at(-1)!;const done=later.finish('  开头 后续  ');assert.ok('开头 后续'.startsWith(previous));clock.advance(1400);await done;
  assert.equal(shown.at(-1),'开头 后续');
});

test('持续累计更新不会重置时钟或显示位置，结束后不再接纳增量',async()=>{
  const clock=new FrameClock(),shown:string[]=[],reveal=new StreamingTextReveal(text=>shown.push(text),clock);
  let target='文'.repeat(150);
  reveal.update(target);
  for(let index=0;index<20;index++){clock.tick();const previous=shown.at(-1)??'';target+='字'.repeat(4);reveal.update(target);assert.equal(shown.at(-1)??'',previous);}
  assert.ok(shown.length>10);assert.ok(shown.at(-1)!.length>30);
  const done=reveal.finish(target);reveal.update('不应替换');clock.advance(1400);await done;assert.equal(shown.at(-1),target);
  const count=shown.length;reveal.update('迟到');await reveal.finish('再次结束');reveal.skip();clock.advance(100);assert.equal(shown.length,count);
});

test('中文、emoji、肤色、ZWJ、旗帜和组合字符始终按完整字素显示',async()=>{
  const clock=new FrameClock(),shown:string[]=[],reveal=new StreamingTextReveal(text=>shown.push(text),clock),target='中👩🏽‍💻e\u0301🇨🇳文👨‍👩‍👧‍👦'.repeat(20);
  const valid=new Set(['']);let prefix='';for(const part of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(target)){prefix+=part.segment;valid.add(prefix);}
  reveal.update(target);clock.advance(300);const done=reveal.finish(target);clock.advance(1400);await done;
  assert.ok(shown.length>5);for(const text of shown)assert.ok(valid.has(text));assert.equal(shown.at(-1),target);
});

test('最终追加组合字符或返回更短正文也能结束，不会留下挂起的 finish',async()=>{
  const clock=new FrameClock(),shown:string[]=[],reveal=new StreamingTextReveal(text=>shown.push(text),clock);
  reveal.update('e');clock.advance(100);assert.equal(shown.at(-1),'e');
  const first=reveal.finish('e\u0301');clock.advance(1400);await first;assert.equal(shown.at(-1),'e\u0301');assert.equal(clock.frames.size,0);
  const replacement=new StreamingTextReveal(text=>shown.push(text),clock);replacement.update('旧'.repeat(10));clock.advance(1000);
  const second=replacement.finish('新');clock.advance(1400);await second;assert.equal(shown.at(-1),'新');assert.equal(clock.frames.size,0);
});

test('取消停止帧并释放完成等待；迟到帧、update、finish 和 skip 均不能复活',async()=>{
  const clock=new FrameClock(),shown:string[]=[],reveal=new StreamingTextReveal(text=>shown.push(text),clock);
  reveal.update('文'.repeat(1000));clock.tick();const pending=reveal.finish('文'.repeat(1000)),stale=[...clock.frames.values()];
  const count=shown.length;reveal.cancel();assert.equal(clock.frames.size,0);await pending;
  reveal.update('迟到');await reveal.finish('迟到最终结果');reveal.skip();for(const callback of stale)callback(clock.time+5000);clock.advance(5000);
  assert.equal(shown.length,count);assert.equal(clock.frames.size,0);
});

test('skip 立即显示全文、释放等待并忽略后续帧',async()=>{
  const clock=new FrameClock(),shown:string[]=[],reveal=new StreamingTextReveal(text=>shown.push(text),clock),target='可以跳过'.repeat(100);
  const pending=reveal.finish(target);clock.tick();reveal.skip();await pending;
  assert.equal(shown.at(-1),target);assert.equal(clock.frames.size,0);const count=shown.length;clock.advance(5000);reveal.update('迟到');assert.equal(shown.length,count);
});

test('后台长暂停恢复后及时追上；空闲后新正文仍从少量字符开始',async()=>{
  const clock=new FrameClock(),shown:string[]=[],reveal=new StreamingTextReveal(text=>shown.push(text),clock);
  reveal.update('甲'.repeat(500));clock.tick(5000);assert.equal(shown.at(-1),'甲'.repeat(500));assert.equal(clock.frames.size,0);
  clock.tick(50000);reveal.update('甲'.repeat(500)+'乙'.repeat(500));clock.tick();assert.ok(shown.at(-1)!.length<600);
  const done=reveal.finish('甲'.repeat(500)+'乙'.repeat(500));clock.tick(5000);await done;assert.equal(shown.at(-1)!.length,1000);assert.equal(clock.frames.size,0);
});
