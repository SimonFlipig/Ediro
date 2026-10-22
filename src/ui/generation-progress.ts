import type {Job} from '../core/domain.js';
import type {GenerationTiming} from '../core/generation-timing.js';

export interface GenerationProgressState {
  active:boolean;
  elapsedMs?:number;
  estimatedMs?:number;
  percent?:number;
  indeterminate:boolean;
  sampleCount:number;
}

const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;

// Estimates describe the wait, not completion reported by a model. Leave room
// for saving and never claim completion before the task actually succeeds.
export function generationProgress(job:Pick<Job,'status'|'progress'|'finished_at'>,nowMs:number,timing?:GenerationTiming):GenerationProgressState {
  const active=['preparing','running','post_processing'].includes(job.status);
  const startedAt=Date.parse(timing?.started_at??'');
  const finishedAt=Date.parse(job.finished_at??'');
  const sampleCount=timing&&Number.isInteger(timing.sample_count)&&timing.sample_count>0?timing.sample_count:0;
  const estimatedMs=sampleCount&&positive(timing?.estimated_duration_ms)?timing.estimated_duration_ms:undefined;
  let elapsedMs:number|undefined;
  if(job.status!=='queued'&&Number.isFinite(startedAt)){
    const end=active?nowMs:finishedAt;
    if(!active&&typeof timing?.duration_ms==='number'&&Number.isFinite(timing.duration_ms)&&timing.duration_ms>=0)elapsedMs=timing.duration_ms;
    else if(Number.isFinite(end))elapsedMs=Math.max(0,end-startedAt);
  }
  let percent:number|undefined;
  if(job.status==='succeeded')percent=100;
  else if(job.status==='queued')percent=0;
  else if(estimatedMs!==undefined&&elapsedMs!==undefined){
    const ratio=elapsedMs/estimatedMs;
    percent=ratio<=1?90*ratio:90+8*(1-Math.exp(-(ratio-1)/2));
    if(job.status==='post_processing')percent=Math.max(98,percent);
  }else if(!active)percent=Math.max(0,Math.min(99,Number.isFinite(job.progress)?job.progress:0));
  return {active,elapsedMs,estimatedMs,percent,indeterminate:active&&percent===undefined,sampleCount};
}

export function formatGenerationDuration(milliseconds:number,roundUp=false):string {
  const safe=Number.isFinite(milliseconds)?Math.max(0,milliseconds):0;
  const seconds=(roundUp?Math.ceil:Math.floor)(safe/1000);
  return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分${seconds%60?` ${seconds%60} 秒`:''}`;
}
