import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Job, ModelConfig } from '../src/core/domain.js';
import { seedModels } from '../src/core/models.js';
import { GenerationTimings, type GenerationTiming, type GenerationTimingSample } from '../src/core/generation-timing.js';
import { generationTimingsFilename, loadGenerationTimings } from '../src/adapters/generation-timing-repository.js';

const origin = Date.parse('2026-10-22T00:00:00.000Z');
const at = (seconds: number) => new Date(origin + seconds * 1000).toISOString();
const model = (overrides: Partial<ModelConfig> = {}): ModelConfig => ({
  ...seedModels()[2], kind: 'cloud', connection_id: 'platform_a', family: 'nano', ...overrides,
});
function completed(id: string, duration: number, store: GenerationTimings, config = model(), seconds = 1) {
  return { task_id: id, status: 'succeeded' as Job['status'], model_snapshot: config, finished_at: at(seconds), timing: { ...store.begin(config, at(0)), duration_ms: duration } };
}
function record(store: GenerationTimings, fixture: Omit<ReturnType<typeof completed>, 'timing'> & { timing?: GenerationTiming }) {
  const {timing,...job}=fixture;
  // Execution identity and application-local timing use separate API arguments.
  return store.record(job,timing);
}

test('平台与家族分开统计，同一家族的不同模型型号共享均值', async () => {
  const store = new GenerationTimings();
  await record(store,completed('task_a', 10000, store));
  await record(store,completed('task_b', 30000, store, model({ model: 'another-nano' }), 2));
  await record(store,completed('task_other_platform', 90000, store, model({ connection_id: 'platform_b' }), 3));
  await record(store,completed('task_other_family', 120000, store, model({ family: 'gpt-image', adapter_id: 'openai-images' }), 4));
  assert.deepEqual(store.begin(model(), at(5)), { platform_id: 'platform_a', family: 'nano', started_at: at(5), sample_count: 2, estimated_duration_ms: 20000 });
  assert.equal(store.begin(model({ connection_id: 'platform_b' }), at(5)).estimated_duration_ms, 90000);
  assert.equal(store.begin(model({ connection_id: 'platform_empty' }), at(5)).estimated_duration_ms, undefined);
});

test('所有平台合计只留最新 50 条，按完成时间淘汰并去重', async () => {
  const store = new GenerationTimings();
  for (let i = 0; i < 65; i++) await record(store,completed(`task_${i}`, (i + 1) * 1000, store, model({ connection_id: i < 5 ? 'platform_old' : `platform_${i % 2}` }), i));
  assert.equal(store.snapshot().length, 50);
  assert.equal(store.snapshot()[0].task_id, 'task_15');
  assert.equal(store.begin(model({ connection_id: 'platform_old' }), at(70)).sample_count, 0);
  const before = store.snapshot();
  await record(store,completed('task_64', 99999, store, model(), 80));
  assert.deepEqual(store.snapshot(), before);
  await record(store,completed('task_late_old', 50000, store, model(), 1));
  assert.deepEqual(store.snapshot(), before, '迟到的旧记录不能挤出最近 50 条');
  assert.equal(store.begin(model({ connection_id: 'platform_0' }), at(70)).sample_count, 25);
});

test('失败、取消、未完成、模拟及无效耗时不会污染统计', async () => {
  let saves = 0;
  const store = new GenerationTimings([], async () => { saves++; });
  for (const status of ['failed', 'cancelled', 'queued', 'running', 'post_processing'] as const) await record(store,{ ...completed(status, 15000, store), status });
  await record(store,completed('mock', 10000, store, model({ kind: 'mock' })));
  await record(store,completed('reasoning', 10000, store, model({ family: 'reasoning', purpose: 'understanding' })));
  for (const duration of [0, -1, NaN, Infinity]) await record(store,completed(String(duration), duration, store));
  await record(store,{ ...completed('missing_duration', 15000, store), timing: store.begin(model(), at(0)) });
  await record(store,{ ...completed('missing_timing', 15000, store), timing: undefined });
  assert.equal(store.snapshot().length, 0);
  assert.equal(saves, 0);
});

test('未知家族按协议和型号隔离，不混用不同平台或本地模型', async () => {
  const store = new GenerationTimings();
  const unknown = model({ adapter_id: 'custom-image', family: undefined, preset_id: undefined, model: 'model-a' });
  await record(store,completed('custom_a', 24000, store, unknown));
  assert.equal(store.begin(unknown, at(1)).estimated_duration_ms, 24000);
  assert.equal(store.begin({ ...unknown, model: 'model-b' }, at(1)).sample_count, 0);
  assert.equal(store.begin({ ...unknown, adapter_id: 'custom-other' }, at(1)).sample_count, 0);
  assert.equal(store.begin({ ...unknown, kind: 'local' }, at(1)).sample_count, 0);
  assert.equal(store.begin({ ...unknown, connection_id: undefined }, at(1)).sample_count, 0);
});

test('当前任务估计保持冻结，样本快照和保存回调不会修改内部记录', async () => {
  const store = new GenerationTimings([], async samples => { samples[0].duration_ms = 1; });
  await record(store,completed('task_one', 10000, store));
  const frozen = store.begin(model(), at(2));
  await record(store,completed('task_two', 30000, store, model(), 3));
  assert.equal(frozen.estimated_duration_ms, 10000);
  assert.equal(store.begin(model(), at(4)).estimated_duration_ms, 20000);
  const samples = store.snapshot(); samples[0].duration_ms = 999;
  assert.equal(store.snapshot()[0].duration_ms, 10000);
});

test('并发记录串行落盘，统计写入失败不会将成功任务变成失败', async () => {
  const writes: GenerationTimingSample[][] = [];
  let failure = true;
  const store = new GenerationTimings([], async samples => {
    if (failure) { failure = false; throw new Error('disk unavailable'); }
    writes.push(samples);
  });
  const first = completed('first', 10000, store);
  await record(store,first);
  assert.equal(first.status, 'succeeded');
  assert.match(store.save_error!, /未保存/);
  await Promise.all([record(store,completed('second', 20000, store, model(), 2)), record(store,completed('third', 30000, store, model(), 3))]);
  assert.equal(store.save_error, undefined);
  assert.deepEqual(writes.at(-1)?.map(sample => sample.task_id), ['first', 'second', 'third']);
});

test('独立运行目录持久化，重开后复用均值且不存模型凭据或提示词', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ediro-generation-timing-'));
  const store = await loadGenerationTimings(directory);
  assert.equal(store.snapshot().length, 0);
  await record(store,completed('persisted', 32000, store, model({ endpoint: 'https://private.example', credential_ref: 'secret_ref' })));
  const saved = JSON.parse(await readFile(path.join(directory, generationTimingsFilename), 'utf8'));
  assert.equal(saved.schema_version, 1);
  assert.deepEqual(Object.keys(saved.samples[0]).sort(), ['duration_ms', 'family', 'finished_at', 'platform_id', 'task_id']);
  const reopened = await loadGenerationTimings(directory);
  assert.equal(reopened.begin(model(), at(6)).estimated_duration_ms, 32000);
  await record(reopened,completed('persisted', 90000, reopened));
  assert.equal(reopened.snapshot().length, 1);
  const isolated = await loadGenerationTimings(await mkdtemp(path.join(os.tmpdir(), 'ediro-generation-timing-other-')));
  assert.equal(isolated.begin(model(), at(6)).sample_count, 0);
});

test('损坏的可选统计文件不阻止应用启动，下一次成功记录可修复', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ediro-generation-timing-bad-'));
  const filename = path.join(directory, generationTimingsFilename);
  await writeFile(filename, '{bad-json', 'utf8');
  const store = await loadGenerationTimings(directory);
  assert.equal(store.snapshot().length, 0);
  await record(store,completed('recovered', 25000, store));
  const reopened = await loadGenerationTimings(directory);
  assert.equal(reopened.snapshot()[0].duration_ms, 25000);
});
