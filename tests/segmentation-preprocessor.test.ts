import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {regionMeanPixels,segmentImage,type RegionMask} from '../src/adapters/segmentation-preprocessor.js';

const pixels=(colours:number[][])=>Uint8Array.from(colours.flatMap(colour=>[...colour,255]));
const mask=(values:number[],quality=0.9):RegionMask=>({pixels:Uint8Array.from(values),area:values.filter(Boolean).length,quality});

test('区域分割按区域均色，嵌套掩码保留小物体，输出没有类别配色',()=>{
  const source=pixels([[20,40,60],[40,60,80],[200,20,20],[220,40,40],[60,80,100],[80,100,120]]);
  const result=regionMeanPixels(source,6,1,[mask([1,1,1,1,1,1]),mask([0,0,1,1,0,0])],1);
  assert.deepEqual([...result],[...pixels([[30,50,70],[30,50,70],[210,30,30],[210,30,30],[70,90,110],[70,90,110]])]);
  // The two disconnected areas of the larger mask retain independent colours.
  assert.notEqual(result[0],result[4*4]);
});

test('区域分割清理重叠后的小碎片和小洞，不留下单像素噪点',()=>{
  const source=pixels(Array.from({length:9},(_,index)=>index===4?[250,250,250]:[25,25,25]));
  const result=regionMeanPixels(source,3,3,[mask([1,1,1,1,1,1,1,1,1]),mask([0,0,0,0,1,0,0,0,0])],2);
  for(let index=0;index<9;index++)assert.deepEqual([...result.subarray(index*4,index*4+3)],[50,50,50]);
});

test('区域均色忽略全透明像素，按alpha加权并保留原透明度',()=>{
  const source=Uint8Array.from([100,0,0,255,0,100,0,85,0,0,255,0]);
  const result=regionMeanPixels(source,3,1,[mask([1,1,1])],1);
  assert.deepEqual([...result],[75,25,0,255,75,25,0,85,0,0,255,0]);
});

test('区域分割输入或模型不可用时明确失败，不返回原图或占位图',async()=>{
  const paths={encoder:'missing-region-encoder.onnx',decoder:'missing-region-decoder.onnx'};
  await assert.rejects(segmentImage(Buffer.from('broken image'),paths),/参考图区域分割失败/);
  const bytes=await sharp({create:{width:1200,height:1,channels:3,background:'white'}}).png().toBuffer();
  await assert.rejects(segmentImage(bytes,paths),/先将参考图缩至/);
  const small=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
  await assert.rejects(segmentImage(small,paths),/参考图区域分割失败/);
  assert.throws(()=>regionMeanPixels(Uint8Array.from([1,2,3]),1,1,[]),/尺寸/);
});
