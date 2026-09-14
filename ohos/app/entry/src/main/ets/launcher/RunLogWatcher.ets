import fs from '@ohos.file.fs';
import util from '@ohos.util';
import { readinessUrl } from './RunLogUrl';

/** Reasons the watcher cannot read the log; the page maps them to localized copy. */
export enum RunLogState {
  Idle,
  Waiting,
  Found,
  Missing,
  Unreadable
}

/** Published watcher state; it never carries the authenticated URL anywhere else. */
export class RunLogView {
  state: RunLogState = RunLogState.Idle;
  url: string = '';
}

/** Bounded read of the newest 64 KiB of a file, so a growing log stays cheap. */
const MAX_READ = 64 * 1024;

/**
 * Polls one log file once per second and publishes the announced URL. The file
 * is addressed either by filesystem path (when the app may read it directly) or
 * by the URI returned by the system file picker, which needs no permission.
 */
export class RunLogWatcher {
  private timer: number = -1;
  private listener: ((view: RunLogView) => void) | undefined = undefined;
  private view: RunLogView = new RunLogView();
  private path: string = '';
  private uri: string = '';
  private accepted: string = '';

  subscribe(listener: (view: RunLogView) => void): void {
    this.listener = listener;
    this.startPolling();
    this.publish();
  }

  unsubscribe(): void {
    this.listener = undefined;
    this.stopPolling();
  }

  /** Sets the direct path; a picked URI stays preferred while it is set. */
  setPath(path: string): void {
    this.path = path;
    this.accepted = '';
    this.restart();
  }

  /** Adopts the file the user picked; an empty value reverts to the direct path. */
  setUri(uri: string): void {
    this.uri = uri;
    this.accepted = '';
    this.restart();
  }

  hasTarget(): boolean {
    return this.uri !== '' || this.path !== '';
  }

  private restart(): void {
    if (this.listener !== undefined) {
      this.startPolling();
    }
    this.publish();
  }

  private startPolling(): void {
    if (this.timer === -1) {
      this.timer = setInterval(() => this.poll(), 1000);
    }
  }

  private stopPolling(): void {
    if (this.timer !== -1) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }

  private poll(): void {
    const text = this.readBounded();
    if (text === undefined) {
      this.publish();
      return;
    }
    const url = readinessUrl(text);
    if (url === '') {
      this.view.url = '';
      this.view.state = RunLogState.Waiting;
    } else {
      // The reported address stays stable across polls; the page compares it with
      // the target it already opened, so a repeated poll never reloads the view.
      this.accepted = url;
      this.view.url = url;
      this.view.state = RunLogState.Found;
    }
    this.publish();
  }

  /** Returns the file text, or undefined when the current target is unreadable. */
  private readBounded(): string | undefined {
    const target = this.uri !== '' ? this.uri : this.path;
    if (target === '') {
      this.view.state = RunLogState.Idle;
      this.view.url = '';
      return undefined;
    }
    let file: fs.File | undefined = undefined;
    try {
      file = fs.openSync(target, fs.OpenMode.READ_ONLY);
      const size = fs.statSync(file.fd).size;
      if (size === 0) {
        return '';
      }
      const length = size > MAX_READ ? MAX_READ : size;
      const buffer = new ArrayBuffer(length);
      const read = fs.readSync(file.fd, buffer, { offset: size - length, length: length });
      if (read <= 0) {
        return '';
      }
      const decoder = util.TextDecoder.create('utf-8');
      return decoder.decodeToString(new Uint8Array(buffer, 0, read));
    } catch (error) {
      // A missing file is the ordinary pre-command state; anything else (a refused
      // read, a directory, a bad URI) needs the picker, so the two stay distinct.
      const missing: boolean = (error as BusinessError).code === 13900002;
      this.view.state = missing ? RunLogState.Missing : RunLogState.Unreadable;
      this.view.url = '';
      return undefined;
    } finally {
      if (file !== undefined) {
        try {
          fs.closeSync(file);
        } catch (_) {
          // A failed close cannot change the report; the fd dies with the process.
        }
      }
    }
  }

  private publish(): void {
    const out = new RunLogView();
    out.state = this.view.state;
    out.url = this.view.url;
    this.listener?.(out);
  }

  destroy(): void {
    this.listener = undefined;
    this.stopPolling();
  }
}
