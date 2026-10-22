import {useEffect,useState} from 'react';
import type {Job} from '../core/domain.js';
import type {GenerationTiming} from '../core/generation-timing.js';
import {generationTaskLabels} from './GenerationTask.js';
import {formatGenerationDuration,generationProgress} from './generation-progress.js';

export function GenerationProgress({job,timing,onCancel}:{job:Job;timing?:GenerationTiming;onCancel:()=>void}){
  const [now,setNow]=useState(Date.now);
  const active=['preparing','running','post_processing'].includes(job.status);
  useEffect(()=>{
    const wallClock=Date.now(),monotonicClock=performance.now();
    setNow(wallClock);
    if(!active)return;
    // A system-clock adjustment during a request should not reverse its bar.
    const timer=setInterval(()=>setNow(wallClock+performance.now()-monotonicClock),250);
    return ()=>clearInterval(timer);
  },[job.task_id,timing?.started_at,active]);
  const state=generationProgress(job,now,timing);
  const estimated=state.estimatedMs!==undefined;
  const elapsed=state.elapsedMs===undefined?'—':formatGenerationDuration(state.elapsedMs).replaceAll(' ','');
  const estimate=estimated?formatGenerationDuration(state.estimatedMs!,true).replaceAll(' ',''):'—';
  const percentage=state.percent===undefined?undefined:Math.floor(state.percent);
  const canCancel=job.status==='queued'||active;
  const progressLabel=job.status==='succeeded'?'100%':job.status==='queued'?'等待执行':!active?'已停止':estimated&&percentage!==undefined?`预计进度 ${percentage}%`:'等待结果';
  return <div className="task-progress" data-task-id={job.task_id} data-status={job.status}>
    <progress aria-label="生成进度" aria-valuetext={`${generationTaskLabels[job.status]}，${progressLabel}，预计 ${estimate}，已用 ${elapsed}`} max={100} value={state.percent} className={state.indeterminate?'is-indeterminate':undefined}/>
    <div className="generation-timing-row">
      <p className="generation-timing"><span className="generation-percentage">{percentage===undefined?'—%':`${percentage}%`}</span>{' · '}预计 {estimate} ／ 已用 {elapsed}</p>
      {canCancel&&<button className="text-button" onClick={onCancel}>取消任务</button>}
    </div>
  </div>;
}
