import test from 'node:test';
import assert from 'node:assert/strict';
import { fittedImageSize, fittedViewport, wheelZoom, zoomViewport } from '../src/ui/image-viewport.js';

test('缩放保持鼠标下的图片点不动，包括已平移的图片', () => {
  const view = { zoom: 125, x: 40, y: -30 }, anchor = { x: 140, y: 90 };
  const next = zoomViewport(view, 250, anchor);
  assert.equal((anchor.x - next.x) / next.zoom, (anchor.x - view.x) / view.zoom);
  assert.equal((anchor.y - next.y) / next.zoom, (anchor.y - view.y) / view.zoom);
});
test('工具栏缩放以视口中心为锚点，缩放限制不产生额外位移', () => {
  assert.deepEqual(zoomViewport({ zoom: 100, x: 20, y: -10 }, 200), { zoom: 200, x: 40, y: -20 });
  assert.deepEqual(zoomViewport({ zoom: 300, x: 20, y: -10 }, 500, { x: 50, y: 50 }), { zoom: 300, x: 20, y: -10 });
  assert.equal(zoomViewport(fittedViewport(), 0).zoom, 25);
  assert.deepEqual(fittedViewport(), { zoom: 100, x: 0, y: 0 });
});
test('滚轮方向、行和页模式一致，极端输入受限', () => {
  assert.ok(wheelZoom(100, -100, 0, 400) > 100);
  assert.ok(wheelZoom(100, 100, 0, 400) < 100);
  assert.equal(wheelZoom(100, 1, 1, 400), wheelZoom(100, 16, 0, 400));
  assert.equal(wheelZoom(100, 1, 2, 400), wheelZoom(100, 400, 0, 400));
  assert.equal(wheelZoom(100, 0, 0, 400), 100);
  assert.equal(wheelZoom(100, -10000, 0, 400), wheelZoom(100, -120, 0, 400));
});
test('适应保持纵横比，横图竖图和小图都完整显示', () => {
  assert.deepEqual(fittedImageSize(1000, 500, 550, 476), { width: 500, height: 250 });
  assert.deepEqual(fittedImageSize(500, 1000, 550, 476), { width: 200, height: 400 });
  assert.deepEqual(fittedImageSize(100, 50, 550, 476), { width: 100, height: 50 });
});
