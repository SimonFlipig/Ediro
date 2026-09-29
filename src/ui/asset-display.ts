import type { ViewAsset } from '../shared/api.js';

export const visibleResult = (asset: ViewAsset) => asset.kind === 'output' && !asset.removed_result && !asset.hidden_from_results && asset.source_status !== 'missing';
export const usableThumbnail = (asset: ViewAsset | undefined) => !!asset && asset.source_status !== 'missing';
