export function SettingsPageHeader({page,busy=false,busyLabel='正在处理…',onModels,onModules,onPrompts,onClose}: {
  page:'models'|'modules'|'prompts';busy?:boolean;busyLabel?:string;
  onModels:()=>void;onModules:()=>void;onPrompts:()=>void;onClose:()=>void;
}) {
  return <div className="settings-page-heading">
    <div className="settings-page-title"><span className="settings-wordmark">ediro<span>.</span></span><h1>设置</h1></div>
    <nav className="settings-page-navigation" aria-label="设置分类">
      <button aria-pressed={page==='models'} disabled={busy} onClick={onModels}>模型设置</button>
      <button aria-pressed={page==='modules'} disabled={busy} onClick={onModules}>模块设置</button>
      <button aria-pressed={page==='prompts'} disabled={busy} onClick={onPrompts}>核心指令</button>
    </nav>
    <div className="settings-page-actions">{busy&&<span role="status">{busyLabel}</span>}<button disabled={busy} onClick={onClose}>返回工作台</button></div>
  </div>;
}
