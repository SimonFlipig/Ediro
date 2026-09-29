import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { UpdateService } from './update-service.js';
import type { UpdateState } from '../shared/updates.js';

export function configureUpdateDriver(driver: typeof electronUpdater.autoUpdater) {
    driver.autoDownload = false;
    driver.autoInstallOnAppQuit = false;
    driver.allowPrerelease = false;
    driver.allowDowngrade = false;
    driver.disableWebInstaller = true;
    // Public GitHub provider; never pass the developer's token to the application.
    driver.logger = null;
}
export function bindUpdateIpc(window: BrowserWindow, service: UpdateService) {
  ipcMain.handle('ediro:update', (event, action: unknown) => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('调用来源未授权。');
    return service.command(action);
  });
  window.once('closed', () => ipcMain.removeHandler('ediro:update'));
}
export function registerUpdates(window: BrowserWindow, mode: UpdateState['mode'], requestRestart: () => void, installFailed: () => void) {
  const driver = mode === 'development' ? undefined : electronUpdater.autoUpdater;
  if (driver) configureUpdateDriver(driver);
  const service = new UpdateService(mode, app.getVersion(), driver, state => {
    if (!window.isDestroyed()) window.webContents.send('ediro:update-state', state);
  }, requestRestart, url => shell.openExternal(url), installFailed);
  bindUpdateIpc(window, service);
  let startup: ReturnType<typeof setTimeout> | undefined, repeat: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (!driver || startup) return;
    startup = setTimeout(() => {void service.command('check');}, 10000);
    repeat = setInterval(() => {void service.command('check');}, 6 * 60 * 60 * 1000);
    startup.unref();repeat.unref();
  };
  window.once('closed', () => {clearTimeout(startup);clearInterval(repeat);});
  return {service, start};
}
