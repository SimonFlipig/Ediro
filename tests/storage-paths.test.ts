import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { storagePaths } from '../src/desktop/storage-paths.js';

const options={packaged:true,appDirectory:path.resolve('read-only/resources/app.asar'),executable:path.resolve('program/Ediro.exe'),userData:path.resolve('user/AppData/Ediro'),documents:path.resolve('user/Documents'),portable:false};

test('安装版数据不写进程序资源，换安装目录不改变数据位置',()=>{
  const initial=storagePaths(options);
  assert.equal(initial.runtimeDirectory,path.join(options.userData,'runtime'));
  assert.equal(initial.projectRoot,path.join(options.documents,'Ediro'));
  assert.deepEqual(storagePaths({...options,executable:path.resolve('updated/Ediro.exe'),appDirectory:path.resolve('updated/resources/app.asar')}),initial);
});

test('便携版使用 EXE 旁的 data，开发环境忽略便携标记并保留原路径',()=>{
  const portable=storagePaths({...options,portable:true});
  assert.equal(portable.projectRoot,path.resolve('program/data'));
  assert.equal(portable.runtimeDirectory,path.resolve('program/data/.local/runtime'));
  const dev=storagePaths({...options,packaged:false,appDirectory:path.resolve('source'),portable:true});
  assert.equal(dev.projectRoot,path.resolve('source'));
  assert.equal(dev.runtimeDirectory,path.resolve('source/.local/runtime'));
});
