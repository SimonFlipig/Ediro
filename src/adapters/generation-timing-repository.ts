import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GenerationTimings, generationTimingsSchema, type GenerationTimingSample } from '../core/generation-timing.js';
import { atomicJson } from './atomic-json.js';

export const generationTimingsFilename = 'generation-timings.v1.json';

export async function loadGenerationTimings(runtimeDirectory: string): Promise<GenerationTimings> {
  const filename = path.join(runtimeDirectory, generationTimingsFilename);
  let samples: GenerationTimingSample[] = [];
  try {
    samples = generationTimingsSchema.parse(JSON.parse(await readFile(filename, 'utf8'))).samples;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('生成耗时统计无法读取，暂从新记录开始估算。');
  }
  return new GenerationTimings(samples, next => atomicJson(filename, { schema_version: 1, samples: next }));
}
