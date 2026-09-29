import sharp from 'sharp';
import type { CloudExecutionContext, CloudExecutionPort } from '../core/ports.js';
import { mockDescription } from '../core/model-library.js';
const escape = (text: string) => text.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!));
async function pause(ms: number, signal: AbortSignal) {
  if (signal.aborted) throw new Error('任务已取消。');
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('任务已取消。')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class MockGenerator implements CloudExecutionPort {
  readonly description = mockDescription;
  constructor(private delay = 500) {}
  async execute({ job, model, readImage,recordModelInput }: CloudExecutionContext, signal: AbortSignal, progress: (stage: string, value: number) => Promise<void>) {
    if (model.kind !== 'mock') throw new Error('真实模型适配器尚未接入；不会调用网络或产生费用。');
    if(recordModelInput){
      const blocks:unknown[]=[];
      if(job.adapted_input.kind==='native_blocks'){
        for(const block of job.adapted_input.blocks??[])if(block.type==='text')blocks.push({text:block.text});else{const bytes=await readImage(block.asset_id),meta=await sharp(bytes).metadata();blocks.push({inlineData:{mimeType:`image/${meta.format}`,data:bytes.toString('base64')}});}
      }else{
        blocks.push({prompt:job.adapted_input.prompt});
        for(const id of job.adapted_input.image_asset_ids??[]){const bytes=await readImage(id),meta=await sharp(bytes).metadata();blocks.push({inlineData:{mimeType:`image/${meta.format}`,data:bytes.toString('base64')}});}
      }
      if(job.mask_edit&&job.mask_edit.method!=='guided')blocks.push({mask:{mimeType:'image/png',data:(await readImage(job.mask_edit.mask_asset_id)).toString('base64')}});
      await recordModelInput({version:1,adapter_id:model.adapter_id,captured_at:new Date().toISOString(),route:'/simulation',body:{encoding:'simulation',blocks:[{parameters:job.recipe_snapshot.core_parameters},...blocks]}});
    }
    for (const [stage, value] of [['校验富媒体输入', 25], ['模拟模型执行（无 API 费用）', 55], ['准备占位结果', 80]] as const) {
      await pause(this.delay, signal);
      await progress(stage, value);
    }
    if(job.mask_edit){
      const bytes=await readImage(job.mask_edit.request_source_id??job.mask_edit.source_snapshot_id);
      const generated=await sharp(bytes).rotate().modulate({brightness:1.12,saturation:0.45}).tint('#d7a070').png().toBuffer();
      const meta=await sharp(generated).metadata();
      return {images:[{bytes:generated,format:'png' as const,width:meta.width!,height:meta.height!}]};
    }
    const ratio=job.output_geometry?.ratio??(job.recipe_snapshot.core_parameters.aspect_ratio==='auto'?'1:1':job.recipe_snapshot.core_parameters.aspect_ratio);
    const [rw, rh] = ratio.split(':').map(Number);
    const first = job.chain_snapshot.blocks.find(b => b.type === 'image');
    const reference = first?.type === 'image' ? await readImage(first.asset_id) : undefined;
    const width = rw >= rh ? 1200 : Math.round(1200 * rw / rh), height = rw >= rh ? Math.round(1200 * rh / rw) : 1200;
    const text = job.recipe_snapshot.modules.filter(m => m.enabled && m.reference_type === 'prompt').map(m => m.user_instruction).join(' ').slice(0, 36);
    const outputs: Buffer[] = [];
    for (let i = 0; i < job.recipe_snapshot.core_parameters.count; i++) {
      if (signal.aborted) throw new Error('任务已取消。');
      const cx = width / 2, cy = height / 2;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#f4efe8"/><stop offset="1" stop-color="#d8e1d8"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#b)"/><circle cx="${cx}" cy="${cy}" r="${Math.min(width,height)*.32}" fill="#e9e9df"/><ellipse cx="${cx}" cy="${height*.74}" rx="${width*.24}" ry="${height*.04}" fill="#bdc6b8"/><rect x="${cx-width*.15}" y="${height*.27}" width="${width*.3}" height="${height*.45}" rx="32" fill="#596d5e"/><rect x="${cx-width*.11}" y="${height*.43}" width="${width*.22}" height="${height*.17}" rx="6" fill="#f5f0e7"/><text x="${cx}" y="${height*.5}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="${width*.03}" fill="#374b3d">EDIRO</text><text x="40" y="55" font-family="Microsoft YaHei, sans-serif" font-size="22" fill="#3d5545">SIMULATION / 模拟占位结果 ${i+1}</text><text x="40" y="${height-72}" font-family="Microsoft YaHei, sans-serif" font-size="20" fill="#3d5545">${escape(text || '用于验证配方、任务与版本链')}</text><text x="40" y="${height-38}" font-family="Microsoft YaHei, sans-serif" font-size="16" fill="#5e7264">非真实生图 · 未调用云端 API · ${escape(job.task_id.slice(-8))}</text></svg>`;
      let pipeline = sharp(Buffer.from(svg));
      if (reference) {
        const size = Math.round(Math.min(width,height) * .38);
        const thumbnail = await sharp(reference).rotate().resize(size,size,{fit:'contain',background:'#f4f1e9'}).png().toBuffer();
        pipeline = pipeline.composite([{ input: thumbnail, left: Math.round((width-size)/2), top: Math.round((height-size)/2) }]);
      }
      outputs.push(await pipeline.toFormat(job.recipe_snapshot.core_parameters.output_format).toBuffer());
    }
    return { images: outputs.map(bytes=>({bytes,format:job.recipe_snapshot.core_parameters.output_format,width,height})) };
  }
}
