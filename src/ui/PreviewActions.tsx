export function PreviewActions({onRemove,onExport,removeDisabled=false,exportDisabled=false,removeLabel='移除当前结果'}:{
  onRemove?:()=>void; onExport?:()=>void; removeDisabled?:boolean; exportDisabled?:boolean; removeLabel?:string;
}){
  if(!onRemove&&!onExport)return null;
  return <div className="preview-actions" role="group" aria-label="预览操作">
    {onRemove&&<button type="button" className="preview-remove" aria-label={removeLabel} title={removeLabel} disabled={removeDisabled} onClick={onRemove}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg>
    </button>}
    {onExport&&<button type="button" className="preview-export" aria-label="导出当前图片" title="导出当前图片" disabled={exportDisabled} onClick={onExport}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3m-4 4 4-4 4 4M5 13v7h14v-7"/></svg>
    </button>}
  </div>;
}
