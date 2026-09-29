import test from 'node:test';
import assert from 'node:assert/strict';
import { describeViewpoint } from '../src/ui/viewpoint-labels.js';

const view=(yaw:number,pitch=0,roll=0,projection:'orthographic'|'perspective'='perspective')=>describeViewpoint({yaw,pitch,roll,projection});

test('视角标签对应当前旋转方向：截图角度为右前方俯视',()=>{
  assert.deepEqual(view(-40,-36),{
    direction:'Front-right three-quarter view',elevation:'High-angle view',projection:'Perspective view',tilt:'',promptValue:'Front-right three-quarter view, High-angle view',summaryZh:'右前方三分之四视角 · 俯视 · 透视'
  });
  assert.equal(view(40,-36).direction,'Front-left three-quarter view');
});

test('水平范围连续覆盖正面、斜角、侧面、背面与首尾接缝',()=>{
  for(const [yaw,label] of [[-3,'Symmetrical front view'],[0,'Symmetrical front view'],[3,'Symmetrical front view'],[-3.01,'Front view'],[3.01,'Front view'],[15,'Front view'],[15.01,'Front-left three-quarter view'],[74.99,'Front-left three-quarter view'],[75,'Left side view'],[105,'Left side view'],[105.01,'Rear-left three-quarter view'],[164.99,'Rear-left three-quarter view'],[165,'Rear view'],[180,'Rear view'],[-180,'Rear view'],[-90,'Right side view'],[-135,'Rear-right three-quarter view']] as const){
    assert.equal(view(yaw).direction,label,String(yaw));
  }
});

test('垂直视角覆盖俯仰和平视，完全俯视不附加误导的正侧面',()=>{
  assert.equal(view(-45,-74.99).direction,'Front-right three-quarter view');
  for(const yaw of [-180,-90,0,90,180]){
    assert.equal(view(yaw,-75).direction,'Top-down view');
    assert.equal(view(yaw,-90).elevation,'');
    assert.equal(view(yaw,90).direction,'Bottom view');
  }
  assert.equal(view(0,-75).direction,'Top-down view');
  assert.equal(view(0,75).direction,'Bottom view');
  assert.equal(view(0,18).elevation,'Eye-level shot');
  assert.equal(view(0,-18).elevation,'Eye-level shot');
  assert.equal(view(0,-18.01).elevation,'High-angle view');
  assert.equal(view(0,18.01).elevation,'Low-angle view');
});

test('等轴测须同时满足投影与角度，不能把所有正交画面称为等轴测',()=>{
  assert.equal(view(-45,-35.264,0,'orthographic').projection,'Isometric view (orthographic)');
  assert.equal(view(135,35.264,0,'orthographic').projection,'Isometric view (orthographic)');
  assert.equal(view(-45,-35.264).projection,'Perspective view');
  assert.equal(view(0,0,0,'orthographic').projection,'Orthographic view');
  assert.equal(view(-45,-20,0,'orthographic').projection,'Orthographic view');
});

test('倾斜只描述画面姿态，保留观察方向；不自动引入风格或构图词',()=>{
  assert.equal(view(-40,-36,45).direction,view(-40,-36).direction);
  assert.equal(view(0,0,14.99).tilt,'');
  assert.equal(view(0,0,15).tilt,'Clockwise tilt');
  assert.equal(view(0,0,-45).tilt,'Counterclockwise tilt');
  assert.equal(view(0,0,180).tilt,'Upside-down framing');
  const serialized=JSON.stringify(view(-40,-36));
  assert.ok(!/Flat lay|Knolling|Hero shot|Macro/.test(serialized));
});

test('{viewpoint} 只组合水平方向与俯仰标签，不包含投影或倾斜',()=>{
  const described=view(3,18,30,'orthographic');
  assert.equal(described.promptValue,'Symmetrical front view, Eye-level shot');
  assert.ok(!described.promptValue.includes(described.projection));
  assert.ok(!described.promptValue.includes(described.tilt));
  assert.equal(view(0,-75).promptValue,'Top-down view');
});
