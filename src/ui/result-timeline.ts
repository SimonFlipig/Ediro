import type {Job} from '../core/domain.js';
import type {ViewAsset} from '../shared/api.js';
import {visibleResult} from './asset-display.js';

export type ResultTimelineEntry =
  | {kind:'result';key:string;asset:ViewAsset;job?:Job}
  | {kind:'task';key:string;job:Job};

export function isActiveJob(job:Pick<Job,'status'>):boolean{
  return ['queued','preparing','running','post_processing'].includes(job.status);
}

const timestamp=(value:string)=>{const time=Date.parse(value);return Number.isFinite(time)?time:0;};

// A task owns its initial result slots, so completing it does not move those
// thumbnails past newer queued work. Later mask variants are separate saves.
export function resultTimeline(jobs:Job[],assets:ViewAsset[]):ResultTimelineEntry[]{
  const visible=new Map(assets.filter(visibleResult).map(asset=>[asset.asset_id,asset]));
  const claimed=new Set<string>();
  const entries:{entry:ResultTimelineEntry;time:number;order:number}[]=[];
  const add=(entry:ResultTimelineEntry,time:string)=>entries.push({entry,time:timestamp(time),order:entries.length});
  for(const job of jobs){
    if(isActiveJob(job)||!job.hidden_from_results&&(job.status==='failed'||job.status==='cancelled'))add({kind:'task',key:`task:${job.task_id}`,job},job.created_at);
    job.output_asset_ids.forEach((id,index)=>{
      const asset=visible.get(id);
      if(!asset||claimed.has(id))return;
      claimed.add(id);
      add({kind:'result',key:`asset:${id}`,asset,job},job.mask_edit&&index>0?asset.created_at:job.created_at);
    });
  }
  for(const asset of visible.values())if(!claimed.has(asset.asset_id))add({kind:'result',key:`asset:${asset.asset_id}`,asset},asset.created_at);
  return entries.sort((a,b)=>a.time-b.time||a.order-b.order).map(item=>item.entry);
}

// The mosaic identifies the frozen input, never the user's subsequently edited
// recipe. Hidden materials may still be valid historical references.
export function taskReferenceAsset(job:Job,assets:ViewAsset[]):ViewAsset|undefined{
  const available=new Map(assets.filter(asset=>asset.source_status!=='missing'&&asset.source_status!=='changed'&&!!asset.preview_url).map(asset=>[asset.asset_id,asset]));
  const images=job.chain_snapshot.blocks.filter(block=>block.type==='image');
  const ids=[job.mask_edit?.draft.source_asset_id,...images.filter(image=>image.reference_type==='subject').map(image=>image.asset_id),...images.map(image=>image.asset_id)];
  for(const id of ids){const asset=id?available.get(id):undefined;if(asset)return asset;}
  return undefined;
}
