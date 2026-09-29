export interface ImageViewport { zoom: number; x: number; y: number }
export const fittedViewport = (): ImageViewport => ({ zoom: 100, x: 0, y: 0 });

// Anchor is relative to the viewport centre. Keep the same image point beneath it.
export function zoomViewport(view: ImageViewport, requestedZoom: number, anchor = { x: 0, y: 0 }): ImageViewport {
  const zoom = Math.max(25, Math.min(300, requestedZoom));
  const ratio = zoom / view.zoom;
  return { zoom, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio };
}

export function wheelZoom(zoom: number, delta: number, mode: number, height: number): number {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? height : 1);
  return zoom * Math.exp(-Math.max(-120, Math.min(120, pixels)) * 0.002);
}

export function fittedImageSize(width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const scale = Math.min(1, Math.max(1, viewportWidth - 50) / width, Math.max(1, viewportHeight - 76) / height);
  return { width: width * scale, height: height * scale };
}
