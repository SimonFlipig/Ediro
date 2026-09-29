import type { UpdateAction, UpdateResponse, UpdateState } from '../shared/updates.js';

export const releasesUrl = 'https://github.com/SimonFlipig/Ediro/releases';
interface VersionInfo {version: string}
export interface UpdateDriver {
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: VersionInfo) => void): unknown;
  on(event: 'download-progress', listener: (info: {percent: number}) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(silent: boolean, restart: boolean): void;
}
// Only stable numeric versions can be used in display text or release URLs.
export function newerStableVersion(candidate: string, current: string) {
  if (!/^\d+\.\d+\.\d+$/.test(candidate)) return false;
  const a = candidate.split('.').map(Number), b = current.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {if (a[i] !== b[i]) return a[i] > b[i];}
  return false;
}

export class UpdateService {
  private state: UpdateState;
  private checking = false;
  private downloading = false;
  constructor(mode: UpdateState['mode'], currentVersion: string, private driver: UpdateDriver | undefined,
    private publish: (state: UpdateState) => void, private requestRestart: () => void,
    private openRelease: (url: string) => Promise<unknown>, private installFailed: () => void = () => {}) {
    this.state = {mode, currentVersion, status: driver ? 'idle' : 'disabled', message: driver ? '启动后自动检查，也可以手动检查更新。' : '源码开发版不自动更新。'};
    driver?.on('update-available', info => {
      if (!newerStableVersion(info.version, currentVersion)) {this.set({status: 'current', version: undefined, message: '当前已是最新正式版本。'});return;}
      this.set({status: 'available', version: info.version, percent: undefined, message: mode === 'portable' ? '发现新版本。请下载便携 ZIP，解压后保留原来的 data 文件夹。' : '发现新版本，点击下载更新。'});
    });
    driver?.on('update-not-available', () => this.set({status: 'current', version: undefined, message: '当前已是最新正式版本。'}));
    driver?.on('download-progress', info => {
      if (this.state.status === 'downloading') this.set({percent: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, Math.floor(info.percent))) : 0});
    });
    driver?.on('update-downloaded', info => {
      if (mode === 'installed' && this.downloading && info.version === this.state.version) this.set({status: 'downloaded', percent: 100, message: '下载和校验完成。确认后保存当前工程并重启升级。'});
    });
    driver?.on('error', () => this.fail());
  }
  snapshot(): UpdateState {return {...this.state};}
  private set(patch: Partial<UpdateState>) {this.state = {...this.state, ...patch};this.publish(this.snapshot());}
  private fail() {
    if (this.state.status === 'installing') {this.installFailed();this.cancelInstall('无法启动更新安装程序，请重试；也可以到发布页手动下载安装。');return;}
    this.set({status: 'error', percent: undefined, message: '更新未完成。请检查能否访问 GitHub；仓库未公开、没有正式版本或下载校验失败时也会出现此提示。可稍后重试或打开发布页。'});
  }
  cancelInstall(message = '已取消升级，当前编辑尚未保存。请保存后重试。') {
    this.set({status: 'downloaded', message});
  }
  installNow() {
    if (this.state.mode !== 'installed' || this.state.status !== 'installing') throw new Error('尚未准备好安装更新。');
    this.driver!.quitAndInstall(true, true);
  }
  async command(action: unknown): Promise<UpdateResponse> {
    try {
      if (!['state','check','download','install','release'].includes(action as string)) throw new Error('无效的更新操作。');
      if (action === 'state') return {ok: true, state: this.snapshot()};
      if (action === 'release') {
        const url = this.state.version ? `${releasesUrl}/tag/v${this.state.version}` : releasesUrl;
        await this.openRelease(url);
      } else if (!this.driver) throw new Error('源码开发版不自动更新，请使用发布版。');
      else if (action === 'check') {
        if (this.checking || this.downloading || ['downloaded','installing'].includes(this.state.status)) return {ok: true, state: this.snapshot()};
        this.checking = true;
        this.set({status: 'checking', message: '正在检查 GitHub 上的正式版本…', percent: undefined});
        try {await this.driver.checkForUpdates();} catch {this.fail();} finally {this.checking = false;}
      } else if (action === 'download') {
        if (this.state.mode !== 'installed') throw new Error('便携版请从发布页下载 ZIP，新版不会自动替换当前目录。');
        if (this.downloading) return {ok: true, state: this.snapshot()};
        if (this.state.status !== 'available' || this.checking) throw new Error('请先检查并确认有新版本。');
        this.downloading = true;
        this.set({status: 'downloading', percent: 0, message: '正在下载并校验更新，可以继续工作。'});
        try {await this.driver.downloadUpdate();} catch {this.fail();} finally {this.downloading = false;}
      } else if (action === 'install') {
        if (this.state.mode !== 'installed' || this.state.status !== 'downloaded') throw new Error('更新尚未下载完成。');
        this.set({status: 'installing', message: '正在保存当前工程并准备升级…'});
        try {this.requestRestart();} catch (error) {this.cancelInstall(error instanceof Error ? error.message : '暂时无法升级。');throw error;}
      }
      return {ok: this.state.status !== 'error', state: this.snapshot()};
    } catch (error) {return {ok: false, state: this.snapshot(), error: error instanceof Error ? error.message : '更新操作失败。'};}
  }
}
