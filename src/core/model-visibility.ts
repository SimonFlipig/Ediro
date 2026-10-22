import type { LibraryData, ModelEntry } from './model-library.js';

function isUnconfiguredSeed(model: ModelEntry, data: LibraryData): boolean {
  if (model.kind === 'local') return model.model_config_id === 'model_local_pending'
    && model.adapter_id === 'local-pending' && model.model === 'unconfigured';
  if (model.kind !== 'cloud' || model.purpose !== 'generation') return false;

  const matchesSeed = model.model_config_id === 'model_nano_pro'
    ? model.model === 'gemini-3-pro-image' && model.adapter_id === 'gemini-generate-content'
    : model.model_config_id === 'model_image_2'
      && ['gpt-image-2', 'gpt-image-2.5-sunburst'].includes(model.model)
      && ['openai-images', 'kuai-images'].includes(model.adapter_id);
  if (!matchesSeed) return false;

  const connection = data.connections.find(item => item.connection_id === model.connection_id);
  return !connection?.credential_ref && model.revision <= 1 && (connection?.revision ?? 1) <= 1
    && !Object.values(data.assignments).includes(model.model_config_id);
}

/** Infer legacy ownership once; later credential or readiness changes keep that ownership. */
export function initializeModelOrigins(data: LibraryData): LibraryData {
  const next = structuredClone(data);
  for (const model of next.models) {
    model.origin ??= model.kind === 'mock' || isUnconfiguredSeed(model, next) ? 'builtin' : 'user';
  }
  return next;
}

export function hasUserModels(data: LibraryData): boolean {
  return data.models.some(model => model.kind !== 'mock' && model.origin === 'user');
}

export function isModelVisible(model: ModelEntry, data: LibraryData): boolean {
  return model.kind !== 'mock' || !hasUserModels(data);
}
