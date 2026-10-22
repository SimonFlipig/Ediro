import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultModuleSettings, moduleSettingsSchema, type ModuleSettings } from '../core/module-settings.js';
import { atomicJson } from './atomic-json.js';

export const moduleSettingsFilename = 'module-settings.v1.json';

export async function loadModuleSettings(runtimeDirectory: string): Promise<ModuleSettings> {
  try {
    return moduleSettingsSchema.parse(JSON.parse(await readFile(path.join(runtimeDirectory, moduleSettingsFilename), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaultModuleSettings);
    throw new Error('模块设置无效，请检查 module-settings.v1.json。');
  }
}

export async function saveModuleSettings(runtimeDirectory: string, input: ModuleSettings): Promise<ModuleSettings> {
  const settings = moduleSettingsSchema.parse(input);
  await atomicJson(path.join(runtimeDirectory, moduleSettingsFilename), settings);
  return settings;
}
