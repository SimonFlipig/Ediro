import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// Reuse the app's existing green/Georgia "e" mark for the Windows executable.
export async function createReleaseIcon(svgFile, icoFile, previewFile) {
  const source=await readFile(svgFile),sizes=[16,24,32,48,64,128,256],images=[];
  for(const size of sizes)images.push(await sharp(source).resize(size,size).png().toBuffer());
  const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
  let offset=header.length;
  sizes.forEach((size,index)=>{const start=6+index*16;header[start]=size===256?0:size;header[start+1]=size===256?0:size;header.writeUInt16LE(1,start+4);header.writeUInt16LE(32,start+6);header.writeUInt32LE(images[index].length,start+8);header.writeUInt32LE(offset,start+12);offset+=images[index].length;});
  await writeFile(icoFile,Buffer.concat([header,...images]));
  await writeFile(previewFile,images.at(-1));
}
