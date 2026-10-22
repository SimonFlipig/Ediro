import { useEffect, useId, useRef } from 'react';
import type { AdapterDescription, PublicConnection } from '../core/model-library.js';
import './model-platform-picker.css';

export interface ModelPlatformPickerProps {
  connections: PublicConnection[];
  adapters?: AdapterDescription[];
  onChoose: (connection: PublicConnection) => void;
  onNewPlatform: () => void;
  onDismiss: () => void;
}

export function ModelPlatformPicker({ connections, adapters, onChoose, onNewPlatform, onDismiss }: ModelPlatformPickerProps) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), descriptionId = useId();
  const hasPlatforms = connections.length > 0;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = dialog.current!;
    current.showModal();
    return () => {
      current.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialog} className="model-platform-picker" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <header className="model-platform-picker-heading">
      <span className="model-platform-picker-eyebrow">添加模型</span>
      <h2 id={titleId}>{hasPlatforms ? '选择添加到哪个平台' : '先添加一个平台'}</h2>
      <p id={descriptionId}>{hasPlatforms ? '选择平台后，即可在当前页面查找并添加模型。' : '尚未添加平台。先填写平台的 API 地址和密钥，保存后即可添加模型。'}</p>
    </header>
    {hasPlatforms && <div className="model-platform-picker-list" aria-label="可选平台">
      {connections.map(connection => {
        const status = !connection.enabled ? '已停用' : !connection.has_credential ? '待配置密钥' : !connection.endpoint ? '待配置地址' : '已配置';
        const protocol = adapters?.find(adapter => adapter.adapter_id === connection.adapter_id)?.title ?? '云端接口';
        return <button type="button" className="model-platform-choice" key={connection.connection_id} data-connection-id={connection.connection_id} onClick={() => onChoose(connection)}>
          <span className="model-platform-choice-copy"><b>{connection.title}</b><small>{protocol}</small></span>
          <span className={`model-platform-choice-status${status === '已配置' ? '' : ' pending'}`}>{status}</span>
          <span className="model-platform-choice-arrow" aria-hidden="true">›</span>
        </button>;
      })}
    </div>}
    <footer className="model-platform-picker-actions">
      <button type="button" onClick={onDismiss}>取消</button>
      <button type="button" className={hasPlatforms ? '' : 'primary'} autoFocus={!hasPlatforms} onClick={onNewPlatform}>添加平台</button>
    </footer>
  </dialog>;
}
