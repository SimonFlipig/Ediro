import { useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { ViewAsset } from '../shared/api.js';
import { fittedImageSize, wheelZoom, zoomViewport } from './image-viewport.js';
import type { ImageViewport } from './image-viewport.js';

export function ImagePreview({ asset, view, onChange, actions }: {
  asset: Pick<ViewAsset,'width'|'height'|'name'|'original_url'>; view: ImageViewport; onChange: Dispatch<SetStateAction<ImageViewport>>; actions?: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const actionContainer = useRef<HTMLDivElement>(null);
  const hasActions = !!actions;
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0, actionWidth: 0, actionHeight: 0 });
  const [natural, setNatural] = useState({ width: asset.width, height: asset.height });
  useLayoutEffect(() => {
    const element = container.current!;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight, actionWidth: actionContainer.current?.offsetWidth ?? 0, actionHeight: actionContainer.current?.offsetHeight ?? 0 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (actionContainer.current) observer.observe(actionContainer.current);
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
  }, [onChange, hasActions]);
  const fitted = fittedImageSize(Math.max(1, natural.width), Math.max(1, natural.height), size.width, size.height);
  // Keep controls above the image's right edge without scaling them with the
  // pixels. When zoom/pan moves that edge offscreen, keep the controls reachable.
  const actionRight = Math.max(8, Math.min(Math.max(8, size.width - size.actionWidth - 8), size.width / 2 - view.x - fitted.width * view.zoom / 200));
  const actionTop = Math.max(8, Math.min(Math.max(8, size.height - size.actionHeight - 8), size.height / 2 + view.y - fitted.height * view.zoom / 200 - size.actionHeight - 6));
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
    {actions && <div ref={actionContainer} className="preview-action-anchor" style={{ right: actionRight, top: actionTop, visibility: size.width ? 'visible' : 'hidden' }}>{actions}</div>}
  </div>;
}
