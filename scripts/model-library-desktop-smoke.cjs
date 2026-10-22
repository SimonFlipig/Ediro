// Exercise the real renderer and model-library IPC using an isolated library.
// Discovery is stubbed; paid generation and real provider requests are forbidden.
const {app,BrowserWindow,ipcMain}=require('electron');
const {mkdtemp,mkdir,writeFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
let failureWindow,failureBase;
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const base=await mkdtemp(path.join(root,'.local','model-library-ui-'));failureBase=base;app.setPath('userData',path.join(base,'electron'));
  const {DesktopController}=await import('../dist-host/desktop/controller.js');
  const win=new BrowserWindow({width:1775,height:1050,show:false,webPreferences:{preload:path.join(root,'dist-host/desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});failureWindow=win;
  let controller=await DesktopController.create(path.join(base,'.local/runtime'),()=>win);
  controller.executors.execute=async()=>{throw Error('Paid model execution forbidden');};
  const discovered=['gemini-3-pro-image-preview','gemini-3.1-pro-preview','gpt-image-2.5-sunburst',...Array.from({length:200},(_,i)=>`studio-${String(i).padStart(3,'0')}`),'studio-second'];
  let probes=0,saves=0,failRemote='studio-150',failConnection=false;const attempts=[];
  ipcMain.handle('ediro:update',()=>({status:'idle'}));
  ipcMain.handle('ediro:command',async(_event,command)=>{
    if(command.type==='model:save'||command.type==='connection:save')saves++;
    if(command.type==='connection:probe'){probes++;return {ok:true,state:await controller.view(),discovered_models:discovered};}
    if(command.type==='connection:save'&&failConnection)return {ok:false,error:'模拟平台保存失败'};
    if(command.type==='model:save'){attempts.push(command.model.model);if(command.model.model===failRemote)return {ok:false,error:'模拟第二项保存失败'};}
    return controller.execute(command);
  });
  const js=async code=>{const result=await win.webContents.executeJavaScript(`(()=>{try{return {ok:true,value:(${code})};}catch(error){return {ok:false,error:error.stack??String(error)};}})()`);if(!result.ok)throw Error(result.error);return result.value;};
  const until=async(check,label)=>{for(let i=0;i<180;i++){if(await check())return;await wait(40);}throw Error('Timeout: '+label);};
  const click=async(label,scope='.global-settings')=>{await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>(b.textContent===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)})&&b.getClientRects().length);if(!el||el.disabled||el.closest('[inert]'))throw Error('Button unavailable: '+${JSON.stringify(label)});el.click();})()`);await wait(50);};
  const field=async(label,value,tag='input',scope='.global-settings')=>{await js(`(()=>{const label=[...document.querySelectorAll(${JSON.stringify(scope+' label')})].find(l=>l.textContent.startsWith(${JSON.stringify(label)})&&l.getClientRects().length);const el=label?.querySelector(${JSON.stringify(tag)});if(!el)throw Error('Field missing: '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(${tag==='select'?'HTMLSelectElement':'HTMLInputElement'}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(${JSON.stringify(tag==='select'?'change':'input')},{bubbles:true}));})()`);await wait(30);};
  const optionalNumber=async(label,value)=>{
    const input=`[...document.querySelectorAll('.global-settings input[type=number]')].find(el=>el.getAttribute('aria-label')===${JSON.stringify(label)}&&el.getClientRects().length&&!el.closest('[inert]'))`;
    // A hidden renderer still needs focus for native editing and Tab's focusout.
    win.webContents.focus();await js(`(()=>{const el=${input};if(!el)throw Error('Number missing: '+${JSON.stringify(label)});el.focus();el.select();})()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'});await until(()=>js(`(${input})?.value===''`),'clear '+label);
    if(value)await win.webContents.insertText(value);await until(()=>js(`(${input})?.value===${JSON.stringify(value)}`),'type '+label);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await wait(100);
    await until(()=>js(`document.querySelector('.global-settings .settings-status')?.textContent==='未保存'`),'number draft '+label);
  };
  const checkbox=async(label,scope='.global-settings')=>{await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(scope+' label')})].find(l=>l.textContent.trim()===${JSON.stringify(label)}&&l.getClientRects().length)?.querySelector('input[type=checkbox]');if(!el)throw Error('Checkbox missing: '+${JSON.stringify(label)});el.click();})()`);await wait(40);};
  const details=async(label)=>{await js(`(()=>{const el=[...document.querySelectorAll('.global-settings summary')].find(s=>s.textContent===${JSON.stringify(label)}&&s.getClientRects().length);if(!el)throw Error('Details missing: '+${JSON.stringify(label)});if(!el.parentElement.open)el.click();})()`);await wait(30);};
  const selectModel=async id=>{await js(`document.querySelector('[data-model-id="${id}"]').click()`);await wait(50);};
  const capture=async name=>{await win.webContents.capturePage(undefined,{stayHidden:true});await js(`(()=>{for(const animation of document.getAnimations()){try{animation.finish();}catch{}}})()`);await wait(150);await writeFile(path.join(base,name),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG());};
  const confirmation='.enrollment-confirmation',detail='.settings-model-detail',platformForm='.settings-platform-editor';
  const filterRemote=async value=>{await js(`(()=>{const el=document.querySelector('.settings-enrollment input[aria-label="筛选模型"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(60);};
  const rowSelector=id=>`[data-remote-id=${JSON.stringify(id)}]`;
  const addRemote=async id=>{await js(`(()=>{const row=document.querySelector(${JSON.stringify(rowSelector(id))});const button=row?.querySelector('button');if(!button||button.disabled)throw Error('Remote model unavailable: '+${JSON.stringify(id)});row.scrollIntoView({block:'center'});button.click();})()`);await until(()=>js(`!!document.querySelector('${confirmation}')`),'open inline confirmation');};
  const confirmationFamily=()=>js(`document.querySelector('${confirmation} select[aria-label="模型家族"]')?.value`);
  const keyboardClick=async(label,scope)=>{
    win.webContents.focus();await js(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent===${JSON.stringify(label)});if(!button||button.disabled)throw Error('Keyboard button unavailable');button.focus();})()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await wait(100);
    // Hidden windows need a compositor frame to run the UI's deferred focus restoration.
    await win.webContents.capturePage(undefined,{stayHidden:true});await wait(50);
  };
  const scrollPositions=()=>js(`Object.fromEntries([...document.querySelectorAll('.settings-models,.discovery-list')].map(el=>[el.className,el.scrollTop]))`);
  const confirmRemote=async()=>{await click('确认添加',confirmation);await until(()=>js(`!document.querySelector('${confirmation}')`),'confirmed remote model');};
  const visible=selector=>js(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const selectedId=()=>js(`document.querySelector('.settings-model-row.selected')?.dataset.modelId`);
  const fieldValue=(label,tag='input',scope=detail)=>js(`[...document.querySelectorAll(${JSON.stringify(scope+' label')})].find(l=>l.textContent.startsWith(${JSON.stringify(label)}))?.querySelector(${JSON.stringify(tag)})?.value`);
  const threeColumns=async()=>{assert.equal(await js(`document.querySelectorAll('.settings-columns > :not([hidden])').length`),3);assert.equal(await visible(detail),true);assert.equal(await js(`document.querySelectorAll('.settings-flow,.settings-drawer-layer,dialog.enrollment-dialog').length`),0);};
  const choosePlatform=async title=>{await js(`(()=>{const button=[...document.querySelectorAll('.platform-row')].find(b=>b.querySelector('b')?.textContent===${JSON.stringify(title)});if(!button)throw Error('Platform missing: '+${JSON.stringify(title)});button.click();})()`);await wait(70);};
  const waitGuard=()=>until(()=>visible('.app-dialog'),'unsaved guard');
  const picker='dialog.model-platform-picker';
  const openPicker=async()=>{await keyboardClick('＋ 添加模型','.settings-library-heading');await until(()=>js(`document.querySelector('${picker}')?.open===true`),'open platform picker');};
  const pickConnection=async id=>{await js(`(()=>{const button=[...document.querySelectorAll('${picker} [data-connection-id]')].find(el=>el.dataset.connectionId===${JSON.stringify(id)});if(!button||button.disabled)throw Error('Picker platform unavailable: '+${JSON.stringify(id)});button.click();})()`);await until(async()=>!await visible(picker),'close platform picker after selection');};
  const activePlatform=()=>js(`document.querySelector('.platform-row[aria-pressed=true] b')?.textContent`);
  const waitPickerFocus=()=>until(()=>js(`document.activeElement?.textContent==='＋ 添加模型'`),'platform picker returns entry focus');
  const library=()=>controller.workspace.models.snapshot();
  await win.loadFile(path.join(root,'dist/index.html'));await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'startup');await js(`document.querySelector('.settings-button').click()`);
  await until(()=>visible(detail),'settings');await selectModel('model_nano_pro');await threeColumns();
  const beforeRecipe=structuredClone(controller.workspace.project?.recipe);
  await field('默认画面比例','16:9','select',detail);await selectModel('model_image_2');await waitGuard();await click('继续编辑','.app-dialog');
  assert.equal(await selectedId(),'model_nano_pro');await selectModel('model_image_2');await click('保存并切换','.app-dialog');
  await until(async()=>await selectedId()==='model_image_2','save and switch');assert.equal(library().models.find(m=>m.model_config_id==='model_nano_pro').defaults.aspect_ratio,'16:9');assert.deepEqual(controller.workspace.project?.recipe,beforeRecipe);
  await click('接入设置',detail);await field('模型显示名称','临时名称','input',detail);await click('还原修改',detail);assert.equal(await js(`document.querySelector('.settings-status').textContent`),'待配置');
  await click('默认参数',detail);await click('设为默认编辑模型',detail);await until(()=>Promise.resolve(library().assignments.editing_default==='model_image_2'),'default editing');

  // Creating a platform opens its form inside the middle column and stays in the library.
  await click('＋ 添加平台');await threeColumns();await field('平台名称','三栏测试平台','input',platformForm);await field('API 地址','https://model-library.example','input',platformForm);await field('API Key','test-only-local','input',platformForm);await click('保存平台',platformForm);
  await until(()=>visible('.settings-enrollment'),'platform to inline enrollment');await threeColumns();assert.equal(probes,0);
  assert.equal(await js(`document.querySelectorAll('.settings-enrollment select[aria-label="添加到平台"]').length`),0);
  assert.equal(await js(`[...document.querySelectorAll('.settings-enrollment select[aria-label="模型家族"]')].filter(el=>el.getClientRects().length).length`),0);
  await click('获取模型列表','.settings-enrollment');await until(()=>js(`document.querySelectorAll('[data-remote-id]').length===${discovered.length}`),'unfiltered discovery');assert.equal(probes,1);
  assert.deepEqual(await js(`[...document.querySelectorAll('[data-remote-id]')].map(row=>row.dataset.remoteId)`),discovered);
  assert.equal(await js(`document.querySelectorAll('.discovery-row input[type=checkbox],.discovery-row select,.settings-enrollment .settings-savebar button').length`),0);
  assert.equal(await js(`[...document.querySelectorAll('[data-remote-id]')].every(row=>row.querySelector('button')?.getAttribute('aria-label')==='添加 '+row.dataset.remoteId+' 到模型库')`),true);
  const connection=library().connections.find(c=>c.title==='三栏测试平台');assert.ok(connection);
  const modelsOnConnection=()=>library().models.filter(m=>m.connection_id===connection.connection_id);
  const savesBeforeCancel=attempts.length;await addRemote('gemini-3.1-pro-preview');assert.equal(await confirmationFamily(),'reasoning');await click('取消',confirmation);assert.equal(attempts.length,savesBeforeCancel);assert.equal(modelsOnConnection().length,0);
  await addRemote('gemini-3-pro-image-preview');assert.equal(await confirmationFamily(),'nano');await confirmRemote();assert.equal(modelsOnConnection().length,1);
  const first=()=>modelsOnConnection().find(m=>m.model==='gemini-3-pro-image-preview');
  await until(async()=>await selectedId()===first().model_config_id,'first model selected');await threeColumns();assert.equal(await visible('.settings-enrollment'),true);
  assert.equal(await js(`document.querySelector(${JSON.stringify(rowSelector('gemini-3-pro-image-preview')+' button')}).disabled`),true);assert.equal(await js(`document.querySelector(${JSON.stringify(rowSelector('gemini-3-pro-image-preview')+' button')}).textContent`),'已在模型库');
  assert.equal(attempts.filter(id=>id==='gemini-3-pro-image-preview').length,1);

  // Opening and collapsing both inline tools must not remount the parameter editor.
  await field('默认画面比例','4:3','select',detail);await click('平台设置');await until(()=>visible(platformForm),'inline platform settings');await threeColumns();assert.equal(await fieldValue('默认画面比例','select'),'4:3');
  await click('收起平台设置',platformForm);assert.equal(await fieldValue('默认画面比例','select'),'4:3');
  if(!await visible('.settings-enrollment'))await click('＋ 添加模型');
  assert.equal(await js(`document.querySelectorAll('[data-remote-id]').length`),discovered.length);await click('收起添加','.settings-enrollment');assert.equal(await fieldValue('默认画面比例','select'),'4:3');await click('＋ 添加模型');
  await filterRemote('studio-');await until(()=>js(`document.querySelectorAll('[data-remote-id]').length===201`),'filtered discovery');
  await addRemote('studio-150');assert.equal(await confirmationFamily(),'');assert.equal(await js(`document.querySelector('${confirmation} select option[value=""]').textContent`),'请选择模型家族');assert.equal(await js(`[...document.querySelectorAll('${confirmation} button')].find(b=>b.textContent==='确认添加').disabled`),true);await click('取消',confirmation);assert.equal(attempts.filter(id=>id==='studio-150').length,0);
  await addRemote('studio-150');await field('模型家族','nano','select',confirmation);await threeColumns();assert.equal(await js(`document.querySelector('${confirmation}').closest('[data-remote-id]').dataset.remoteId`),'studio-150');
  win.webContents.focus();await js(`document.querySelector('${confirmation} select').focus()`);const focusNames=[];
  for(let i=0;i<4;i++){focusNames.push(await js(`document.activeElement?.tagName==='SELECT'?'模型家族':document.activeElement?.textContent?.trim()`));win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await wait(40);}
  for(const name of ['模型家族','取消','确认添加'])assert.ok(focusNames.includes(name),'inline confirmation keyboard reaches '+name);
  await capture('inline-confirmation.png');
  await click('确认添加',confirmation);await until(()=>js(`!!document.querySelector('${confirmation} [role=alert]')?.textContent`),'failed single enrollment');assert.equal(await confirmationFamily(),'nano');assert.equal(modelsOnConnection().length,1);
  const scrollBefore=await scrollPositions();failRemote='';await confirmRemote();
  assert.equal(modelsOnConnection().filter(m=>m.model==='studio-150').length,1);assert.equal(attempts.filter(id=>id==='studio-150').length,2);assert.equal(await js(`document.querySelector('.settings-enrollment input[aria-label="筛选模型"]').value`),'studio-');
  const scrollAfter=await scrollPositions();for(const key of Object.keys(scrollBefore))assert.ok(Math.abs(scrollAfter[key]-scrollBefore[key])<=2,'list scroll preserved: '+key);
  assert.equal(await selectedId(),first().model_config_id);assert.equal(await fieldValue('默认画面比例','select'),'4:3');assert.equal(await js(`document.querySelectorAll('[data-remote-id]').length`),201);assert.equal(modelsOnConnection().find(m=>m.model==='studio-150').family,'nano');await capture('remote-list-preserved.png');
  await click('收起添加','.settings-enrollment');await click('＋ 添加模型');assert.equal(await js(`document.querySelector('.settings-enrollment input[aria-label="筛选模型"]').value`),'studio-');assert.equal(await js(`document.querySelectorAll('[data-remote-id]').length`),201);
  await addRemote('studio-151');assert.equal(await confirmationFamily(),'');await field('模型家族','reasoning','select',confirmation);await confirmRemote();assert.equal(modelsOnConnection().find(m=>m.model==='studio-151').family,'reasoning');assert.equal(modelsOnConnection().find(m=>m.model==='studio-151').purpose,'understanding');
  await click('手动添加','.settings-enrollment');await field('模型家族','nano','select','.settings-enrollment');await field('平台模型 ID','private-alias','input','.settings-enrollment');await click('添加到模型库','.settings-enrollment');await until(()=>Promise.resolve(modelsOnConnection().length===4),'manual enrollment');
  const alias=modelsOnConnection().find(m=>m.model==='private-alias');assert.equal(alias.family,'nano');assert.equal(alias.preset_id,undefined);assert.equal(alias.independent_defaults,true);assert.equal(await visible('.settings-enrollment'),true);assert.equal(await selectedId(),first().model_config_id);assert.equal(await fieldValue('默认画面比例','select'),'4:3');
  await click('收起添加','.settings-enrollment');await click('保存设置',detail);await until(()=>Promise.resolve(first().defaults.aspect_ratio==='4:3'),'retained parameter draft saved');

  // A platform change protects both independent drafts; continuing keeps both intact.
  const firstTitle=first().title;
  await click('接入设置',detail);await field('模型显示名称','双草稿模型待放弃','input',detail);await click('平台设置');await field('平台名称','双草稿平台待放弃','input',platformForm);await choosePlatform('全部模型');await waitGuard();await click('继续编辑','.app-dialog');
  assert.equal(await fieldValue('模型显示名称'),'双草稿模型待放弃');assert.equal(await fieldValue('平台名称','input',platformForm),'双草稿平台待放弃');
  await choosePlatform('全部模型');await waitGuard();await click('放弃并切换','.app-dialog');await until(()=>js(`document.querySelector('.platform-row[aria-pressed=true] b')?.textContent==='全部模型'`),'discard both drafts');assert.equal(first().title,firstTitle);assert.equal(library().connections.find(c=>c.connection_id===connection.connection_id).title,'三栏测试平台');
  await choosePlatform('三栏测试平台');await selectModel(first().model_config_id);await click('接入设置',detail);await field('模型显示名称','双草稿模型已保存','input',detail);await click('平台设置');await field('平台名称','三栏测试平台已保存','input',platformForm);await choosePlatform('全部模型');await waitGuard();await click('保存并切换','.app-dialog');
  await until(()=>js(`document.querySelector('.platform-row[aria-pressed=true] b')?.textContent==='全部模型'`),'save both drafts');assert.equal(first().title,'双草稿模型已保存');assert.equal(library().connections.find(c=>c.connection_id===connection.connection_id).title,'三栏测试平台已保存');
  await choosePlatform('三栏测试平台已保存');await selectModel(first().model_config_id);await click('接入设置',detail);await field('模型显示名称','失败重试后保存的模型','input',detail);await click('平台设置');await field('平台名称','三栏测试平台重试','input',platformForm);failConnection=true;await choosePlatform('全部模型');await waitGuard();await click('保存并切换','.app-dialog');
  await until(()=>js(`!!document.querySelector('.app-dialog [role=alert]')?.textContent`),'both-draft save failure');await click('继续编辑','.app-dialog');assert.equal(await fieldValue('模型显示名称'),'失败重试后保存的模型');assert.equal(await fieldValue('平台名称','input',platformForm),'三栏测试平台重试');assert.equal(await selectedId(),first().model_config_id);
  failConnection=false;await choosePlatform('全部模型');await waitGuard();await click('保存并切换','.app-dialog');await until(()=>js(`document.querySelector('.platform-row[aria-pressed=true] b')?.textContent==='全部模型'`),'retry both drafts');assert.equal(first().title,'失败重试后保存的模型');assert.equal(library().connections.find(c=>c.connection_id===connection.connection_id).title,'三栏测试平台重试');

  // Reopening and saving a platform with an empty key field preserves its stored key.
  await choosePlatform('三栏测试平台重试');await click('平台设置');assert.equal(await fieldValue('API Key','input',platformForm),'');await field('平台名称','三栏测试平台最终','input',platformForm);await click('保存平台',platformForm);await until(async()=>!await visible(platformForm),'save platform inline');
  const publicConnection=(await controller.view()).connections.find(c=>c.connection_id===connection.connection_id);assert.equal(publicConnection.has_credential,true);
  await click('平台设置');assert.equal(await js(`document.querySelector('${platformForm} input[type=password]').placeholder`),'已加密保存，留空保留');await click('保存平台',platformForm);await until(async()=>!await visible(platformForm),'repeat empty-key save');
  assert.equal((await controller.view()).connections.find(c=>c.connection_id===connection.connection_id).has_credential,true);await click('＋ 添加模型');await until(()=>visible('.settings-enrollment'),'key remains configured');await threeColumns();
  await click('收起添加','.settings-enrollment');await click('接入设置',detail);await field('模型显示名称','不应保存','input',detail);await click('返回工作台');await waitGuard();await click('放弃并切换','.app-dialog');await until(async()=>!await visible('.global-settings'),'close guard');assert.ok(!library().models.some(m=>m.title==='不应保存'));

  // Chat enrollment remains text-first and preserves optional model settings.
  await js(`document.querySelector('.settings-button').click()`);await until(()=>visible('.settings-columns'),'reopen');await click('＋ 添加平台');await field('平台名称','兼容推理测试平台','input',platformForm);await field('接口类型','openai-chat-completions','select',platformForm);await field('API 地址','https://chat-library.example/v1','input',platformForm);await field('API Key','test-only-chat','input',platformForm);await click('保存平台',platformForm);await until(()=>visible('.settings-enrollment'),'chat enrollment');assert.equal(probes,1);
  await click('获取模型列表','.settings-enrollment');await until(()=>js(`document.querySelectorAll('[data-remote-id]').length===${discovered.length}`),'chat discovery');assert.equal(probes,2);await filterRemote('studio-second');await addRemote('studio-second');assert.equal(await confirmationFamily(),'reasoning');await checkbox('此模型支持图片理解',confirmation);assert.equal(await js(`document.querySelector('${confirmation} input[type=checkbox]').checked`),true);await click('取消',confirmation);assert.equal(attempts.filter(id=>id==='studio-second').length,0);
  await click('手动添加','.settings-enrollment');assert.equal(await fieldValue('模型家族','select','.enrollment-manual'),'reasoning');await field('平台模型 ID','studio-reasoner','input','.settings-enrollment');await click('添加到模型库','.settings-enrollment');await until(()=>Promise.resolve(library().models.some(m=>m.model==='studio-reasoner')),'text reasoning enrolled');
  const reasoning=library().models.find(m=>m.model==='studio-reasoner');await until(async()=>await selectedId()===reasoning.model_config_id,'chat first model selected');assert.equal(reasoning.purpose,'understanding');assert.equal(reasoning.family,'reasoning');assert.equal(reasoning.capabilities.max_images,0);assert.equal(reasoning.independent_defaults,true);assert.equal(await visible('.settings-enrollment'),true);
  assert.equal(await js(`document.querySelector('input[aria-label="温度"]').value`),'');assert.equal(await js(`document.querySelector('${detail}').textContent.includes('Google 搜索')`),false);assert.equal(await js(`document.querySelectorAll('[aria-label="对应模型预设"]').length`),0);
  await optionalNumber('温度','0.25');await click('保存设置',detail);await until(()=>Promise.resolve(library().models.find(m=>m.model_config_id===reasoning.model_config_id).defaults.extensions?.['openai-chat-completions']?.temperature===0.25),'optional number set');
  await optionalNumber('温度','');await click('保存设置',detail);await until(()=>Promise.resolve(library().models.find(m=>m.model_config_id===reasoning.model_config_id).defaults.extensions?.['openai-chat-completions']?.temperature===undefined),'optional number omitted');assert.equal(await js(`document.querySelector('input[aria-label="温度"]').value`),'');
  await click('接入设置',detail);await details('当前接口兼容设置');await checkbox('此模型支持图片理解',detail);await field('渠道参考图上限','4','input',detail);await click('保存设置',detail);await until(()=>Promise.resolve(library().models.find(m=>m.model_config_id===reasoning.model_config_id).capabilities.max_images===4),'enable vision');
  await checkbox('此模型支持图片理解',detail);await click('保存设置',detail);await until(()=>Promise.resolve(library().models.find(m=>m.model_config_id===reasoning.model_config_id).capabilities.max_images===0),'disable vision');await details('模型信息与能力');assert.equal(await js(`document.querySelector('${detail}').textContent.includes('仅文字推理。')`),true);
  await checkbox('此模型支持图片理解',detail);await click('保存设置',detail);await until(()=>Promise.resolve(library().models.find(m=>m.model_config_id===reasoning.model_config_id).capabilities.max_images===4),'restore vision limit');await click('设为默认推理模型',detail);await until(()=>Promise.resolve(library().assignments.understanding_default===reasoning.model_config_id),'chat default assignment');
  await field('平台模型 ID','studio-vision','input','.settings-enrollment');await checkbox('此模型支持图片理解','.settings-enrollment');await capture('chat-enrollment.png');await click('添加到模型库','.settings-enrollment');await until(()=>Promise.resolve(library().models.some(m=>m.model==='studio-vision')),'vision reasoning enrolled');assert.equal(library().models.find(m=>m.model==='studio-vision').capabilities.max_images,8);assert.equal(await selectedId(),reasoning.model_config_id);assert.equal(probes,2);await capture('chat-model-settings.png');

  await choosePlatform('三栏测试平台最终');await selectModel(first().model_config_id);await click('平台设置');await capture('inline-platform.png');await click('收起平台设置',platformForm);await click('＋ 添加模型');await click('获取模型列表','.settings-enrollment');await until(()=>js(`document.querySelectorAll('[data-remote-id]').length===${discovered.length}`),'layout discovery');await filterRemote('studio-199');await addRemote('studio-199');await field('模型家族','nano','select',confirmation);
  for(const width of [1775,1120,800]){win.setSize(width,1050);await wait(100);await threeColumns();const overflow=await js(`(()=>{const nodes=[...document.querySelectorAll('.settings-platforms,.settings-models,.settings-model-detail,.settings-enrollment,.enrollment-confirmation')];return nodes.filter(n=>n.getClientRects().length&&n.scrollWidth>n.clientWidth+2).map(n=>n.className);})()`);assert.deepEqual(overflow,[],`inline content overflow at ${width}`);await capture(`inline-layout-${width}.png`);}
  win.setSize(1775,1050);await wait(100);
  await js(`document.querySelector('.settings-enrollment input[aria-label="筛选模型"]').focus()`);
  await filterRemote('no-such-model');await filterRemote('studio-199');
  assert.equal(await visible(confirmation),false);assert.equal(await js(`document.activeElement?.getAttribute('aria-label')`),'筛选模型');
  await keyboardClick('收起添加','.settings-enrollment');assert.equal(await js(`document.activeElement?.textContent`),'＋ 添加模型');
  await click('平台设置');await keyboardClick('收起平台设置',platformForm);assert.equal(await js(`document.activeElement?.getAttribute('aria-label')`),'平台设置');

  // Removing a just-enrolled model also clears its row membership in the still-mounted list.
  await click('＋ 添加模型');await filterRemote('studio-151');
  const removed=modelsOnConnection().find(m=>m.model==='studio-151');await selectModel(removed.model_config_id);await click('移除接入',detail);await click('确认移除','.app-dialog');
  await until(()=>Promise.resolve(!modelsOnConnection().some(m=>m.model_config_id===removed.model_config_id)),'remove enrolled model');
  await addRemote('studio-151');await field('模型家族','reasoning','select',confirmation);await confirmRemote();
  assert.equal(modelsOnConnection().filter(m=>m.model==='studio-151').length,1);
  await win.webContents.capturePage(undefined,{stayHidden:true});
  await until(()=>js(`document.activeElement?.getAttribute('data-remote-id')==='studio-151'`),'successful row focus');

  // Saving through the unsaved guard must invalidate candidates from the old endpoint too.
  await click('平台设置');await field('API 地址','https://changed-library.example/v1beta','input',platformForm);await click('收起平台设置',platformForm);await waitGuard();await click('保存并切换','.app-dialog');
  await until(async()=>!await visible(platformForm),'guard-saved platform collapsed');await click('＋ 添加模型');
  assert.equal(await js(`document.querySelectorAll('[data-remote-id]').length`),0);assert.equal(probes,3);
  await click('收起添加','.settings-enrollment');
  await click('＋ 添加平台');await field('平台名称','收起时保存的新平台','input',platformForm);await field('API 地址','https://new-library.example','input',platformForm);await click('收起平台设置',platformForm);await waitGuard();await click('保存并切换','.app-dialog');
  await until(()=>js(`document.querySelector('.settings-platform-title h2')?.textContent==='收起时保存的新平台'`),'new platform stays selected after guard save');

  // All-models enrollment first chooses a platform without saving or probing.
  await choosePlatform('全部模型');await selectModel(first().model_config_id);await field('默认画面比例','16:9','select',detail);
  const pickerBefore={library:structuredClone(library()),saves,probes};await openPicker();
  assert.equal(await activePlatform(),'全部模型');assert.equal(await selectedId(),first().model_config_id);assert.equal(await fieldValue('默认画面比例','select'),'16:9');
  assert.deepEqual(await js(`[...document.querySelectorAll('${picker} [data-connection-id]')].map(el=>el.dataset.connectionId)`),library().connections.map(c=>c.connection_id));await capture('platform-picker.png');
  win.webContents.focus();await js(`document.querySelector('${picker} button').focus()`);
  for(let i=0;i<library().connections.length+4;i++){win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await wait(40);assert.equal(await js(`!!document.activeElement?.closest('${picker}')`),true,'Tab stays inside platform picker');}
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await until(async()=>!await visible(picker),'Escape closes picker');await win.webContents.capturePage(undefined,{stayHidden:true});await waitPickerFocus();
  await openPicker();await keyboardClick('取消',picker);await waitPickerFocus();
  assert.equal(await activePlatform(),'全部模型');assert.equal(await selectedId(),first().model_config_id);assert.equal(await fieldValue('默认画面比例','select'),'16:9');assert.equal(saves,pickerBefore.saves);assert.equal(probes,pickerBefore.probes);assert.deepEqual(library(),pickerBefore.library);
  await openPicker();await pickConnection(connection.connection_id);await until(()=>visible('.settings-enrollment'),'same-platform selection enrolls inline');
  assert.equal(await activePlatform(),'三栏测试平台最终');assert.equal(await selectedId(),first().model_config_id);assert.equal(await fieldValue('默认画面比例','select'),'16:9');assert.equal(await visible('.app-dialog'),false);assert.equal(saves,pickerBefore.saves);assert.equal(probes,pickerBefore.probes);await threeColumns();

  // A destination that would change the model uses the existing draft guard.
  await click('收起添加','.settings-enrollment');await click('还原修改',detail);await choosePlatform('全部模型');await selectModel(first().model_config_id);await click('接入设置',detail);await field('模型显示名称','平台选择待放弃','input',detail);
  const titleBeforePicker=first().title,chatConnection=library().connections.find(c=>c.title==='兼容推理测试平台');assert.ok(chatConnection);
  await openPicker();await pickConnection(chatConnection.connection_id);await waitGuard();assert.equal(await visible(picker),false);await click('继续编辑','.app-dialog');
  assert.equal(await activePlatform(),'全部模型');assert.equal(await selectedId(),first().model_config_id);assert.equal(await fieldValue('模型显示名称'),'平台选择待放弃');assert.equal(await visible('.settings-enrollment'),false);
  await openPicker();await pickConnection(chatConnection.connection_id);await waitGuard();await click('放弃并切换','.app-dialog');await until(()=>visible('.settings-enrollment'),'discard draft then enroll at chosen platform');
  assert.equal(await activePlatform(),'兼容推理测试平台');assert.equal(first().title,titleBeforePicker);assert.equal(await selectedId(),reasoning.model_config_id);assert.equal(saves,pickerBefore.saves);assert.equal(probes,pickerBefore.probes);
  await click('收起添加','.settings-enrollment');await choosePlatform('全部模型');await selectModel(first().model_config_id);await click('接入设置',detail);await field('模型显示名称','平台选择前保存的模型','input',detail);
  await openPicker();await pickConnection(chatConnection.connection_id);await waitGuard();await click('保存并切换','.app-dialog');await until(()=>visible('.settings-enrollment'),'save draft then enroll at chosen platform');assert.equal(first().title,'平台选择前保存的模型');assert.equal(await activePlatform(),'兼容推理测试平台');assert.equal(probes,pickerBefore.probes);

  // Incomplete platforms go to the existing inline settings form, without discovery.
  await click('收起添加','.settings-enrollment');await choosePlatform('全部模型');const incompleteConnection=library().connections.find(c=>c.title==='收起时保存的新平台');assert.ok(incompleteConnection);
  const savesBeforeIncomplete=saves;await openPicker();await pickConnection(incompleteConnection.connection_id);await until(()=>visible(platformForm),'picker incomplete platform to settings');
  assert.equal(await fieldValue('平台名称','input',platformForm),incompleteConnection.title);assert.equal(await visible('.settings-enrollment'),false);assert.equal(saves,savesBeforeIncomplete);assert.equal(probes,pickerBefore.probes);await threeColumns();
  await click('收起平台设置',platformForm);await choosePlatform('全部模型');await openPicker();await keyboardClick('添加平台',picker);await until(()=>visible(platformForm),'picker add platform to inline form');assert.equal(await visible(picker),false);assert.equal(await fieldValue('平台名称','input',platformForm),'新平台');await click('收起平台设置',platformForm);await waitGuard();await click('放弃并切换','.app-dialog');assert.equal(await activePlatform(),'全部模型');

  // A second isolated library has local models but no platform or credentials.
  // Reload the same renderer against this fixture; never read the real user's runtime.
  const emptyLibrary=structuredClone(library()),mock=emptyLibrary.models.find(m=>m.kind==='mock');assert.ok(mock);
  emptyLibrary.connections=[];emptyLibrary.models=emptyLibrary.models.filter(m=>m.kind!=='cloud');emptyLibrary.assignments={generation_default:mock.model_config_id};
  const emptyRuntime=path.join(base,'empty-platforms','.local','runtime');await mkdir(emptyRuntime,{recursive:true});await writeFile(path.join(emptyRuntime,'model-library.v3.json'),JSON.stringify(emptyLibrary));
  await controller.shutdown();controller=await DesktopController.create(emptyRuntime,()=>win,{deferStartup:true});controller.executors.execute=async()=>{throw Error('Paid model execution forbidden');};
  await win.loadFile(path.join(root,'dist/index.html'));await until(()=>js(`document.querySelector('.settings-button')?.disabled===false`),'empty-platform startup');await js(`document.querySelector('.settings-button').click()`);await until(()=>visible(detail),'empty-platform settings');
  const emptyBefore={saves,probes,library:structuredClone(library())};await openPicker();assert.equal(await js(`document.querySelector('${picker}').textContent.includes('先添加一个平台')`),true);assert.equal(await js(`document.querySelectorAll('${picker} [data-connection-id]').length`),0);await capture('platform-picker-empty.png');
  await keyboardClick('取消',picker);await waitPickerFocus();assert.equal(await activePlatform(),'全部模型');assert.equal(saves,emptyBefore.saves);assert.equal(probes,emptyBefore.probes);assert.deepEqual(library(),emptyBefore.library);
  await openPicker();await keyboardClick('添加平台',picker);await until(()=>visible(platformForm),'empty-platform guide opens inline form');assert.equal(await visible(picker),false);await threeColumns();
  await field('平台名称','首个平台','input',platformForm);await field('API 地址','https://first-platform.example/v1beta','input',platformForm);await field('API Key','test-only-first-platform','input',platformForm);await click('保存平台',platformForm);await until(()=>visible('.settings-enrollment'),'first platform saves to enrollment');assert.equal(library().connections.length,1);assert.equal(probes,emptyBefore.probes);
  await click('收起添加','.settings-enrollment');await choosePlatform('全部模型');await openPicker();assert.equal(await js(`document.querySelectorAll('${picker} [data-connection-id]').length`),1);assert.equal(await visible('.settings-enrollment'),false);await pickConnection(library().connections[0].connection_id);await until(()=>visible('.settings-enrollment'),'single platform still requires selection');assert.equal(probes,emptyBefore.probes);
  await click('手动添加','.settings-enrollment');await field('模型家族','nano','select','.settings-enrollment');await field('平台模型 ID','first-platform-model','input','.settings-enrollment');await click('添加到模型库','.settings-enrollment');await until(()=>Promise.resolve(library().models.some(m=>m.model==='first-platform-model')),'first-platform normal enrollment');assert.equal(library().models.find(m=>m.model==='first-platform-model').connection_id,library().connections[0].connection_id);assert.equal(probes,emptyBefore.probes);
  await controller.shutdown();win.destroy();const result={passed:true,base,probes,checks:['three-visible-columns-throughout','no-navigation-or-enrollment-modal','unsaved-cancel','save-and-switch','recipe-preserved','default-editing','inline-platform-to-enrollment','no-repeat-platform-select','explicit-discovery-only','204-mixed-models-unfiltered','row-add-without-bottom-action','known-model-family-detection','unknown-family-required','cancel-without-save','single-enrollment-failure-retry-no-duplicates','query-and-scroll-preserved','already-added-row-disabled','per-model-family-choice','inline-keyboard-controls','first-model-auto-selected','subsequent-add-preserves-selection-and-draft','collapse-preserves-query-and-results','manual-alias-stays-inline','parameter-draft-across-inline-tools','two-draft-continue-and-discard','two-draft-save-and-switch','two-draft-failure-preserves-input-and-retry','empty-key-repeat-save-retains-credential','close-discard','chat-inline-family-and-vision','chat-platform-and-manual-enrollment','text-only-default','optional-temperature-omitted','vision-toggle-and-limit','chat-default-assignment','vision-enrollment','responsive-inline-columns','search-retains-focus','collapse-restores-keyboard-focus','deleted-model-can-be-added-again','successful-row-focus','guard-save-invalidates-discovery','new-platform-guard-save-retains-selection','all-models-platform-picker','picker-tab-escape-and-cancel-focus','picker-cancel-no-save-or-probe','picker-same-model-preserves-draft','picker-cross-platform-continue-and-discard','picker-cross-platform-save','picker-incomplete-platform-settings','picker-add-platform-inline','empty-platform-guide-and-cancel','empty-platform-save-to-enrollment','single-platform-requires-selection','picker-normal-enrollment-no-auto-probe']};await writeFile(path.join(root,'.local/model-library-desktop-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(0);
}).catch(async error=>{console.error(error);if(failureWindow&&!failureWindow.isDestroyed()&&failureBase){try{await writeFile(path.join(failureBase,'failure.png'),(await failureWindow.webContents.capturePage(undefined,{stayHidden:true})).toPNG());await writeFile(path.join(failureBase,'failure.html'),await failureWindow.webContents.executeJavaScript('document.documentElement.outerHTML'));console.error('Failure artifacts: '+failureBase);}catch{}}app.exit(1);});
