import ts from 'typescript';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const source = await readFile(new URL('../src/desktop/preload.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
await mkdir(new URL('../dist-host/desktop/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist-host/desktop/preload.cjs', import.meta.url), output);
