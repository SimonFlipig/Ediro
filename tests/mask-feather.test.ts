import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {MaskPixels} from '../src/adapters/mask-pixels.js';

const pixels=new MaskPixels();
const width=40,height=40;
const png=(w:number,h:number,color:string)=>sharp({create:{width:w,height:h,channels:4,background:color}}).png().toBuffer();
const rgba=(image:Buffer)=>sharp(image).ensureAlpha().raw().toBuffer();
const at=(image:Buffer,x:number,y:number)=>[...image.subarray((y*width+x)*4,(y*width+x)*4+4)];
async function mask(selected:(x:number,y:number)=>number){
  const data=Buffer.alloc(width*height*4,255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)data[(y*width+x)*4+3]=255-selected(x,y);
  return sharp(data,{raw:{width,height,channels:4}}).png().toBuffer();
}

test('羽化不沿图像四边和四角淡出，只在真实选区边界向内过渡',async()=>{
  const base=await png(width,height,'black'),generated=await png(width,height,'white');
  // Top-left rectangle, rotated across all four corners, covers every canvas edge.
  const turns=[(x:number,y:number)=>[x,y],(x:number,y:number)=>[width-1-x,y],(x:number,y:number)=>[x,height-1-y],(x:number,y:number)=>[width-1-x,height-1-y]];
  for(const turn of turns){
    const selected=await mask((x,y)=>{const [u,v]=turn(x,y);return u<24&&v<24?255:0;});
    const out=await rgba(await pixels.compose(base,selected,generated,6));
    const point=(x:number,y:number)=>{const [u,v]=turn(x,y);return at(out,u,v);};
    for(const [x,y] of [[0,0],[0,12],[12,0],[12,12]])assert.deepEqual(point(x,y),[255,255,255,255]);
    assert.deepEqual(point(24,12),[0,0,0,255]);
    assert.ok(point(23,12)[0]>0&&point(23,12)[0]<point(20,12)[0]);
    assert.ok(point(20,12)[0]<point(16,12)[0]);
    // An internal boundary near the canvas edge must still fade correctly.
    assert.deepEqual(point(0,23),point(12,23));
    const selection=await rgba(selected);
    for(let i=0;i<width*height;i++)if(selection[i*4+3]===255)assert.deepEqual(out.subarray(i*4,i*4+4),Buffer.from([0,0,0,255]));
  }
});

test('整幅选区包括最大羽化仍完整覆盖，减选孔洞与半透明覆盖保持各自边界',async()=>{
  const base=await png(width,height,'black'),generated=await png(width,height,'white'),full=await mask(()=>255);
  for(const feather of [0,6,64])assert.deepEqual(await rgba(await pixels.compose(base,full,generated,feather)),await rgba(generated));
  const hole=await mask((x,y)=>x>=16&&x<24&&y>=16&&y<24?0:255);
  const out=await rgba(await pixels.compose(base,hole,generated,6));
  assert.deepEqual(at(out,0,0),[255,255,255,255]);assert.deepEqual(at(out,20,20),[0,0,0,255]);
  assert.ok(at(out,15,20)[0]>0&&at(out,15,20)[0]<at(out,12,20)[0]);
  const partial=await mask(()=>128),blended=await rgba(await pixels.compose(base,partial,generated,64));
  assert.deepEqual(at(blended,0,0),[128,128,128,255]);assert.deepEqual(at(blended,20,20),at(blended,0,0));
});

test('裁片贴到图像外沿时不淡出，图像内部的裁切边界仍羽化且框外逐字节保留',async()=>{
  const base=await png(width,height,'#123456'),full=await mask(()=>255);
  for(const crop of [{x:0,y:0,width:24,height:24},{x:-5,y:-7,width:29,height:31}]){
    const out=await rgba(await pixels.compose(base,full,await png(crop.width,crop.height,'white'),6,crop));
    assert.deepEqual(at(out,0,0),[255,255,255,255]);assert.deepEqual(at(out,24,12),[18,52,86,255]);
    assert.ok(at(out,23,12)[0]>18&&at(out,23,12)[0]<at(out,20,12)[0]);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(x>=24||y>=24)assert.deepEqual(at(out,x,y),[18,52,86,255]);
  }
});
