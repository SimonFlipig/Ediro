// Pictures and library definitions add references; only existing modules move.
export function referenceDropEffect(types: readonly string[], effectAllowed: string, acceptsImages: boolean): 'copy' | 'move' | 'none' {
  if (types.includes('application/ediro-asset') || types.includes('Files')) return acceptsImages ? 'copy' : 'none';
  if (types.includes('application/ediro-module')) return effectAllowed === 'move' ? 'move' : 'copy';
  return 'none';
}
