// Isolated deletion acceptance: simulated recoverable moves, plus one real
// OS recycle-bin call on a freshly created disposable .ediro document.
const {app,BrowserWindow,dialog,shell}=require('electron');
const {mkdir,mkdtemp,readFile,writeFile,stat,rename}=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const base=await mkdtemp(path.join(root,'.local','project-trash-')),runtime=path.join(base,'.local','runtime');
  app.setPath('userData',path.join(base,'electron'));
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const {DocumentRepository}=await import('../dist-host/adapters/document-repository.js');
  const {ProjectRepository}=await import('../dist-host/adapters/project-repository.js');
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
  let controller=await DesktopController.create(runtime,()=>win),choice=0,confirmation,failTrash=false;
  const nativeTrash=shell.trashItem.bind(shell),calls=[],receipts=new Map();await mkdir(path.join(base,'trash'));
  dialog.showMessageBox=async(_window,options)=>{confirmation=options;return {response:choice};};
  const simulatedTrash=async filename=>{
    const resolved=path.resolve(filename),relative=path.relative(base,resolved);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'test trash must stay inside its isolated root');
    calls.push(resolved);if(failTrash)throw Error('模拟回收站拒绝');
    const destination=path.join(base,'trash',path.basename(filename));await rename(resolved,destination);receipts.set(filename,destination);
  };
  shell.trashItem=simulatedTrash;
  const source=path.join(base,'source.png');await writeFile(source,await require('sharp')({create:{width:12,height:12,channels:3,background:'#456'}}).png().toBuffer());
  const materialize=async()=>{const result=await controller.execute({type:'assets:drop',paths:[source]});assert.ok(result.ok,result.error);return result;};
  await materialize();
  const first=await controller.view(),firstFile=first.project_location,firstId=first.project_record_id;
  let recipe=structuredClone(controller.workspace.project.recipe);recipe.modules[0].user_instruction='取消删除前的编辑';await controller.workspace.saveRecipe(recipe);
  let result=await controller.execute({type:'workspace:remove',id:firstId});assert.ok(result.cancelled);assert.equal((await controller.view()).project_location,firstFile);assert.equal(calls.length,0);assert.ok(confirmation.detail.includes(firstFile));
  result=await controller.execute({type:'project:create',name:'保留项目'});assert.ok(result.ok,result.error);result=await materialize();const secondFile=result.state.project_location,secondId=result.state.project_record_id;
  await mkdir(path.join(base,'output'));const exported=path.join(base,'output','导出图.png');await writeFile(exported,'independent export');
  choice=1;result=await controller.execute({type:'workspace:remove',id:firstId});assert.ok(result.ok,result.error);assert.equal(result.state.project_location,secondFile);assert.ok(!result.state.recent_workspaces.some(r=>r.id===firstId));await assert.rejects(()=>stat(firstFile),/ENOENT/);assert.equal(await readFile(exported,'utf8'),'independent export');
  await rename(receipts.get(firstFile),firstFile);await controller.openProjectFile(firstFile);assert.ok((await controller.view()).recent_workspaces.some(r=>r.id===firstId));assert.equal(controller.workspace.project.recipe.modules[0].user_instruction,'取消删除前的编辑');
  failTrash=true;result=await controller.execute({type:'workspace:remove',id:firstId});assert.equal(result.ok,false);assert.match(result.error,/模拟回收站拒绝/);assert.equal(result.state.project_location,firstFile);assert.ok(result.state.recent_workspaces.some(r=>r.id===firstId));assert.ok(await stat(firstFile));failTrash=false;
  const repo=controller.workspace.repository,save=repo.save.bind(repo);recipe=structuredClone(controller.workspace.project.recipe);recipe.modules[0].user_instruction='删除前必须补存';await controller.workspace.saveRecipe(recipe);repo.save=async()=>{throw Error('模拟补存失败');};
  const callCount=calls.length;result=await controller.execute({type:'workspace:remove',id:firstId});assert.equal(result.ok,false);assert.match(result.error,/模拟补存失败/);assert.equal(calls.length,callCount);assert.equal(controller.workspace.repository,repo);repo.save=save;
  result=await controller.execute({type:'workspace:remove',id:firstId});assert.ok(result.ok,result.error);assert.notEqual(result.state.project_location,firstFile);assert.equal(result.state.project_format,'draft');assert.equal(result.state.project_location,null);assert.ok(!result.state.recent_workspaces.some(r=>r.id===firstId));
  const recycled=await DocumentRepository.open(receipts.get(firstFile),path.join(base,'verify-cache'));assert.equal((await recycled.load()).recipe.modules[0].user_instruction,'删除前必须补存');await recycled.close();
  await rename(secondFile,secondFile+'.moved');const beforeMissing=calls.length;result=await controller.execute({type:'workspace:remove',id:secondId});assert.ok(result.ok,result.error);assert.equal(calls.length,beforeMissing);assert.match(confirmation.message,/已不存在/);assert.ok(!result.state.recent_workspaces.some(r=>r.id===secondId));
  // A path replaced by a directory must never expand file deletion into a
  // recursive directory deletion, even if it still ends in .ediro.
  await materialize();const suspect=await controller.view();await controller.execute({type:'project:create',name:'边界检查'});await rename(suspect.project_location,suspect.project_location+'.moved');await mkdir(suspect.project_location);
  const beforeBoundary=calls.length;result=await controller.execute({type:'workspace:remove',id:suspect.project_record_id});assert.equal(result.ok,false);assert.equal(calls.length,beforeBoundary);assert.ok((await stat(suspect.project_location)).isDirectory());
  const legacyDir=await controller.projects.createDirectory(),legacyId=path.basename(legacyDir),legacyProject=structuredClone(controller.workspace.project);
  await new ProjectRepository(legacyDir).create(legacyProject);
  const originalLegacy=path.join(runtime,'workspaces',legacyId);await new ProjectRepository(originalLegacy).create(legacyProject);
  await mkdir(path.join(base,'input',legacyId),{recursive:true});await writeFile(path.join(base,'input',legacyId,'kept.txt'),'external input');
  result=await controller.execute({type:'workspace:resume',id:legacyId});assert.ok(result.ok,result.error);
  result=await controller.execute({type:'workspace:remove',id:legacyId});assert.ok(result.ok,result.error);await assert.rejects(()=>stat(legacyDir),/ENOENT/);assert.equal(await readFile(path.join(base,'input',legacyId,'kept.txt'),'utf8'),'external input');
  const active=(await controller.view()).project_location;await controller.shutdown();controller=await DesktopController.create(runtime,()=>win);assert.equal((await controller.view()).project_format,'draft');assert.equal((await controller.view()).project_location,null);await assert.rejects(()=>stat(legacyDir),/ENOENT/);assert.ok(!(await controller.view()).recent_workspaces.some(r=>[firstId,secondId,legacyId].includes(r.id)));
  // Exercise Electron's actual OS trash operation only for the new test file.
  await materialize();const disposable=await controller.view();assert.ok(path.relative(base,disposable.project_location).startsWith('Project'+path.sep));
  shell.trashItem=async filename=>{assert.equal(filename,disposable.project_location);await nativeTrash(filename);};
  result=await controller.execute({type:'workspace:remove',id:disposable.project_record_id});assert.ok(result.ok,result.error);await assert.rejects(()=>stat(disposable.project_location),/ENOENT/);
  await controller.shutdown();win.destroy();
  const report={passed:true,base,checks:['cancel','noncurrent-trash','current-flush-and-switch','trash-failure-rollback','save-failure-no-trash','restore-and-reopen','missing-file-cleanup','replaced-path-guard','legacy-folder-trash','keep-exports-and-inputs','restart-no-remigration','native-os-recycle-bin']};
  await writeFile(path.join(root,'.local','project-trash-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
