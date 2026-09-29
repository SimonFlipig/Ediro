import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import electron from 'electron';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
async function compile() {
  await new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.host.json'], { cwd: root, stdio: 'inherit', windowsHide: true });
    process.on('error', reject); process.on('exit', code => code === 0 ? resolve() : reject(new Error('后台编译失败')));
  });
  await import('./preload.mjs');
}
await compile();
const server = await createServer({ root }); await server.listen();
const child = spawn(electron, ['.'], { cwd: root, env: { ...env, EDIRO_DEV_URL: 'http://127.0.0.1:5190' }, stdio: 'inherit', windowsHide: true });
child.on('error', async e => { console.error(e.message); await server.close(); process.exitCode = 1; });
child.on('exit', async code => { await server.close(); process.exitCode = code ?? 0; });
for (const event of ['SIGINT','SIGTERM']) process.on(event, () => { child.kill(); void server.close(); });
