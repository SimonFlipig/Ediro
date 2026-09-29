export type UpdateAction = 'state' | 'check' | 'download' | 'install' | 'release';
export interface UpdateState {
  mode: 'development' | 'installed' | 'portable';
  currentVersion: string;
  status: 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  version?: string;
  percent?: number;
  message: string;
}
export interface UpdateResponse {ok: boolean; state: UpdateState; error?: string}
export interface UpdateApi {
  command(action: UpdateAction): Promise<UpdateResponse>;
  subscribe(listener: (state: UpdateState) => void): () => void;
}
