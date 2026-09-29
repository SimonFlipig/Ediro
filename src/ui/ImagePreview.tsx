import { useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ViewAsset } from '../shared/api.js';
import { fittedImageSize, wheelZoom, zoomViewport } from './image-viewport.js';
import type { ImageViewport } from './image-viewport.js';

export function ImagePreview({ asset, view, onChange }: {
  asset: ViewAsset; view: ImageViewport; onChange: Dispatch<SetStateAction<ImageViewport>>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: asset.width, height: asset.height });
  useLayoutEffect(() => {
    const element = container.current!;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      if (event.target !== image.current) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = element.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left - element.clientWidth / 2, y: event.clientY - bounds.top - element.clientHeight / 2 };
      onChange(previous => zoomViewport(previous, wheelZoom(previous.zoom, event.deltaY, event.deltaMode, element.clientHeight), anchor));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [onChange]);
  const fitted = fittedImageSize(Math.max(1, natural.width), Math.max(1, natural.height), size.width, size.height);
  const finishDrag = () => { drag.current = null; setDragging(false); };
  return <div ref={container} className={`image-viewport ${dragging ? 'is-panning' : ''}`}>
    <img ref={image} className="main-image" src={asset.original_url} alt={asset.name} draggable={false}
      title="滚轮缩放 · 按住左键拖动 · 点击适应恢复居中"
      style={{ width: fitted.width, height: fitted.height, visibility: size.width ? 'visible' : 'hidden', transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.zoom / 100})` }}
      onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        setDragging(true);
      }}
      onPointerMove={event => {
        const previous = drag.current;
        if (!previous || previous.id !== event.pointerId) return;
        if (!(event.buttons & 1)) { finishDrag(); return; }
        const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        onChange(value => ({ ...value, x: value.x + dx, y: value.y + dy }));
      }}
      onPointerUp={event => {
        if (drag.current?.id !== event.pointerId) return;
        finishDrag();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
    />
  </div>;
}
