import test from 'node:test';
import assert from 'node:assert/strict';
import type {Job} from '../src/core/domain.js';
import type {GenerationTiming} from '../src/core/generation-timing.js';
import {formatGenerationDuration,generationProgress} from '../src/ui/generation-progress.js';

const start=Date.parse('2026-10-22T08:00:00.000Z');
const task=(patch:Partial<Job>={}):Pick<Job,'status'|'progress'|'finished_at'>=>({status:'running',progress:30,...patch});
const timing=(patch:Partial<GenerationTiming>={}):GenerationTiming=>({platform_id:'platform_test',family:'nano',started_at:new Date(start).toISOString(),estimated_duration_ms:60_000,sample_count:5,...patch});

test('等待中的预计进度随着时间前进，平均耗时处留出完成空间',()=>{
  const job=task(),runtime=timing();
  const states=[0,5_000,15_000,30_000,60_000].map(elapsed=>generationProgress(job,start+elapsed,runtime));
  assert.ok(states.every((state,index)=>state.percent!==undefined&&state.percent<100&&(index===0||state.percent>states[index-1].percent!)));
  assert.equal(states.at(-1)?.percent,90);
  assert.equal(states.at(-1)?.elapsedMs,60_000);
  assert.equal(states.at(-1)?.sampleCount,5);
  assert.equal('timing' in job,false,'运行时计时不再属于工程任务');
});

test('超过预计时间继续缓慢前进，等待任意久都不会冒充完成',()=>{
  const runtime=timing();
  const states=[61_000,90_000,120_000,240_000,3_600_000].map(elapsed=>generationProgress(task(),start+elapsed,runtime));
  assert.ok(states.every((state,index)=>state.percent!>=90&&state.percent!<=98&&(index===0||state.percent!>=states[index-1].percent!)));
  assert.ok(states[2].percent!-states[1].percent!<states[1].percent!-states[0].percent!);
  assert.equal(generationProgress(task({status:'succeeded'}),start+1,runtime).percent,100);
  assert.equal(generationProgress(task({status:'post_processing'}),start+30_000,runtime).percent,98);
});

test('排队不将创建或排队时间计入生成等待',()=>{
  const queued=generationProgress(task({status:'queued'}),start+600_000);
  assert.equal(queued.percent,0);
  assert.equal(queued.elapsedMs,undefined);
  assert.equal(queued.active,false);
  assert.equal(queued.estimatedMs,undefined);
  assert.equal(queued.indeterminate,false);
});

test('无样本或损坏估算仅显示不确定等待，不猜百分比或耗时',()=>{
  for(const runtime of [undefined,timing({sample_count:0}),timing({estimated_duration_ms:0}),timing({estimated_duration_ms:NaN}),timing({estimated_duration_ms:Infinity})]){
    const state=generationProgress(task(),start+120_000,runtime);
    assert.equal(state.indeterminate,true);assert.equal(state.percent,undefined);assert.equal(state.estimatedMs,undefined);
  }
  assert.equal(generationProgress(task(),start+12_500,timing({sample_count:0})).elapsedMs,12_500);
});

test('失败取消优先使用运行时固定耗时，不随墙上时间继续增长',()=>{
  for(const status of ['failed','cancelled'] as const){
    const job=task({status,finished_at:new Date(start+90_000).toISOString()}),runtime=timing({duration_ms:15_000});
    const earlier=generationProgress(job,start+120_000,runtime),later=generationProgress(job,start+900_000,runtime);
    assert.deepEqual(earlier,later);assert.equal(earlier.elapsedMs,15_000);assert.equal(earlier.active,false);
    assert.ok(earlier.percent!<100);
  }
});

test('未保存duration的停止任务按finished_at冻结；旧任务最多保留99%',()=>{
  const job=task({status:'cancelled',finished_at:new Date(start+30_000).toISOString()}),runtime=timing();
  assert.deepEqual(generationProgress(job,start+60_000,runtime),generationProgress(job,start+3_600_000,runtime));
  assert.equal(generationProgress(job,start+60_000,runtime).elapsedMs,30_000);
  assert.equal(generationProgress(task({status:'failed',progress:100}),start).percent,99);
  assert.equal(generationProgress(task({status:'succeeded'}),start).percent,100);
});

test('未来或无效开始时间不产生负值或NaN',()=>{
  assert.equal(generationProgress(task(),start-5_000,timing()).percent,0);
  const invalid=generationProgress(task(),start,timing({started_at:'invalid'}));
  assert.equal(invalid.percent,undefined);assert.equal(invalid.elapsedMs,undefined);assert.equal(invalid.indeterminate,true);
});

test('时长文字区分实际已用和向上取整的预计值',()=>{
  assert.equal(formatGenerationDuration(999),'0 秒');
  assert.equal(formatGenerationDuration(999,true),'1 秒');
  assert.equal(formatGenerationDuration(60_000),'1 分');
  assert.equal(formatGenerationDuration(65_100),'1 分 5 秒');
  assert.equal(formatGenerationDuration(-5),'0 秒');
});
