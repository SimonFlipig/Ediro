export interface StreamingTextScheduler {
  now():number;
  request(callback:(now:number)=>void):number;
  cancel(id:number):void;
}

const defaultScheduler:StreamingTextScheduler={
  now:()=>performance.now(),
  request:callback=>requestAnimationFrame(callback),
  cancel:id=>cancelAnimationFrame(id),
};

// The network may deliver paragraphs at once. This buffer changes presentation
// only; the caller remains responsible for accepting and saving the final text.
export class StreamingTextReveal {
  private readonly segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
  private target='';
  private graphemes:string[]=[];
  private visible=0;
  private displayed='';
  private frame:number|undefined;
  private lastFrame:number|undefined;
  private credit=0;
  private state:'streaming'|'finishing'|'finished'|'cancelled'='streaming';
  private finishing:Promise<void>|undefined;
  private resolveFinish:(()=>void)|undefined;
  private finishStart=0;
  private finishDuration=0;
  private finishVisible=0;

  constructor(private readonly onText:(text:string)=>void,private readonly scheduler:StreamingTextScheduler=defaultScheduler){}

  update(cumulative:string):void{
    if(this.state!=='streaming')return;
    this.setTarget(cumulative.trimStart());
    this.schedule();
  }

  finish(finalText:string):Promise<void>{
    if(this.finishing)return this.finishing;
    if(this.state==='cancelled'||this.state==='finished')return Promise.resolve();
    this.setTarget(finalText.trim());
    this.state='finishing';
    this.finishing=new Promise<void>(resolve=>{this.resolveFinish=resolve;});
    this.finishStart=this.scheduler.now();
    this.finishVisible=this.visible;
    const remaining=this.graphemes.length-this.visible;
    this.finishDuration=Math.min(1400,Math.max(120,remaining/80*1000));
    if(this.displayed===this.target)this.complete();
    else this.schedule();
    return this.finishing;
  }

  skip():void{
    if(this.state==='cancelled'||this.state==='finished')return;
    this.state='finished';
    this.stopFrame();
    try{this.publish(this.graphemes.length);}finally{this.resolveFinish?.();}
  }

  cancel():void{
    if(this.state==='cancelled'||this.state==='finished')return;
    this.state='cancelled';
    this.stopFrame();
    this.resolveFinish?.();
  }

  private setTarget(text:string):void{
    // Hold trailing whitespace until another visible character arrives. The
    // final trim can then never retract whitespace that was already displayed.
    const target=text.trimEnd();
    if(target===this.target)return;
    this.target=target;
    this.graphemes=Array.from(this.segmenter.segment(target),part=>part.segment);
    this.visible=Math.min(this.visible,this.graphemes.length);
  }

  private schedule():void{
    if(this.frame!==undefined||this.state==='cancelled'||this.state==='finished')return;
    if(this.displayed===this.target){this.lastFrame=undefined;this.credit=0;return;}
    this.lastFrame??=this.scheduler.now();
    this.frame=this.scheduler.request(now=>this.tick(now));
  }

  private tick(now:number):void{
    this.frame=undefined;
    if(this.state==='cancelled'||this.state==='finished')return;
    if(this.state==='finishing'){
      const fraction=Math.min(1,Math.max(0,(now-this.finishStart)/this.finishDuration));
      const count=this.finishVisible+Math.floor((this.graphemes.length-this.finishVisible)*fraction);
      this.publish(count);
      if(this.state!=='finishing')return;
      if(fraction===1||this.displayed===this.target){this.complete();return;}
    }else{
      const elapsed=Math.max(0,now-(this.lastFrame??now));
      const remaining=this.graphemes.length-this.visible;
      // A growing backlog increases speed. Elapsed time is deliberately not
      // capped, so resuming a background window does not replay a long backlog.
      this.credit+=elapsed/1000*(55+remaining/0.65);
      const count=Math.min(remaining,Math.floor(this.credit));
      this.credit-=count;
      this.publish(this.visible+count);
      if(this.stopped())return;
    }
    this.lastFrame=now;
    this.schedule();
  }

  private publish(count:number):void{
    this.visible=count;
    const text=this.graphemes.slice(0,count).join('');
    if(text===this.displayed)return;
    this.displayed=text;
    this.onText(text);
  }

  private stopped():boolean{return this.state==='cancelled'||this.state==='finished';}

  private stopFrame():void{
    if(this.frame!==undefined)this.scheduler.cancel(this.frame);
    this.frame=undefined;this.lastFrame=undefined;this.credit=0;
  }

  private complete():void{
    if(this.state==='cancelled')return;
    this.state='finished';
    this.stopFrame();
    this.resolveFinish?.();
  }
}
