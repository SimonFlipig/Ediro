import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceDropEffect } from '../src/ui/drag-input.js';

test('素材和结果图片引用使用 copy，不与源端 copy 冲突',()=>{
  assert.equal(referenceDropEffect(['application/ediro-asset'],'copy',true),'copy');
  assert.equal(referenceDropEffect(['Files'],'copy',true),'copy');
});
test('模块库新增使用 copy，已有模块排序使用 move',()=>{
  assert.equal(referenceDropEffect(['application/ediro-module'],'copy',false),'copy');
  assert.equal(referenceDropEffect(['application/ediro-module'],'move',false),'move');
});
test('提示词及功能工具模块拒绝图片和未知拖拽',()=>{
  assert.equal(referenceDropEffect(['application/ediro-asset'],'copy',false),'none');
  assert.equal(referenceDropEffect(['Files'],'copy',false),'none');
  assert.equal(referenceDropEffect(['text/uri-list'],'copy',true),'none');
});
