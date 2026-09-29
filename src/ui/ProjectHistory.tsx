import {useEffect,useMemo,useRef,useState} from 'react';
import type {Command,ProjectRecord} from '../shared/api.js';
import './project-history.css';

const labels:Record<ProjectRecord['status'],string>={running:'生成中',draft:'草稿已保存',failed:'任务未完成',saved:'已保存',empty:'未生成',unavailable:'记录暂不可用'};
const PAGE_SIZE=15;
export function ProjectHistory({records,currentId,dispatch,onClose}:{records:ProjectRecord[];currentId?:string;dispatch:(command:Command,success?:string)=>Promise<boolean>;onClose:()=>void}){
  const [query,setQuery]=useState(''),[page,setPage]=useState(0),[editing,setEditing]=useState<string>(),[name,setName]=useState(''),[busy,setBusy]=useState(false);
  const filtered=useMemo(()=>records.filter(r=>r.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),[records,query]);
  const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)),current=Math.min(page,pages-1);
  const scroll=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(scroll.current)scroll.current.scrollTop=0;},[current,query]);
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!busy){if(editing)setEditing(undefined);else onClose();}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[busy,editing,onClose]);
  const open=async(id:string)=>{setBusy(true);if(await dispatch({type:'workspace:resume',id},'项目已恢复'))onClose();setBusy(false);};
  const rename=async(id:string)=>{if(!name.trim())return;setBusy(true);if(await dispatch({type:'workspace:rename',id,name:name.trim()},'项目名称已保存'))setEditing(undefined);setBusy(false);};
  return <div className="modal-backdrop"><section className="project-history" role="dialog" aria-modal="true" aria-labelledby="project-history-title">
    <header><div><span className="eyebrow">PROJECTS</span><h2 id="project-history-title">项目记录 <small>{records.length}</small></h2></div><button className="project-history-close" onClick={onClose} disabled={busy} aria-label="关闭项目记录">×</button></header>
    <div className="project-history-search"><input autoFocus aria-label="搜索项目" placeholder="搜索项目名称…" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/><span>最近编辑优先</span></div>
    <div className="project-history-scroll" ref={scroll}>
      {filtered.length?<div className="project-history-grid">{filtered.slice(current*PAGE_SIZE,(current+1)*PAGE_SIZE).map(record=><article className={`project-history-card ${record.id===currentId?'current':''}`} key={record.id}>
        <button className="project-history-open" disabled={busy||record.status==='unavailable'} onClick={()=>void open(record.id)} aria-label={`打开项目 ${record.title}`}>
          <div className="project-history-cover">{record.preview_url?<img src={record.preview_url} alt={record.title} loading="lazy" onError={e=>{e.currentTarget.style.display='none';}}/>:<span>暂无图片</span>}{record.id===currentId&&<b>当前项目</b>}</div>
          <div className="project-history-info"><strong title={record.location??record.title}>{record.title}</strong><span>{record.updated_at?new Date(record.updated_at).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'无法读取记录'}</span></div>
        </button>
        {editing===record.id?<form className="project-history-rename" onSubmit={e=>{e.preventDefault();void rename(record.id);}}><input autoFocus aria-label="项目名称" maxLength={100} value={name} onChange={e=>setName(e.target.value)}/><button disabled={busy||!name.trim()} type="submit">保存</button><button type="button" disabled={busy} onClick={()=>setEditing(undefined)}>取消</button></form>:<div className="project-history-meta"><span className={`project-state ${record.status}`}>{labels[record.status]}</span><span>{record.result_count} 个结果</span><button disabled={busy||record.status==='unavailable'} onClick={()=>{setName(record.title);setEditing(record.id);}}>改名</button><button disabled={busy} onClick={async()=>{setBusy(true);await dispatch({type:'workspace:remove',id:record.id},'项目已删除');setBusy(false);}}>删除</button></div>}
      </article>)}</div>:<div className="project-history-empty">{query?'没有找到匹配的项目':'还没有项目记录'}</div>}
    </div>
    <footer><button disabled={busy} onClick={async()=>{setBusy(true);if(await dispatch({type:'project:open'},'项目已打开'))onClose();setBusy(false);}}>打开工程…</button><div><span>{filtered.length?`${current*PAGE_SIZE+1}–${Math.min((current+1)*PAGE_SIZE,filtered.length)} / ${filtered.length}`:'0 个项目'}</span><button aria-label="上一页项目" disabled={current===0||busy} onClick={()=>setPage(current-1)}>上一页</button><button aria-label="下一页项目" disabled={current+1>=pages||busy} onClick={()=>setPage(current+1)}>下一页</button></div></footer>
  </section></div>;
}
