import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {MaskPixels} from '../src/adapters/mask-pixels.js';
import {createMaskPreview} from '../src/adapters/mask-preview.js';
import {closeMaskStroke,maskSelectionSvg,maskStrokeSchema,type MaskStroke} from '../src/core/mask.js';

const stroke=(points:MaskStroke['points'],tool:MaskStroke['tool']='paint',size=2):MaskStroke=>({tool,size,points});
const square=(low:number,high:number,tool:MaskStroke['tool']='paint')=>stroke([[low,low],[high,low],[high,high],[low,high],[low,low]],tool);
const pixels=new MaskPixels();
const alpha=async(width:number,height:number,strokes:MaskStroke[])=>sharp(await pixels.rasterize(width,height,strokes)).extractChannel('alpha').raw().toBuffer();
const rgba=(bytes:Buffer)=>sharp(bytes).ensureAlpha().raw().toBuffer();

test('闭合检测保留普通开放笔迹，接受有实际区域的不规则圈',()=>{
  const line=stroke([[.1,.2],[.4,.3],[.6,.5],[.8,.7]]);
  assert.equal(closeMaskStroke(line,100,100),line);
  const loop=stroke([[.2,.2],[.75,.15],[.85,.55],[.6,.8],[.15,.65],[.2,.2]]);
  const closed=closeMaskStroke(loop,100,100);
  assert.equal(closed.closed,true);assert.equal(loop.closed,undefined);
  assert.equal(closed.points,loop.points);assert.equal(closed.tool,'paint');
  assert.equal(closeMaskStroke(closed,100,100),closed);
});

test('小缺口可补齐，大缺口和 C 形即使缩小或使用大画笔也不封口',()=>{
  const small=stroke([[.2,.2],[.8,.2],[.8,.8],[.2,.8],[.2,.24]]);
  assert.equal(closeMaskStroke(small,100,100).closed,true);
  const large=stroke([[.2,.2],[.8,.2],[.8,.8],[.2,.8],[.2,.4]],'paint',1000);
  assert.equal(closeMaskStroke(large,100,100,.25),large);
  const c=stroke([[.8,.2],[.3,.2],[.2,.5],[.3,.8],[.8,.8]],'erase',1000);
  assert.equal(closeMaskStroke(c,100,100,.25),c);
});

test('首尾距离按原图长宽换算，并按屏幕缩放适配容差',()=>{
  const loop=stroke([[.2,.2],[.8,.2],[.8,.8],[.2,.8],[.23,.2]]);
  assert.equal(closeMaskStroke(loop,400,100,.25).closed,true);
  assert.equal(closeMaskStroke(loop,400,100,1),loop);
  assert.equal(closeMaskStroke(loop,100,400,1).closed,true);
  const tight=stroke([[.2,.2],[.8,.2],[.8,.8],[.2,.8],[.2,.22]]);
  assert.equal(closeMaskStroke(tight,100,100,2).closed,true);
  assert.equal(closeMaskStroke(tight,100,100,4),tight);
});

test('单击、重复点、直线往返、微小抖动及面积抵消的交叉不自动填充',()=>{
  const cases=[
    stroke([[.5,.5]]),
    stroke([[.5,.5],[.5,.5],[.5,.5],[.5,.5]]),
    stroke([[.2,.2],[.8,.8],[.5,.5],[.2,.2]]),
    stroke([[.2,.5],[.8,.5],[.5,.501],[.2,.5]]),
    square(.5,.51),
    stroke([[.2,.2],[.8,.8],[.2,.8],[.8,.2],[.2,.2]]),
  ];
  for(const s of cases)assert.equal(closeMaskStroke(s,100,100),s);
  const loop=square(.2,.8);
  for(const scale of [0,-1,Infinity,NaN])assert.equal(closeMaskStroke(loop,100,100,scale),loop);
});

test('闭合加选填内部，闭合减选挖洞，之后加选可填回且保留圈外',async()=>{
  const paint=closeMaskStroke(square(.1,.9),100,100);
  const erase=closeMaskStroke(square(.35,.65,'erase'),100,100);
  assert.equal(paint.closed,true);assert.equal(erase.closed,true);
  const filled=await alpha(100,100,[paint]);
  assert.equal(filled[50*100+50],0);assert.equal(filled[5*100+5],255);
  const hollow=await alpha(100,100,[paint,erase]);
  assert.equal(hollow[50*100+50],255);assert.equal(hollow[20*100+20],0);
  const repainted=await alpha(100,100,[paint,erase,closeMaskStroke(square(.45,.55),100,100)]);
  assert.equal(repainted[50*100+50],0);assert.equal(repainted[40*100+40],255);
});

test('旧笔迹与 closed=false 即使首尾重合也只描边，序列化保留显式闭合字段',async()=>{
  const legacy=square(.2,.8),closed=closeMaskStroke(legacy,100,100);
  const oldAlpha=await alpha(100,100,[legacy]);
  assert.equal(oldAlpha[50*100+50],255);assert.equal(oldAlpha[20*100+50],0);
  assert.equal((await alpha(100,100,[{...legacy,closed:false}]))[50*100+50],255);
  assert.equal('closed' in maskStrokeSchema.parse(legacy),false);
  assert.deepEqual(maskStrokeSchema.parse(JSON.parse(JSON.stringify(closed))),closed);
  assert.equal(maskStrokeSchema.parse({...legacy,closed:false}).closed,false);
  assert.equal(maskStrokeSchema.safeParse({...legacy,closed:'true'}).success,false);
  assert.match(maskSelectionSvg(100,100,[closed]),/polygon[^>]*fill="white" fill-rule="evenodd"/);
  assert.match(maskSelectionSvg(100,100,[legacy]),/polyline[^>]*fill="none"/);
});

test('显式闭合的自交轮廓在预览形状及栅格化中采用 evenodd 规则',async()=>{
  const twice:MaskStroke={...square(.2,.8),closed:true};
  twice.points=[...twice.points,...twice.points.slice(1)];
  assert.match(maskSelectionSvg(100,100,[twice]),/fill-rule="evenodd"/);
  assert.equal((await alpha(100,100,[twice]))[50*100+50],255);
});

test('闭合加选及孔洞的 worker 预览与最终严格合成像素一致',async t=>{
  const width=100,height=100;
  const source=await sharp({create:{width,height,channels:4,background:'#193551'}}).png().toBuffer();
  const generated=await sharp({create:{width,height,channels:4,background:'#efab67'}}).png().toBuffer();
  const session=await createMaskPreview({source,generated,width,height,guided:false});
  t.after(()=>session.dispose());
  const paint=closeMaskStroke(square(.1,.9),width,height),erase=closeMaskStroke(square(.35,.65,'erase'),width,height);
  for(const strokes of [[paint],[paint,erase]])for(const feather of [0,8]){
    const mask=await pixels.rasterize(width,height,strokes);
    const expected=await rgba(await pixels.compose(source,mask,generated,feather));
    const actual=await rgba(await session.render(strokes,'strict',feather));
    assert.deepEqual(actual,expected,`strokes=${strokes.length}, feather=${feather}`);
  }
});
