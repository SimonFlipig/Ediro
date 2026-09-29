import { modelConfigSchema, defaultParameters, type ModelConfig } from '../core/domain.js';
import { imagesProfile,geminiProfile,mockProfile } from './generation-profiles.js';

const mockCapabilities = { interleaving: 'native' as const, max_images: 24, aspect_ratios: ['1:1', '4:3', '3:4', '16:9'], qualities: ['standard'], formats: ['png', 'jpeg', 'webp'] as const, max_count: 4, operations: ['generate','nativeMaskEdit'] };
export function seedModels(): ModelConfig[] {
  return [
    { model_config_id: 'model_mock_native', title: '模拟引擎 · 原生图文链', kind: 'mock', provider: 'ediro', model: 'mock-native-v1', adapter_id: 'mock', endpoint: '', enabled: true, executable: true, revision: 1, capabilities: { ...mockCapabilities, formats: [...mockCapabilities.formats] }, defaults: { ...defaultParameters } },
    { model_config_id: 'model_mock_separated', title: '模拟引擎 · 降级接口', kind: 'mock', provider: 'ediro', model: 'mock-separated-v1', adapter_id: 'mock', endpoint: '', enabled: true, executable: true, revision: 1, capabilities: { ...mockCapabilities, interleaving: 'separated', formats: [...mockCapabilities.formats] }, defaults: { ...defaultParameters } },
    { model_config_id: 'model_nano_pro', title: 'Nano Banana Pro', kind: 'cloud', provider: 'google', model: 'gemini-3-pro-image', adapter_id: 'gemini-generate-content', endpoint: 'https://generativelanguage.googleapis.com', enabled: true, executable: false, revision: 1,
      capabilities: { interleaving: 'native', max_images: 14, aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'], qualities: ['1K', '2K', '4K'], formats: ['png'], max_count: 1, operations: ['generate', 'referenceEdit','guidedMaskEdit'] }, defaults: { ...defaultParameters, quality: '2K' } },
    { model_config_id: 'model_image_2', title: 'GPT-Image-2 · Images API', kind: 'cloud', provider: 'openai', model: 'gpt-image-2', adapter_id: 'openai-images', endpoint: 'https://api.openai.com', enabled: true, executable: false, revision: 1,
      capabilities: { interleaving: 'separated', max_images: 16, aspect_ratios: ['1:1', '3:2', '2:3'], qualities: ['low', 'medium', 'high', 'auto'], formats: ['png', 'jpeg', 'webp'], max_count: 10, operations: ['generate', 'referenceEdit', 'nativeMaskEdit'] }, defaults: { ...defaultParameters, quality: 'high' } },
    { model_config_id: 'model_local_pending', title: '本地轻量引擎 · 待选型', kind: 'local', provider: 'local', model: 'unconfigured', adapter_id: 'local-pending', endpoint: '', enabled: false, executable: false, revision: 1,
      capabilities: { interleaving: 'native', max_images: 1, aspect_ratios: ['1:1'], qualities: ['standard'], formats: ['png'], max_count: 1, operations: [] }, defaults: { ...defaultParameters } },
  ].map(m => modelConfigSchema.parse({...m,generation_contract:m.adapter_id==='gemini-generate-content'?geminiProfile:m.adapter_id==='openai-images'?imagesProfile:mockProfile,capabilities:{...m.capabilities,...(m.adapter_id==='gemini-generate-content'?{features:['reference_overrides','google_search']}:{})}}));
}
