import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateService, newerStableVersion, releasesUrl } from '../src/desktop/update-service.js';
import { UpdateRestart } from '../src/desktop/update-restart.js';

class Driver extends EventEmitter {
  checks = 0; downloads = 0; installs = 0;
  async checkForUpdates() {this.checks++;this.emit('update-available', {version: '0.2.0'});}
  async downloadUpdate() {this.downloads++;this.emit('download-progress', {percent: 55.4});this.emit('update-downloaded', {version: '0.2.0'});}
  quitAndInstall(silent: boolean, restart: boolean) {assert.equal(silent, true);assert.equal(restart, true);this.installs++;}
}
function fixture(mode: 'installed' | 'portable' | 'development' = 'installed', restart = () => {}) {
  const driver = new Driver(), opened: string[] = [], states: string[] = [];
  const service = new UpdateService(mode, '0.1.0', mode === 'development' ? undefined : driver, state => states.push(state.status), restart, async url => {opened.push(url);});
  return {service, driver, opened, states};
}
test('检测不自动下载；下载校验完成后仅明确重启操作可启动安装', async () => {
  let requested = 0;
  const {service, driver} = fixture('installed', () => requested++);
  assert.equal((await service.command('install')).ok, false);
  await service.command('check');assert.equal(service.snapshot().status, 'available');assert.equal(driver.downloads, 0);
  await service.command('download');assert.equal(service.snapshot().status, 'downloaded');assert.equal(driver.installs, 0);
  await service.command('check');assert.equal(driver.checks, 1); // do not discard a verified download
  await service.command('install');assert.equal(requested, 1);assert.equal(driver.installs, 0);
  service.installNow();assert.equal(driver.installs, 1);
});
test('便携版只提供固定仓库下载页，拒绝下载和安装命令', async () => {
  const {service, driver, opened} = fixture('portable');
  await service.command('check');await service.command('release');
  assert.deepEqual(opened, [`${releasesUrl}/tag/v0.2.0`]);
  assert.equal((await service.command('download')).ok, false);assert.equal((await service.command('install')).ok, false);
  assert.equal(driver.downloads, 0);assert.equal(driver.installs, 0);
  assert.equal((await service.command({url: 'file:///bad.exe'})).ok, false);
});
test('网络或校验错误不显示为最新版本，不允许安装，重新检查后可恢复', async () => {
  const {service, driver} = fixture();
  driver.checkForUpdates = async () => {throw new Error('private token and remote response must not reach UI');};
  await service.command('check');assert.equal(service.snapshot().status, 'error');assert.ok(!service.snapshot().message.includes('private token'));
  driver.checkForUpdates = async () => {driver.emit('update-available', {version: '0.2.0'});};
  await service.command('check');
  driver.downloadUpdate = async () => {driver.emit('error', new Error('checksum mismatch'));throw new Error('checksum mismatch');};
  await service.command('download');assert.equal(service.snapshot().status, 'error');assert.equal((await service.command('install')).ok, false);
  await service.command('check');assert.equal(service.snapshot().status, 'available');
});
test('有任务或保存准备失败时保留已下载版本，便于稍后重试', async () => {
  const {service, driver} = fixture('installed', () => {throw new Error('任务运行中');});
  await service.command('check');await service.command('download');
  const result = await service.command('install');assert.equal(result.ok, false);assert.equal(result.error, '任务运行中');
  assert.equal(service.snapshot().status, 'downloaded');assert.equal(driver.installs, 0);
});
test('开发模式不联网；重复检查合并，已下载状态不被后台检查覆盖', async () => {
  const dev = fixture('development');await dev.service.command('check');assert.equal(dev.driver.checks, 0);assert.equal(dev.service.snapshot().status, 'disabled');
  const {service, driver} = fixture();let resolve!: () => void;
  driver.checkForUpdates = async () => {driver.checks++;await new Promise<void>(r => {resolve = r;});driver.emit('update-not-available', {version: '0.1.0'});};
  const first = service.command('check');await service.command('check');assert.equal(driver.checks, 1);resolve();await first;assert.equal(service.snapshot().status, 'current');
});
test('不降级、不安装预发布或非版本字符串，数值比较支持两位版本号', () => {
  for (const version of ['0.0.9','0.1.0','0.2.0-beta.1','../../evil','NaN']) assert.equal(newerStableVersion(version, '0.1.0'), false);
  assert.equal(newerStableVersion('0.10.0','0.9.0'), true);
});
test('重启流程先等待编辑器再写盘；保存失败或期间产生任务都不启动安装器', async () => {
  const order: string[] = [];let failSave = true, busy = false;
  const gate = new UpdateRestart(() => {if (busy) throw new Error('busy');}, () => {order.push('request editors');}, async () => {order.push('save');if (failSave) throw new Error('disk full');}, () => {order.push('install');});
  gate.request();assert.deepEqual(order, ['request editors']);
  await assert.rejects(gate.afterEditorsSaved(), /disk full/);assert.equal(gate.requested, false);assert.equal(gate.launched, false);assert.ok(!order.includes('install'));
  failSave = false;gate.request();busy = true;await assert.rejects(gate.afterEditorsSaved(), /busy/);assert.ok(!order.includes('install'));
  busy = false;gate.request();assert.equal(await gate.afterEditorsSaved(), true);assert.equal(gate.launched, true);assert.deepEqual(order.slice(-2), ['save','install']);
  assert.equal(await gate.afterEditorsSaved(), false); // subsequent quit uses the normal shutdown path
});
test('编辑器拒绝关闭时取消重启；保存期间有新任务也会取消', async () => {
  let launched = false, busy = false;
  const gate = new UpdateRestart(() => {if (busy) throw new Error('busy');}, () => {}, async () => {busy = true;}, () => {launched = true;});
  gate.request();gate.cancel();assert.equal(await gate.afterEditorsSaved(), false);assert.equal(launched, false);
  gate.request();await assert.rejects(gate.afterEditorsSaved(), /busy/);assert.equal(launched, false);
});
