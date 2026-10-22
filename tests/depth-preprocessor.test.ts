import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {depthImage,prepareDepthInput,renderDepthImage} from '../src/adapters/depth-preprocessor.js';
import {resolveLocalImageModel} from '../src/adapters/local-image-models.js';

const source=await sharp({create:{width:1024,height:512,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
test('深度输入保留比例和方向，内部长边有上限，透明区域铺白',async()=>{
  const input=await prepareDepthInput(source);
  assert.deepEqual([input.sourceWidth,input.sourceHeight,input.contentWidth,input.contentHeight,input.width,input.height],[1024,512,518,259,518,266]);
  assert.ok(Math.abs(input.pixels[0]-(1-0.485)/0.229)<0.00001);
  assert.equal(input.pixels[0],input.pixels[input.width*input.height-1]);
  const oriented=await sharp(source).jpeg().withMetadata({orientation:6}).toBuffer(),portrait=await prepareDepthInput(oriented);
  assert.deepEqual([portrait.sourceWidth,portrait.sourceHeight,portrait.contentWidth,portrait.contentHeight],[512,1024,259,518]);
  const small=await prepareDepthInput(await sharp({create:{width:25,height:13,channels:3,background:'red'}}).png().toBuffer());
  assert.deepEqual([small.contentWidth,small.contentHeight,small.width,small.height],[25,13,28,14]);
  await assert.rejects(prepareDepthInput(Buffer.from('invalid')));
});

test('深度输出排除补边再归一化，恢复基图尺寸并拒绝异常张量',async()=>{
  const input=await prepareDepthInput(source),depth=new Float32Array(input.width*input.height).fill(1e6);
  for(let y=0;y<input.contentHeight;y++)for(let x=0;x<input.contentWidth;x++)depth[y*input.width+x]=x;
  const result=await renderDepthImage(depth,[1,input.height,input.width],input);
  const {data,info}=await sharp(result).greyscale().raw().toBuffer({resolveWithObject:true});
  assert.deepEqual([info.width,info.height],[1024,512]);
  assert.equal(data[0],0);assert.equal(data[info.width-1],255);
  await assert.rejects(renderDepthImage(depth,[1,1,1],input),/尺寸/);
  depth[0]=NaN;await assert.rejects(renderDepthImage(depth,[1,input.height,input.width],input),/无效数值/);
  depth.fill(42);const constant=await sharp(await renderDepthImage(depth,[1,input.height,input.width],input)).raw().toBuffer();
  assert.ok(constant.every(value=>value===0));
});

test('可选本地权重真实 CPU 推理，输出可解码且与横图尺寸一致',{skip:!process.env.EDIRO_TEST_LOCAL_IMAGE_MODELS_RUNTIME},async()=>{
  const paths=await resolveLocalImageModel(process.env.EDIRO_TEST_LOCAL_IMAGE_MODELS_RUNTIME!,'depth');
  const bytes=await sharp({create:{width:320,height:160,channels:3,background:'red'}}).png().toBuffer();
  const result=await depthImage(bytes,paths.model),metadata=await sharp(result).metadata();
  assert.deepEqual([metadata.width,metadata.height,metadata.format],[320,160,'png']);
  await sharp(result).raw().toBuffer();
});
