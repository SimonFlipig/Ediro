import { safeStorage } from 'electron';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { idSchema } from '../core/domain.js';
import type { SecretStore } from '../core/models.js';

export class EncryptedSecretStore implements SecretStore {
  constructor(private directory: string) {}
  private filename(ref: string) { return path.join(this.directory, `${idSchema.parse(ref)}.bin`); }
  async has(ref: string) {
    try { return (await stat(this.filename(ref))).isFile(); } catch { return false; }
  }
  async set(ref: string, value: string) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全加密不可用，拒绝明文保存 API Key。');
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.filename(ref), safeStorage.encryptString(value));
  }
  // Only executor-side credential resolution may call this, never the UI bridge.
  async resolve(ref: string) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('安全凭据存储不可用。');
    return safeStorage.decryptString(await readFile(this.filename(ref)));
  }
}
