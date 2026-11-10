import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createMaskPreview,MASK_PREVIEW_MAX_EDGE} from '../src/adapters/mask-preview.js';
import {MaskPixels} from '../src/adapters/mask-pixels.js';
import type {MaskCrop,MaskStroke} from '../src/core/mask.js';

const pixels=new MaskPixels();
const rgba=(bytes:Buffer)=>sharp(bytes).ensureAlpha().raw().toBuffer();
const patterned=(width:number,height:number,offset=0)=>{
  const data=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;
    data[i]=(x*17+y*3+offset)%256;data[i+1]=(x*5+y*13+offset)%256;data[i+2]=(x*7+y*19+offset)%256;
    data[i+3]=[0,70,180,255][(x+y+offset)%4];
  }
  return sharp(data,{raw:{width,height,channels:4}}).png().toBuffer();
};
const strokes:MaskStroke[]=[
  {tool:'paint',size:32,points:[[0,.1],[.45,.4],[1,.9]]},
  {tool:'erase',size:11,points:[[.45,.35],[.5,.55]]},
  {tool:'paint',size:7,points:[[.48,.48]]},
];

test('预览 worker 的小图画笔、减选和向内羽化与最终 RGBA 逐字节一致',async t=>{
  const width=80,height=64,source=await patterned(width,height),generated=await patterned(width,height,37);
  const session=await createMaskPreview({source,generated,width,height,guided:false});t.after(()=>session.dispose());
  for(const feather of [0,8]){
    const mask=await pixels.rasterize(width,height,strokes);
    const expected=await rgba(await pixels.compose(source,mask,generated,feather));
    const actual=await rgba(await session.render(strokes,'strict',feather));
    assert.deepEqual(actual,expected,`feather=${feather}`);
    const selection=await rgba(mask),base=await rgba(source);
    for(let i=0;i<width*height;i++)if(selection[i*4+3]===255)assert.deepEqual(actual.subarray(i*4,i*4+4),base.subarray(i*4,i*4+4));
  }
  // Reusing a decoded session must not retain the previous painted region.
  assert.deepEqual(await rgba(await session.render([],'strict',8)),await rgba(source));
});

test('预览 worker 的负坐标裁片、框外保护和自然融合与最终结果一致',async t=>{
  const width=72,height=56,crop:MaskCrop={x:-7,y:-9,width:51,height:48};
  const source=await patterned(width,height),generated=await patterned(crop.width,crop.height,29);
  const session=await createMaskPreview({source,generated,width,height,crop,guided:false});t.after(()=>session.dispose());
  const mask=await pixels.rasterize(width,height,strokes);
  for(const mode of ['strict','natural'] as const)for(const feather of [0,8]){
    const expected=await rgba(await pixels.compose(source,mask,generated,feather,crop,mode));
    assert.deepEqual(await rgba(await session.render(strokes,mode,feather)),expected,`${mode}, feather=${feather}`);
  }
});

test('预览 worker 的黑白引导尺寸微调保持最终合成像素一致',async t=>{
  const width=128,height=96,crop:MaskCrop={x:-6,y:8,width:120,height:80};
  const source=await patterned(width,height),generated=await patterned(121,80,19);
  const session=await createMaskPreview({source,generated,width,height,crop,guided:true});t.after(()=>session.dispose());
  const mask=await pixels.rasterize(width,height,strokes),aligned=await pixels.alignGuidedResult(generated,crop.width,crop.height);
  assert.deepEqual(await rgba(await session.render(strokes,'strict',8)),await rgba(await pixels.compose(source,mask,aligned,8,crop)));
});

test('预览 worker 拒绝黑白引导比例错误与原生结果尺寸不匹配',async()=>{
  const width=80,height=64,source=await patterned(width,height),generated=await patterned(120,64);
  await assert.rejects(createMaskPreview({source,generated,width,height,guided:true}),/画面比例/);
  await assert.rejects(createMaskPreview({source,generated,width,height,guided:false}),/尺寸/);
  await assert.rejects(createMaskPreview({source,generated:source,width:81,height,guided:false}),/底图尺寸/);
});

test('大图交互预览限制像素边长，原图尺寸保持独立',async t=>{
  const width=2048,height=1024;
  const source=await sharp({create:{width,height,channels:4,background:'#173958'}}).png().toBuffer();
  const generated=await sharp({create:{width,height,channels:4,background:'#a95d26'}}).png().toBuffer();
  const session=await createMaskPreview({source,generated,width,height,guided:false});t.after(()=>session.dispose());
  const preview=await sharp(await session.render(strokes,'strict',8)).metadata();
  assert.equal(preview.width,MASK_PREVIEW_MAX_EDGE);assert.equal(preview.height,MASK_PREVIEW_MAX_EDGE/2);
  assert.equal((await sharp(source).metadata()).width,width);
});

test('超大裁片与小底图共用预览比例，取整不放大裁片或移动保护边界',async t=>{
  const width=32,height=32,crop:MaskCrop={x:-4992,y:-492,width:5000,height:500};
  const source=await sharp({create:{width,height,channels:4,background:'#173958'}}).png().toBuffer();
  const generated=await sharp({create:{width:crop.width,height:crop.height,channels:4,background:'#a95d26'}}).png().toBuffer();
  const session=await createMaskPreview({source,generated,width,height,crop,guided:false});t.after(()=>session.dispose());
  const full:MaskStroke[]=[{tool:'paint',size:100,points:[[.5,.5]]}];
  // The crop covers only the top-left 8x8 source pixels. Its 5000-pixel
  // edge determines the common scale; that edge becomes 1536 pixels and
  // the protected boundary lands at preview coordinate 2, not 3. Using
  // roundedBaseWidth / originalWidth would expand the crop to 1563 pixels.
  for(const mode of ['strict','natural'] as const){
    const image=await sharp(await session.render(full,mode,0)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(image.info.width,10);assert.equal(image.info.height,10);
    assert.ok(Math.max(image.info.width,image.info.height)<=MASK_PREVIEW_MAX_EDGE);
    for(let y=0;y<10;y++)for(let x=0;x<10;x++){
      const expected=x<2&&y<2?[169,93,38,255]:[23,57,88,255];
      assert.deepEqual([...image.data.subarray((y*10+x)*4,(y*10+x)*4+4)],expected,`${mode}, (${x}, ${y})`);
    }
  }
});

test('销毁预览会话拒绝未完成和后续请求，不能把迟到结果用于新工程',async()=>{
  const width=64,height=48,source=await patterned(width,height),generated=await patterned(width,height,5);
  const session=await createMaskPreview({source,generated,width,height,guided:false});
  const pending=session.render(strokes,'strict',8),rejected=assert.rejects(pending,/预览已关闭/);
  session.dispose();session.dispose();await rejected;
  await assert.rejects(session.render(strokes,'strict',0),/预览已关闭/);
});
