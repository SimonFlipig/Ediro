import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleResult, usableThumbnail } from '../src/ui/asset-display.js';
import type { ViewAsset } from '../src/shared/api.js';

const result={kind:'output',source_status:'available'} as ViewAsset;
test('历史版本隐藏已删除和缺失结果，不影响资产本身',()=>{
  assert.equal(visibleResult(result),true);
  assert.equal(visibleResult({...result,removed_result:true}),false);
  assert.equal(visibleResult({...result,hidden_from_results:true}),false);
  assert.equal(visibleResult({...result,source_status:'missing'}),false);
  assert.equal(visibleResult({...result,kind:'import'}),false);
});
test('缺失引用保留占位，不输出失效缩略图',()=>{
  assert.equal(usableThumbnail(result),true);
  assert.equal(usableThumbnail({...result,source_status:'missing'}),false);
  assert.equal(usableThumbnail(undefined),false);
});
