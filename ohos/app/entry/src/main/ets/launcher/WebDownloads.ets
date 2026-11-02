import webview from '@ohos.web.webview';
import common from '@ohos.app.ability.common';
import picker from '@ohos.file.picker';
import fs from '@ohos.file.fs';
import { BusinessError } from '@ohos.base';
import { loopbackOrigin } from './RunLogUrl';

type DownloadKind = 'started' | 'saved' | 'cancelled' | 'busy' | 'unsupported' | 'failed';
type DownloadStage = 'attach' | 'download' | 'picker' | 'save' | 'cleanup';

/** Localized presentation belongs to the page; partial means the authorized destination may be incomplete. */
export interface WebDownloadNotice {
  kind: DownloadKind;
  stage: DownloadStage;
  filename: string;
  code: number;
  partial: boolean;
}

class DownloadOwner {
  context: common.UIAbilityContext;
  controller: webview.WebviewController;
  origin: string;

  constructor(controller: webview.WebviewController, context: common.UIAbilityContext, origin: string) {
    this.controller = controller;
    this.context = context;
    this.origin = origin;
  }
}

class DownloadOperation {
  owner: DownloadOwner;
  item: webview.WebDownloadItem;
  guid: string;
  filename: string;
  directory: string;
  path: string;
  phase: 'download' | 'picker' | 'save' | 'cleanup' | 'cleanup-failed' = 'download';
  retired: boolean = false;
  settled: boolean = false;
  resolve: () => void = () => {};
  reject: (error: Error) => void = (error: Error) => {};
  done: Promise<void> = Promise.resolve();

  constructor(owner: DownloadOwner, item: webview.WebDownloadItem, directory: string) {
    this.owner = owner;
    this.item = item;
    this.guid = item.getGuid();
    this.filename = downloadFilename(item.getSuggestedFileName());
    this.directory = directory;
    this.path = directory + '/payload';
    this.renewCompletion();
  }

  renewCompletion(): void {
    this.done = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.done.catch((error: Error) => {
      // Automatic callbacks report failure through a notice; close callers still receive the original rejection.
    });
  }
}

function errorCode(error: BusinessError): number {
  return typeof error.code === 'number' ? error.code : 0;
}

/** A display suggestion only; neither this name nor the download URL becomes a filesystem path. */
function downloadFilename(suggestion: string): string {
  let name = suggestion.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  if (name === '') { return 'dsh-download'; }
  const suffix = /\.[A-Za-z0-9]{1,12}$/.exec(name);
  const extension = suffix === null ? '' : suffix[0];
  const stem = extension === '' ? name : name.slice(0, -extension.length);
  name = stem.slice(0, 72).replace(/[\ud800-\udbff]$/, '') + extension;
  return name;
}

/**
 * Owns native downloads for one window. Only its authenticated loopback origin and its blob URLs are accepted.
 * Files stream to a unique application temporary directory; only the system save picker can authorize the destination.
 * @param changed - Receives presentation events; a throwing observer is contained and logged.
 */
export class WebDownloads {
  private owner: DownloadOwner | undefined = undefined;
  private operation: DownloadOperation | undefined = undefined;
  private changed: (notice: WebDownloadNotice) => void;

  constructor(changed: (notice: WebDownloadNotice) => void) {
    this.changed = changed;
  }

  /**
   * Install after the controller is associated with a Web component. Reattachment of the same controller is allowed.
   * A different connection requires awaiting close first. Installation failure reports a notice without rejecting page navigation.
   * @param controller - This window's attached controller; no process-wide download delegate is used.
   * @param context - This window's ability context, used for temporary storage and the system save picker.
   * @param origin - Exact numeric loopback origin of the active connection.
   */
  attach(controller: webview.WebviewController, context: common.UIAbilityContext, origin: string): void {
    if (loopbackOrigin(origin) !== origin) {
      this.notice('unsupported', 'attach', '', 0, false);
      return;
    }
    const previous = this.owner;
    if (previous && previous.controller === controller && previous.origin === origin) { return; }
    if (previous || this.operation) {
      this.notice('failed', 'attach', '', 0, false);
      return;
    }
    const owner = new DownloadOwner(controller, context, origin);
    const boundOwner = owner;
    const delegate = new webview.WebDownloadDelegate();
    delegate.onBeforeDownload((item: webview.WebDownloadItem) => this.before(boundOwner, item));
    delegate.onDownloadFinish((item: webview.WebDownloadItem) => this.finished(boundOwner, item));
    delegate.onDownloadFailed((item: webview.WebDownloadItem) => this.failed(boundOwner, item));
    try {
      controller.setDownloadDelegate(delegate);
      this.owner = owner;
    } catch (error) {
      this.notice('failed', 'attach', '', errorCode(error as BusinessError), false);
    }
  }

  /**
   * Retire ownership synchronously, then join native cancellation, active copying and temporary-file cleanup.
   * The SDK cannot dismiss an open system picker: its late result is ignored and cannot create or write a file.
   * An already authorized copy finishes before close settles. Cancellation or cleanup failure rejects close and retains
   * its owner for a later close retry; another connection cannot attach until cleanup succeeds.
   * @returns After all application-owned file I/O has settled; a pending system picker does not block closing a window.
   */
  close(): Promise<void> {
    this.owner = undefined;
    const operation = this.operation;
    if (!operation) { return Promise.resolve(); }
    if (operation.phase === 'cleanup-failed') {
      operation.retired = true;
      operation.renewCompletion();
      void this.cleanup(operation, true);
      return operation.done;
    }
    if (operation.retired) { return operation.done; }
    operation.retired = true;
    if (operation.phase === 'download') {
      try {
        operation.item.cancel();
      } catch (error) {
        operation.retired = false;
        console.warn(`WebDownloads: native cancellation failed (${errorCode(error as BusinessError)}).`);
        return Promise.reject(error as Error);
      }
      return operation.done;
    }
    if (operation.phase === 'picker') {
      void this.cleanup(operation);
    }
    return operation.done;
  }

  private current(operation: DownloadOperation): boolean {
    return !operation.retired && this.owner === operation.owner && this.operation === operation;
  }

  private notice(kind: DownloadKind, stage: DownloadStage, filename: string,
    code: number, partial: boolean): void {
    try {
      this.changed({ kind: kind, stage: stage, filename: filename, code: code, partial: partial });
    } catch (error) {
      console.warn(`WebDownloads: presentation failed (${kind}, ${stage}).`);
    }
  }

  private cancel(item: webview.WebDownloadItem): void {
    try {
      item.cancel();
    } catch (error) {
      console.warn(`WebDownloads: rejected download cancellation failed (${errorCode(error as BusinessError)}).`);
    }
  }

  private before(owner: DownloadOwner, item: webview.WebDownloadItem): void {
    if (this.owner !== owner) { this.cancel(item); return; }
    if (this.operation) {
      this.cancel(item);
      this.notice('busy', 'download', '', 0, false);
      return;
    }
    const address = item.getUrl();
    const resource = address.startsWith('blob:') ? address.slice(5) : address;
    if (loopbackOrigin(resource) !== owner.origin) {
      this.cancel(item);
      this.notice('unsupported', 'download', '', 0, false);
      return;
    }
    let directory: string;
    try {
      directory = fs.mkdtempSync(owner.context.tempDir + '/dsh-web-download-XXXXXX');
    } catch (error) {
      this.cancel(item);
      this.notice('failed', 'download', '', errorCode(error as BusinessError), false);
      return;
    }
    const operation = new DownloadOperation(owner, item, directory);
    this.operation = operation;
    try {
      item.start(operation.path);
      this.notice('started', 'download', operation.filename, 0, false);
    } catch (error) {
      this.notice('failed', 'download', operation.filename, errorCode(error as BusinessError), false);
      operation.retired = true;
      try {
        item.cancel();
      } catch (cancelError) {
        operation.retired = false;
        console.warn(`WebDownloads: native cancellation failed (${errorCode(cancelError as BusinessError)}).`);
      }
    }
  }

  private finished(owner: DownloadOwner, item: webview.WebDownloadItem): void {
    const operation = this.operation;
    if (!operation || operation.owner !== owner || operation.guid !== item.getGuid() || operation.phase !== 'download') {
      return;
    }
    if (!this.current(operation)) {
      void this.cleanup(operation);
      return;
    }
    operation.phase = 'picker';
    void this.save(operation);
  }

  private failed(owner: DownloadOwner, item: webview.WebDownloadItem): void {
    const operation = this.operation;
    if (!operation || operation.owner !== owner || operation.guid !== item.getGuid() || operation.phase !== 'download') {
      return;
    }
    if (this.current(operation)) {
      const code = item.getLastErrorCode();
      this.notice(code === webview.WebDownloadErrorCode.USER_CANCELED ? 'cancelled' : 'failed',
        'download', operation.filename, code, false);
    }
    void this.cleanup(operation);
  }

  private async save(operation: DownloadOperation): Promise<void> {
    let destination: fs.File | undefined = undefined;
    let partial = false;
    try {
      const options = new picker.DocumentSaveOptions();
      options.newFileNames = [operation.filename];
      options.autoCreateEmptyFile = false;
      const uris = await new picker.DocumentViewPicker(operation.owner.context).save(options);
      if (!this.current(operation)) { return; }
      if (uris.length === 0) {
        this.notice('cancelled', 'picker', operation.filename, 0, false);
        return;
      }
      if (uris.length !== 1 || !/^file:\/\/[^\u0000-\u0020\u007f]+$/.test(uris[0])) {
        this.notice('failed', 'picker', operation.filename, 0, false);
        return;
      }
      operation.phase = 'save';
      partial = true;
      destination = await fs.open(uris[0], fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      await fs.copyFile(operation.path, destination.fd);
      await fs.fsync(destination.fd);
      await fs.close(destination);
      destination = undefined;
      if (this.current(operation)) { this.notice('saved', 'save', operation.filename, 0, false); }
    } catch (error) {
      if (this.current(operation)) {
        this.notice('failed', operation.phase === 'picker' ? 'picker' : 'save', operation.filename,
          errorCode(error as BusinessError), partial);
      } else if (partial) {
        this.notice('failed', 'save', operation.filename, errorCode(error as BusinessError), true);
      }
    } finally {
      if (destination) {
        try { await fs.close(destination); } catch (error) {
          console.warn(`WebDownloads: destination close failed (${errorCode(error as BusinessError)}).`);
        }
      }
      await this.cleanup(operation);
    }
  }

  private async cleanup(operation: DownloadOperation, retry: boolean = false): Promise<void> {
    if (operation.settled || operation.phase === 'cleanup' || (operation.phase === 'cleanup-failed' && !retry)) { return; }
    operation.phase = 'cleanup';
    try {
      // Only a directory returned by mkdtempSync is removed; remote names and picker URIs never reach rmdir.
      await fs.rmdir(operation.directory);
    } catch (error) {
      operation.phase = 'cleanup-failed';
      console.warn(`WebDownloads: temporary cleanup failed (${errorCode(error as BusinessError)}).`);
      this.notice('failed', 'cleanup', operation.filename, errorCode(error as BusinessError), false);
      operation.reject(error as Error);
      return;
    }
    operation.settled = true;
    if (this.operation === operation) { this.operation = undefined; }
    operation.resolve();
  }
}
