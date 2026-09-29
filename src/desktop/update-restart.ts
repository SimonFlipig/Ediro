// The installer is launched only after the renderer has submitted its drafts
// and the host has flushed them. Until launch, a failed save keeps the app open.
export class UpdateRestart {
  requested = false;
  launched = false;
  constructor(private assertReady: () => void, private closeWindow: () => void, private save: () => Promise<void>, private launch: () => void) {}
  request() {
    if (this.requested) throw new Error('已在准备升级，请稍候。');
    this.assertReady();this.requested = true;
    try {this.closeWindow();} catch (error) {this.cancel();throw error;}
  }
  async afterEditorsSaved() {
    if (!this.requested || this.launched) return false;
    try {
      this.assertReady();await this.save();this.assertReady();
      this.launched = true;this.launch();return true;
    } catch (error) {this.cancel();throw error;}
  }
  cancel() {this.requested = false;this.launched = false;}
}
