// Run with Electron after npm run build. DOM clipboard events leave the OS clipboard untouched.
const {app, BrowserWindow, ipcMain, net, protocol} = require('electron');
const {mkdir, mkdtemp} = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let controller, win, base, remoteCalls = 0;
function forbidNetwork() {
  remoteCalls++;
  throw Error('Unexpected network or model request in clipboard smoke');
}
globalThis.fetch = forbidNetwork;
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{scheme:'ediro-asset', privileges:{standard:true, secure:true, supportFetchAPI:true}}]);

async function until(check, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await wait(50);
  }
  throw Error('Timed out waiting for ' + label);
}

async function run() {
  await mkdir(path.join(root, '.local'), {recursive:true});
  base = await mkdtemp(path.join(root, '.local', 'module-clipboard-'));
  app.setPath('userData', path.join(base, 'electron'));
  const {DesktopController} = await import('../dist-host/desktop/controller.js');
  const createController = async () => {
    const next = await DesktopController.create(path.join(base, 'runtime'), () => win, {
      deferStartup:true, projectRoot:base, showMessage:async () => {throw Error('Unexpected native dialog');}
    });
    next.executors.execute = forbidNetwork;
    next.executors.probe = forbidNetwork;
    return next;
  };
  win = new BrowserWindow({show:false, width:1500, height:1000, webPreferences:{
    preload:path.join(root, 'dist-host/desktop/preload.cjs'), contextIsolation:true,
    nodeIntegration:false, sandbox:true, offscreen:true, backgroundThrottling:false
  }});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*', 'https://*/*']}, (_request, callback) => {
    remoteCalls++;
    callback({cancel:true});
  });
  controller = await createController();
  protocol.handle('ediro-asset', async request => net.fetch(pathToFileURL(await controller.assetPath(request.url)).href));
  const pasteTargets = [], failures = [];
  ipcMain.handle('ediro:update', () => ({status:'idle'}));
  ipcMain.handle('ediro:command', async (_event, command) => {
    if (command.type === 'assets:paste') pasteTargets.push(command.module_id);
    const response = await controller.execute(command);
    if (!response.ok) failures.push([command.type, response.error]);
    return response;
  });

  const js = source => win.webContents.executeJavaScript(source);
  const load = async () => {
    await win.loadFile(path.join(root, 'dist/index.html'));
    await until(() => js("!!document.querySelector('.module-card textarea')"), 'renderer');
  };
  const moduleOf = type => controller.workspace.project.recipe.modules.find(module => module.reference_type === type);
  const card = type => '.module-card.type-' + type;
  const selector = query => 'document.querySelector(' + JSON.stringify(query) + ')';
  const focus = query => js(selector(query) + '.focus()');
  const borderColor = type => js(`getComputedStyle(${selector(card(type))}).borderLeftColor`);
  const focusedBorder = 'rgb(177, 194, 184)';
  const click = query => js(selector(query) + '.click()');
  const paste = async ({bytes, mime = 'image/png', strings = {}}) => {
    // Exercise Chromium's File/DataTransfer representations and paste routing at
    // the current focus, including both items and files exposing the same bitmap.
    const files = Array.isArray(bytes) ? bytes : bytes ? [bytes] : [];
    return js(`(() => {
      const data = new DataTransfer();
      for (const [type, value] of Object.entries(${JSON.stringify(strings)})) data.setData(type, value);
      const files = ${JSON.stringify(files.map(source => source.toString('base64')))};
      for (const file of files) {
        const buffer = Uint8Array.from(atob(file), char => char.charCodeAt(0));
        data.items.add(new File([buffer], 'image.png', {type:${JSON.stringify(mime)}}));
      }
      const event = new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true});
      document.activeElement.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
  };
  const fixtures = new Map();
  const screenshot = async (width, background) => {
    const image = await sharp({create:{width, height:24, channels:4, background}}).png().toBuffer();
    fixtures.set(width, image);
    return image;
  };
  const red = await screenshot(30, '#ff0000'), blue = await screenshot(31, '#0000ff');
  const green = await screenshot(32, '#00ff00'), purple = await screenshot(33, '#660099'), yellow = await screenshot(34, '#ffff00');
  const cardText = type => card(type) + ' textarea';
  const waitImages = (type, count) => until(() => js(`(() => {
    const images = [...document.querySelectorAll(${JSON.stringify(card(type) + ' .reference-image img')})];
    return images.length === ${count} && images.every(image => image.complete && image.naturalWidth > 0);
  })()`), type + ' thumbnails: ' + count);
  const exec = async command => {
    const result = await controller.execute(command);
    assert.ok(result.ok, result.error);
    return result;
  };
  await load();
  const stale = await controller.execute({
    type:'assets:paste', project_id:'project_previous', module_id:moduleOf('subject').module_id,
    images:[{name:'old.png', bytes:new Uint8Array(red)}]
  });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /工程已切换/);
  assert.equal(controller.workspace.project.assets.length, 0);
  assert.deepEqual(moduleOf('subject').asset_ids, []);
  await focus(cardText('subject'));
  await until(async () => await borderColor('subject') === focusedBorder, 'focused module border');
  assert.equal(await js("getComputedStyle(document.activeElement.closest('.module-card')).borderLeftWidth"), '1px');
  assert.notEqual(await js('getComputedStyle(document.activeElement).outlineColor'), focusedBorder);
  assert.equal(await paste({strings:{'text/plain':'保留文字粘贴'}}), false);
  assert.equal(await paste({strings:{'text/html':'<img src="https://example.invalid/test.png">', 'text/plain':'https://example.invalid/test.png'}}), false);
  assert.equal(await paste({bytes:Buffer.from('text'), mime:'text/plain'}), false);
  for (const target of [cardText('prompt'), card('subject') + ' .module-title', '#generation-model']) {
    await focus(target);
    assert.equal(await paste({bytes:red}), false, target + ' does not consume image paste');
  }
  assert.deepEqual(pasteTargets, []);
  assert.equal((await controller.view()).project_format, 'draft');

  await focus(cardText('subject'));
  assert.equal(await paste({bytes:red, strings:{'text/plain':'copied image', 'text/html':'<img>'}}), true);
  await focus(cardText('style'));
  assert.equal(await paste({bytes:blue}), true);
  await waitImages('subject', 1);
  await waitImages('style', 1);
  assert.equal(await js(selector(cardText('subject')) + '.value'), '');

  // Use a real mouse click on card chrome to establish focus without a text caret.
  const point = await js(`(() => {
    const glyph = ${selector(card('style') + ' .module-glyph')};
    glyph.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
    const rect = glyph.getBoundingClientRect();
    return {x:Math.round(rect.left + rect.width/2), y:Math.round(rect.top + rect.height/2)};
  })()`);
  win.webContents.sendInputEvent({type:'mouseDown', button:'left', clickCount:1, ...point});
  win.webContents.sendInputEvent({type:'mouseUp', button:'left', clickCount:1, ...point});
  await until(() => js(`document.activeElement === ${selector(card('style'))}`), 'card focus from click');
  await until(async () => await borderColor('style') === focusedBorder, 'clicked module border');
  assert.notEqual(await borderColor('subject'), focusedBorder);
  // Route an actual Chromium paste at the focused card when the hidden desktop
  // permits it. Substitute a fixture during capture before reading any data.
  await js(`(() => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(${JSON.stringify(green.toString('base64'))}), char => char.charCodeAt(0));
    data.items.add(new File([bytes], 'image.png', {type:'image/png'}));
    window.clipboardProbeCount = 0;
    window.clipboardProbe = event => {
      if (!event.isTrusted) return;
      Object.defineProperty(event, 'clipboardData', {value:data});
      window.clipboardProbeCount++;
    };
    document.addEventListener('paste', window.clipboardProbe, true);
  })()`);
  let cardInput = 'Ctrl+V';
  win.webContents.sendInputEvent({type:'keyDown', keyCode:'V', modifiers:['control']});
  win.webContents.sendInputEvent({type:'keyUp', keyCode:'V', modifiers:['control']});
  await wait(250);
  if (!await js('window.clipboardProbeCount')) {
    cardInput = 'webContents.paste';
    win.webContents.paste();
    await wait(250);
  }
  const trusted = await js('window.clipboardProbeCount');
  await js("document.removeEventListener('paste', window.clipboardProbe, true)");
  if (trusted) assert.equal(trusted, 1);
  else {
    cardInput = 'synthetic';
    assert.equal(await paste({bytes:green}), true);
  }
  await waitImages('style', 2);

  await click(card('subject') + ' .expand-module');
  const expanded = '.module-editor textarea[aria-label="展开文本内容"]';
  await until(() => js(`document.activeElement === ${selector(expanded)}`), 'expanded textarea focus');
  await win.webContents.insertText('这行尚未应用');
  assert.equal(await js(selector(expanded) + '.value'), '这行尚未应用');
  assert.equal(await paste({bytes:[purple,yellow]}), true);
  await waitImages('subject', 3);
  assert.equal(await js(selector(expanded) + '.value'), '这行尚未应用', 'import preserves expanded text draft');
  await click('.module-editor button[aria-label="关闭展开编辑"]');
  await until(() => js("!document.querySelector('.module-editor')"), 'dismiss expanded editor');
  assert.equal(await js(selector(cardText('subject')) + '.value'), '', 'dismiss discards only the unsaved text');

  assert.deepEqual(pasteTargets, ['subject','style','style','subject'].map(type => moduleOf(type).module_id));
  const stored = await exec({type:'project:save'});
  assert.equal(stored.state.project_format, 'ediro');
  const recordId = stored.state.project_record_id;
  await controller.shutdown();
  controller = await createController();
  await exec({type:'workspace:resume', id:recordId});
  await load();
  const assets = controller.workspace.project.assets;
  assert.equal(assets.length, 5);
  for (const [type, widths] of [['subject',[30,33,34]], ['style',[31,32]], ['composition',[]], ['prompt',[]]]) {
    const refs = moduleOf(type).asset_ids.map(id => assets.find(asset => asset.asset_id === id));
    assert.deepEqual(refs.map(asset => asset.width), widths, type + ' image order after reopening');
    for (const asset of refs) {
      assert.equal(asset.location.type, 'managed');
      const pixels = await sharp(await controller.workspace.repository.readAsset(asset)).raw().toBuffer();
      assert.deepEqual(pixels, await sharp(fixtures.get(asset.width)).raw().toBuffer());
    }
    if (widths.length) await waitImages(type, widths.length);
  }
  assert.deepEqual(failures, []);
  assert.equal(remoteCalls, 0);
  assert.equal(win.isVisible(), false);
  await controller.shutdown();
  win.destroy();
  console.log(JSON.stringify({passed:true, base, imagePastes:pasteTargets.length, cardInput, remoteCalls}));
}

app.whenReady().then(run).then(() => app.exit(0)).catch(error => {
  console.error(base, error);
  app.exit(1);
});
