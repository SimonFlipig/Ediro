import sharp from 'sharp';
import type {ReferenceSettings} from '../core/module-settings.js';

// Scale sigma with the actual image, so 512 and 1K use comparable strengths.
export async function blurReferenceImage(bytes:Buffer,strength:ReferenceSettings['blur_strength']):Promise<Buffer>{
  const metadata=await sharp(bytes).metadata();
  if(!metadata.width||!metadata.height)throw new Error('参考图尺寸无效。');
  const fraction={weak:0.006,medium:0.014,strong:0.028}[strength];
  if(!fraction)throw new Error('不支持的模糊强度。');
  return sharp(bytes).blur(Math.max(0.3,Math.max(metadata.width,metadata.height)*fraction)).png().toBuffer();
}
