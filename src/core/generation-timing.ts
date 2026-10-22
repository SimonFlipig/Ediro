import { z } from 'zod';
import type { Job, ModelConfig } from './domain.js';
import { familyForModel } from '../protocols/model-catalog.js';

export const generationTimingLimit = 50;
const groupingFields = {
  platform_id: z.string().min(1).max(240),
  family: z.string().min(1).max(240),
};
export const generationTimingSchema = z.object({
  ...groupingFields,
  started_at: z.string().datetime(),
  estimated_duration_ms: z.number().finite().positive().optional(),
  sample_count: z.number().int().min(0).max(generationTimingLimit),
  duration_ms: z.number().finite().positive().optional(),
});
export type GenerationTiming = z.infer<typeof generationTimingSchema>;
export const generationTimingSampleSchema = z.object({
  ...groupingFields,
  task_id: z.string().min(1).max(100),
  duration_ms: z.number().finite().positive(),
  finished_at: z.string().datetime(),
});
export type GenerationTimingSample = z.infer<typeof generationTimingSampleSchema>;
export const generationTimingsSchema = z.object({
  schema_version: z.literal(1),
  samples: z.array(generationTimingSampleSchema).max(generationTimingLimit),
});

function latestSamples(samples: GenerationTimingSample[]) {
  const valid = samples.flatMap(sample => {
    const result = generationTimingSampleSchema.safeParse(sample);
    return result.success ? [result.data] : [];
  }).sort((a, b) => Date.parse(a.finished_at) - Date.parse(b.finished_at));
  const unique = new Map<string, GenerationTimingSample>();
  for (const sample of valid) {
    unique.delete(sample.task_id);
    unique.set(sample.task_id, sample);
  }
  return [...unique.values()].slice(-generationTimingLimit);
}

type TimedJob = Pick<Job, 'task_id' | 'status' | 'finished_at' | 'model_snapshot'>;

/** Runtime-wide successful attempts, bounded globally rather than per model group. */
export class GenerationTimings {
  private samples: GenerationTimingSample[];
  private pending: Promise<void> = Promise.resolve();
  save_error?: string;

  constructor(samples: GenerationTimingSample[] = [], private save: (samples: GenerationTimingSample[]) => Promise<void> = async () => {}) {
    this.samples = latestSamples(samples);
  }

  snapshot() { return structuredClone(this.samples); }

  begin(model: ModelConfig, started_at: string): GenerationTiming {
    // A vendor name cannot distinguish separate platforms using the same model.
    const platform_id = model.kind === 'cloud'
      ? model.connection_id ?? `unbound:${model.model_config_id}`
      : `${model.kind}:${model.adapter_id}:${model.model_config_id}`;
    const family = familyForModel(model) ?? `custom:${model.adapter_id}:${model.model}`;
    const matches = model.kind === 'mock' ? [] : this.samples.filter(sample => sample.platform_id === platform_id && sample.family === family);
    return {
      platform_id, family, started_at, sample_count: matches.length,
      ...(matches.length ? { estimated_duration_ms: matches.reduce((sum, sample) => sum + sample.duration_ms / matches.length, 0) } : {}),
    };
  }

  record(job: TimedJob, timing?: GenerationTiming): Promise<void> {
    if (job.status !== 'succeeded' || job.model_snapshot.kind === 'mock' || !timing || timing.family === 'reasoning') return Promise.resolve();
    const parsed = generationTimingSampleSchema.safeParse({
      task_id: job.task_id,
      platform_id: timing.platform_id,
      family: timing.family,
      duration_ms: timing.duration_ms,
      finished_at: job.finished_at,
    });
    if (!parsed.success) return Promise.resolve();
    const sample = parsed.data;
    this.pending = this.pending.then(async () => {
      if (this.samples.some(previous => previous.task_id === sample.task_id)) return;
      this.samples = latestSamples([...this.samples, sample]);
      try {
        await this.save(this.snapshot());
        this.save_error = undefined;
      } catch {
        // Optional estimates must never turn a completed generation into a failure.
        // Keep the usable in-memory sample; the next successful write includes it.
        this.save_error = '生成耗时统计未保存。';
      }
    });
    return this.pending;
  }
}
