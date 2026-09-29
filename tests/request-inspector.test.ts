import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('独立排查工具按结果查找实际请求，保留原始记录并明确区分快照与缺失请求',async()=>{
  const base=path.resolve('.local/test-projects');await mkdir(base,{recursive:true});
  const directory=await mkdtemp(path.join(base,'inspect-'));await mkdir(path.join(directory,'model-inputs'));
  const project={name:'排查测试',assets:[{asset_id:'asset_one',name:'result.png'}],jobs:[
    {task_id:'task_one',output_asset_ids:['asset_one'],model_snapshot:{title:'测试模型'},recipe_snapshot:{prompt:'旧配方'},chain_snapshot:{blocks:[]}},
    {task_id:'task_missing',output_asset_ids:[],recipe_snapshot:{prompt:'只有快照'}},
  ]};
  const request={version:1,body:{encoding:'json',json:JSON.stringify({contents:[{parts:[{text:'实际调优文字'},{inlineData:{mimeType:'image/png',data:'YWJj'}}]}]})}};
  const manifest=JSON.stringify(project),captured=JSON.stringify(request);
  const capturePath=path.join(directory,'model-inputs','task_one.json');
  await writeFile(path.join(directory,'ediro.project.json'),manifest);await writeFile(capturePath,captured);
  const run=async(...args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,[path.resolve('scripts/inspect-request.mjs'),directory,...args])).stdout);
  const list=await run();assert.equal(list.jobs[0].results[0].name,'result.png');
  for(const selector of ['task_one','asset_one','result.png']){
    const result=await run(selector);assert.equal(result.task_id,'task_one');
    const parts=result.captured_request.body.json.contents[0].parts;
    assert.equal(parts[0].text,'实际调优文字');assert.match(parts[1].inlineData.data,/Base64：4/);
  }
  assert.deepEqual((await run('task_one','--raw')).captured_request,request);
  const missing=await run('task_missing');assert.equal(missing.captured_request,null);assert.match(missing.capture_status,/未重新编译/);
  await assert.rejects(()=>run('unknown'),/未找到记录/);
  assert.equal(await readFile(path.join(directory,'ediro.project.json'),'utf8'),manifest);
  assert.equal(await readFile(capturePath,'utf8'),captured);
});
