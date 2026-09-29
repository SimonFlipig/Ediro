import { useEffect, useState } from 'react';
import type { UpdateApi, UpdateAction, UpdateState } from '../shared/updates.js';
import { AppDialog, type DialogAction } from './AppDialog.js';

export function UpdatePanel({api, open, onClose, onState}: {api?: UpdateApi; open: boolean; onClose: () => void; onState: (state: UpdateState) => void}) {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    if (!api) return;
    const accept = (next: UpdateState) => {setState(next);onState(next);};
    const stop = api.subscribe(accept);
    void api.command('state').then(result => accept(result.state)).catch(() => {});
    return stop;
  }, [api, onState]);
  if (!open) return null;
  const run = async (action: UpdateAction) => {
    if (!api) throw new Error('更新服务不可用。');
    // Download/check run in the host; keep the dialog dismissible while waiting.
    void api.command(action).then(result => {
      setState(result.state);onState(result.state);
      if (!result.ok && result.error) setState({...result.state, message: result.error});
    }).catch(() => setState(previous => previous ? {...previous, message: '无法连接更新服务，请稍后重试。'} : previous));
  };
  const actions: DialogAction[] = [{label: '关闭', run: onClose}];
  if (state && !['disabled','checking','downloading','downloaded','installing'].includes(state.status)) actions.push({label: state.status === 'error' ? '重新检查' : '检查更新', run: () => run('check')});
  if (state?.status === 'available') actions.push({label: state.mode === 'portable' ? '下载新版 ZIP' : '下载更新', primary: true, run: () => run(state.mode === 'portable' ? 'release' : 'download')});
  if (state?.status === 'downloaded') actions.push({label: '保存并重启升级', primary: true, run: () => run('install')});
  if (state?.status === 'error') actions.push({label: '打开发布页', run: () => run('release')});
  return <AppDialog title="软件更新" onDismiss={onClose} actions={actions}>
    <p>当前版本 {state?.currentVersion ?? '—'}{state?.mode === 'portable' ? ' · 便携版' : ''}</p>
    {state?.version && <p>新版本 {state.version}</p>}
    <p role="status">{state?.message ?? '正在连接更新服务…'}</p>
    {state?.status === 'downloading' && <p><progress aria-label="更新下载进度" max={100} value={state.percent ?? 0}/>{' '}{state.percent ?? 0}%</p>}
    {state?.status === 'downloaded' && <p>请先结束正在运行的任务。工程、设置和 API Key 会保留；安装到 Program Files 时可能需要管理员授权。</p>}
  </AppDialog>;
}
