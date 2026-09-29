import path from 'node:path';

export interface StoragePathOptions {
  packaged: boolean;
  appDirectory: string;
  executable: string;
  userData: string;
  documents: string;
  portable: boolean;
}

// Program resources can be read-only (including app.asar). Never write data there.
export function storagePaths(options: StoragePathOptions) {
  if (!options.packaged) return {
    mode: 'development' as const,
    projectRoot: options.appDirectory,
    runtimeDirectory: path.join(options.appDirectory, '.local', 'runtime'),
  };
  if (options.portable) {
    const root = path.join(path.dirname(options.executable), 'data');
    return { mode: 'portable' as const, projectRoot: root, runtimeDirectory: path.join(root, '.local', 'runtime') };
  }
  return {
    mode: 'installed' as const,
    projectRoot: path.join(options.documents, 'Ediro'),
    runtimeDirectory: path.join(options.userData, 'runtime'),
  };
}
