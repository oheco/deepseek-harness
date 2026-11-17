import native from 'libdsh_launcher.so';
import pasteboard from '@ohos.pasteboard';
import { connectionDiagnosticFailure } from '../launcher/ConnectionDiagnostics';

/** View a bounded tail and copy the complete retained App-private diagnostic journal. */
@Component
export struct DiagnosticLogs {
  @State private display: string = '';
  @State private message: Resource = $r('app.string.diagnostics_hint');
  @State private readable: boolean = false;
  @State private copying: boolean = false;
  private retainedLog: string = '';

  aboutToAppear(): void {
    this.refresh();
  }

  private refresh(): boolean {
    try {
      this.retainedLog = native.readConnectionDiagnostics();
      this.display = this.retainedLog.slice(-96 * 1024);
      this.readable = this.retainedLog.length > 0;
      this.message = $r('app.string.diagnostics_hint');
      return true;
    } catch (error) {
      this.retainedLog = '';
      this.display = '';
      this.readable = false;
      this.message = $r('app.string.diagnostics_read_failed');
      return false;
    }
  }

  private async copyLogs(): Promise<void> {
    if (this.copying || !this.refresh() || !this.readable) { return; }
    this.copying = true;
    try {
      await pasteboard.getSystemPasteboard().setData(
        pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.retainedLog));
      this.message = $r('app.string.diagnostics_copied');
    } catch (error) {
      connectionDiagnosticFailure('app.diagnostics_copy_failed', error);
      this.message = $r('app.string.diagnostics_copy_failed');
    } finally {
      this.copying = false;
    }
  }

  build() {
    Column({ space: 12 }) {
      Row({ space: 12 }) {
        Button($r('app.string.diagnostics_refresh')).id('diagnostics-refresh').height(40)
          .backgroundColor($r('app.color.card')).fontColor($r('app.color.accent'))
          .onClick(() => { this.refresh(); })
        Button($r('app.string.diagnostics_copy')).id('diagnostics-copy').height(40)
          .backgroundColor($r('app.color.accent')).fontColor($r('app.color.on_accent'))
          .enabled(this.readable && !this.copying).onClick(() => { this.copyLogs(); })
      }.width('100%')
      Text(this.message).fontSize(13).fontColor($r('app.color.muted')).width('100%')
      Scroll() {
        Text(this.display === '' ? $r('app.string.diagnostics_empty') : this.display)
          .id('diagnostics-content').width('100%').fontSize(12).fontFamily('monospace')
          .fontColor($r('app.color.ink')).copyOption(CopyOptions.LocalDevice)
      }.id('diagnostics-scroll').width('100%').layoutWeight(1).align(Alignment.TopStart)
        .scrollBar(BarState.Auto).backgroundColor($r('app.color.card')).borderRadius(12).padding(12)
    }.width('100%').height('100%').padding(20).backgroundColor($r('app.color.panel'))
  }
}
