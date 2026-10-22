import type {ReactNode} from 'react';
import type {Job} from '../core/domain.js';
import type {ViewAsset} from '../shared/api.js';
import {GenerationMosaic} from './GenerationMosaic.js';
import {isActiveJob,taskReferenceAsset} from './result-timeline.js';

export const generationTaskLabels:Record<Job['status'],string>={queued:'排队中',preparing:'准备中',running:'生成中',post_processing:'保存中',succeeded:'已完成',failed:'生成失败',cancelled:'已取消'};

export function GenerationTaskThumbnail({job,assets,selected,onSelect}:{job:Job;assets:ViewAsset[];selected:boolean;onSelect:()=>void}){
  const label=generationTaskLabels[job.status],source=taskReferenceAsset(job,assets);
  return <button type="button" className={`result-thumb result-task-thumb ${selected?'selected':''}`} data-task-id={job.task_id} data-status={job.status} aria-pressed={selected} aria-label={`${label} · ${job.task_id.slice(-6)} · 恢复此任务的参数和模块`} title={`${label} · ${new Date(job.created_at).toLocaleString('zh-CN')} · ${job.model_snapshot.title}\n点击恢复此任务的参数和模块`} onClick={onSelect}>
    <GenerationMosaic sourceUrl={source?.preview_url} seed={job.task_id} active={isActiveJob(job)}/>
    {job.status==='failed'&&<i className="generation-task-mark" aria-hidden="true">!</i>}
    <span className="generation-task-label">{label}</span>
  </button>;
}

export function GenerationTaskPreview({job,assets,actions}:{job:Job;assets:ViewAsset[];actions?:ReactNode}){
  const source=taskReferenceAsset(job,assets),active=isActiveJob(job);
  return <div className={`generation-task-preview status-${job.status}`} data-task-id={job.task_id}>
    <div className="generation-task-visual">
      <GenerationMosaic sourceUrl={source?.preview_url} seed={job.task_id} active={active}/>
      {actions&&<div className="generation-task-action-anchor">{actions}</div>}
    </div>
    <h2>{generationTaskLabels[job.status]}</h2>
    <p>{active?job.stage:'此任务的参数和输入模块已恢复，可继续调整。'}</p>
    {job.error&&<p className="generation-task-error">{job.error}</p>}
    <small>{job.model_snapshot.title} · {new Date(job.created_at).toLocaleString('zh-CN')}</small>
  </div>;
}
