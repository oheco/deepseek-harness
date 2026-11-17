import window from '@ohos.window';

/** UIAbilityContext eventHub event carrying one boolean: the WebView is active. */
export const WEB_VIEW_ACTIVE_EVENT: string = 'dshWebViewActive';

/** One live window serializes SDK requests and retains only its latest desired mode. */
class WindowOrientation {
  private desired: window.Orientation = window.Orientation.PORTRAIT;
  private applied: window.Orientation | undefined = undefined;
  private reapplyPending: boolean = false;
  private running: boolean = false;
  private closed: boolean = false;
  private readonly mainWindow: window.Window;

  constructor(mainWindow: window.Window) {
    this.mainWindow = mainWindow;
  }

  request(orientation: window.Orientation, force: boolean = false): void {
    if (this.closed) {
      return;
    }
    this.desired = orientation;
    this.reapplyPending = this.reapplyPending || force;
    this.apply();
  }

  close(): void {
    this.closed = true;
  }

  private apply(): void {
    if (this.closed || this.running || (!this.reapplyPending && this.applied === this.desired)) {
      return;
    }
    const requested: window.Orientation = this.desired;
    this.reapplyPending = false;
    this.running = true;
    let operation: Promise<void>;
    try {
      operation = this.mainWindow.setPreferredOrientation(requested);
    } catch (error) {
      this.finish(requested, false);
      return;
    }
    operation.then(() => this.finish(requested, true), (error: Error) => this.finish(requested, false));
  }

  private finish(requested: window.Orientation, success: boolean): void {
    this.running = false;
    if (this.closed) {
      return;
    }
    // A failed request leaves the native orientation state unconfirmed.
    this.applied = success ? requested : undefined;
    if (this.desired !== requested || this.reapplyPending) {
      this.apply();
    }
  }
}

/**
 * Ability-owned orientation policy. App pages use portrait; an active WebView
 * uses sensor rotation in portrait and landscape while respecting system rotation lock.
 * A detached window receives no further requests from its pending completions.
 */
export class WebOrientation {
  private webActive: boolean = false;
  private target: WindowOrientation | undefined = undefined;
  private disposed: boolean = false;

  /**
   * Bind the current stage's main window. Repeated binding is ignored until detach.
   * @param mainWindow - a live main window; preferred orientation can be set before content loads.
   * @returns No value; the latest activity state is applied asynchronously.
   */
  attach(mainWindow: window.Window): void {
    if (!this.disposed && !this.target) {
      this.target = new WindowOrientation(mainWindow);
      this.target.request(this.mode());
    }
  }

  /**
   * Retain the latest page activity even before a main window is available.
   * @param active - true for an open WebView; false for all other App pages.
   * @returns No value; SDK errors are contained and a later request can retry.
   */
  setWebActive(active: boolean): void {
    if (this.disposed) {
      return;
    }
    this.webActive = active;
    if (this.target) {
      this.target.request(this.mode());
    }
  }

  /**
   * Restore the current policy on foregrounding.
   * @returns No value; a pending request finishes before the policy is reapplied.
   */
  reapply(): void {
    if (this.target) {
      this.target.request(this.mode(), true);
    }
  }

  /**
   * Detach the old window before binding a replacement.
   * @returns No value; already issued SDK calls cannot be canceled, and their completions remain inactive.
   */
  detach(): void {
    if (this.target) {
      this.target.close();
      this.target = undefined;
    }
  }

  /**
   * End the ability lifetime and ignore later events.
   * @returns No value; window ownership is detached and later binding is disabled.
   */
  dispose(): void {
    this.detach();
    this.webActive = false;
    this.disposed = true;
  }

  private mode(): window.Orientation {
    return this.webActive ? window.Orientation.AUTO_ROTATION_RESTRICTED : window.Orientation.PORTRAIT;
  }
}
