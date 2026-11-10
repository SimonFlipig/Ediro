import type { ClipboardEvent } from 'react';
import { MAX_MODULE_IMAGE_REFERENCES, MAX_STORED_IMAGE_BYTES } from '../core/image-limits.js';

// Keep File objects while the paste event still grants access to its DataTransfer.
export function handleImagePaste(event: ClipboardEvent<HTMLElement>, onImages: (files: File[]) => void) {
  const target = event.target;
  if (event.defaultPrevented || !(target instanceof Element) || !event.currentTarget.contains(target)) return;
  if (target.closest('input, select, [contenteditable="true"]')) return;

  const data = event.clipboardData;
  const files = data.files.length ? Array.from(data.files) : Array.from(data.items)
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null);
  const images = files.filter(file => file.type.startsWith('image/') || (!file.type && /\.(png|jpe?g|webp)$/i.test(file.name)));
  if (!images.length) return;

  event.preventDefault();
  onImages(images);
}

export async function readClipboardImages(files: File[], existingCount: number) {
  if (existingCount + files.length > MAX_MODULE_IMAGE_REFERENCES) throw new Error(`每个模块最多添加 ${MAX_MODULE_IMAGE_REFERENCES} 张参考图。`);
  if (files.some(file => file.size === 0)) throw new Error('剪贴板里有空图片，请重新复制。');
  if (files.reduce((total, file) => total + file.size, 0) > MAX_STORED_IMAGE_BYTES) {
    throw new Error('一次粘贴的图片总大小不能超过 192 MB。');
  }
  try {
    return await Promise.all(files.map(async file => ({
      name: file.name === 'image.png' ? '剪贴板图片.png' : file.name.slice(0, 200) || '剪贴板图片',
      bytes: new Uint8Array(await file.arrayBuffer()),
    })));
  } catch {
    throw new Error('无法读取剪贴板图片，请重新复制后粘贴。');
  }
}
