import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile,stat,utimes,unlink } from 'node:fs/promises';
import path from 'node:path';
import { checkBuild,recordBuild,sourceInventory } from '../scripts/build-state.mjs';

async function fixture(){
  const base=path.join(process.cwd(),'.local','test-launcher');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'case-'));
  for(const [name,content] of Object.entries({'src/core/semantic-prompts.ts':'保持主体。','scripts/preload.mjs':'preload','package.json':'{}','dist/index.html':'index','dist/assets/app.js':'app','dist-host/desktop/main.js':'main','dist-host/desktop/preload.cjs':'preload'})){
    const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);
  }
  await writeFile(path.join(root,'dist-host/desktop/entry.js'),'entry');
  return root;
}
test('启动检查跳过最新构建，模板改动即使时间戳相同也会触发构建',async()=>{
  const root=await fixture();assert.equal((await checkBuild(root)).needed,true);await recordBuild(root);assert.equal((await checkBuild(root)).needed,false);
  const file=path.join(root,'src/core/semantic-prompts.ts'),info=await stat(file);await writeFile(file,'保持主体颜色。');await utimes(file,info.atime,info.mtime);
  assert.equal((await checkBuild(root)).needed,true);
});
test('产物删除或损坏、源码增删均触发构建，构建中源码变化不发布最新标记',async()=>{
  const root=await fixture();await recordBuild(root);await writeFile(path.join(root,'dist/assets/app.js'),'broken');assert.equal((await checkBuild(root)).needed,true);
  await recordBuild(root);await unlink(path.join(root,'dist-host/desktop/preload.cjs'));assert.equal((await checkBuild(root)).needed,true);await assert.rejects(()=>recordBuild(root),/缺少/);
  await writeFile(path.join(root,'dist-host/desktop/preload.cjs'),'preload');await recordBuild(root);
  const before=await sourceInventory(root);await writeFile(path.join(root,'src/new.ts'),'new');await assert.rejects(()=>recordBuild(root,before),/源码发生变化/);
  await recordBuild(root);await unlink(path.join(root,'src/new.ts'));assert.equal((await checkBuild(root)).needed,true);
});
