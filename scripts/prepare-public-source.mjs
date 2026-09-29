import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Deliberate allowlist: never copy local data, development notes or Git history.
const included = [
  'src', 'tests', 'scripts', 'build', 'config', 'third_party',
  '.gitattributes', '.gitignore', '.npmrc', 'package.json', 'package-lock.json',
  'index.html', 'tsconfig.json', 'tsconfig.host.json', 'tsconfig.test.json',
  'vite.config.ts', 'electron-builder.cjs', 'provider-capabilities.v1.json',
  'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'Ediro.vbs', '启动 Ediro.cmd', '启动 Ediro.ps1',
  '启动浏览器验证.cmd', '启动浏览器验证.ps1',
  'docs/Windows发布与数据目录.md', 'docs/单文件工程_v1.md',
  ...(await readdir(path.join(root, 'docs'))).filter(name => /^RELEASE_NOTES_v\d+\.\d+\.\d+\.md$/.test(name)).sort().map(name => `docs/${name}`),
  'docs/screenshots',
];
await mkdir(path.join(root, '.local'), {recursive: true});
const stage = await mkdtemp(path.join(root, '.local', 'public-source-'));
const entries = [];
async function copy(relative) {
  const source = path.join(root, relative);
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Symlink excluded: ${relative}`);
  if (info.isDirectory()) {
    for (const name of (await readdir(source)).sort()) await copy(`${relative}/${name}`);
    return;
  }
  if (!info.isFile()) throw new Error(`Unsupported file: ${relative}`);
  if (/(^|\/)(\.env(?:\..*)?|\.git|node_modules|\.local|Project|output|input)(\/|$)/i.test(relative)) {
    throw new Error(`Private or generated path in allowlist: ${relative}`);
  }
  const bytes = await readFile(source);
  // Report only paths, never potential credential values.
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{20,}|\bAIza[A-Za-z0-9_-]{30,}/.test(bytes.toString('utf8'))) {
    throw new Error(`Potential credential requires review: ${relative}`);
  }
  const target = path.join(stage, relative);
  await mkdir(path.dirname(target), {recursive: true});
  await copyFile(source, target);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (createHash('sha256').update(await readFile(target)).digest('hex') !== sha256) throw new Error(`Copy mismatch: ${relative}`);
  entries.push({path: relative, bytes: bytes.length, sha256});
}
for (const relative of included) await copy(relative);
const report = {directory: stage, createdAt: new Date().toISOString(), status: 'local-source-candidate-not-published', count: entries.length, included, entries};
await writeFile(`${stage}.manifest.json`, JSON.stringify(report, null, 2));
await writeFile(path.join(root, '.local', 'last-public-source.json'), JSON.stringify({directory: stage, manifest: `${stage}.manifest.json`}, null, 2));
console.log(JSON.stringify({directory: stage, files: entries.length, manifest: `${stage}.manifest.json`}, null, 2));
