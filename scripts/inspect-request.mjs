// Private, read-only diagnostics. Not imported by the desktop renderer.
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';

const args=process.argv.slice(2),raw=args.includes('--raw');
const positional=args.filter(arg=>arg!=='--raw');
if(!positional.length||args.includes('--help')){
  console.log('用法：node scripts/inspect-request.mjs <项目目录或 ediro.project.json> [任务 ID / 结果资产 ID / 结果文件名] [--raw]\n不指定任务时列出记录；默认隐藏图片 Base64，--raw 保留原始捕获内容。只读取文件，不联网、不生成、不改写项目。');
}else{
  try{
    if(positional.length>2)throw new Error('参数过多，请使用 --help 查看用法。');
    const target=path.resolve(positional[0]);
    const filename=(await stat(target)).isDirectory()?path.join(target,'ediro.project.json'):target;
    const project=JSON.parse(await readFile(filename,'utf8')),directory=path.dirname(filename);
    const assets=new Map((project.assets??[]).map(asset=>[asset.asset_id,asset]));
    const jobs=project.jobs??[],selector=positional[1];
    if(!selector){
      console.log(JSON.stringify({project:project.name,directory,jobs:jobs.map(job=>({task_id:job.task_id,created_at:job.created_at,status:job.status,model:job.model_snapshot?.title,kind:job.mask_edit?'局部修改':'生成',results:(job.output_asset_ids??[]).map(id=>({asset_id:id,name:assets.get(id)?.name}))}))},null,2));
    }else{
      const matches=jobs.filter(job=>job.task_id===selector||(job.output_asset_ids??[]).some(id=>id===selector||assets.get(id)?.name===selector));
      if(matches.length!==1)throw new Error(matches.length?'匹配到多条记录，请使用完整任务 ID。':'未找到记录，请先省略第二个参数列出任务。');
      const job=matches[0];
      if(!/^[a-zA-Z0-9_-]+$/.test(job.task_id))throw new Error('任务 ID 无效。');
      const capturePath=path.join(directory,'model-inputs',`${job.task_id}.json`);
      let capture=null;
      try{capture=JSON.parse(await readFile(capturePath,'utf8'));}
      catch(error){if(error.code!=='ENOENT')throw error;}
      // Expand JSON for reading, without reconstructing a missing request.
      const displayCapture=capture&&!raw&&capture.body?.encoding==='json'
        ?{...capture,body:{...capture.body,json:JSON.parse(capture.body.json)}}:capture;
      const imageData=(key,value)=>!raw&&typeof value==='string'&&['data','data_base64'].includes(key)
        ?`[图片 Base64：${value.length} 字符；使用 --raw 查看]`:value;
      console.log(JSON.stringify({project:project.name,task_id:job.task_id,capture_path:capturePath,
        capture_status:capture?'发送前保存的实际请求':'没有捕获记录：以下快照不能证明实际发送内容，未重新编译请求。',
        captured_request:displayCapture,model:job.model_snapshot,error:job.error??null,
        recipe_snapshot:job.recipe_snapshot,chain_snapshot:job.chain_snapshot,adapted_input:job.adapted_input,
        execution_plan:job.execution_plan,mask_edit:job.mask_edit,output_asset_ids:job.output_asset_ids},imageData,2));
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
