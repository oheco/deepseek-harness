import native, { BrokerStatus, DshProbeResult } from 'libdsh_launcher.so';
import { ConnectionMode, ConnectionProfile } from './ConnectionProfile';
import { connectionDiagnostic, connectionDiagnosticFailure } from './ConnectionDiagnostics';

/** Native transport state; a disconnected transport keeps its existing WebView. */
export enum WebConnectionState {
  Connected = 'connected',
  Disconnected = 'disconnected',
  Recovering = 'recovering',
  AuthenticationRequired = 'authentication-required'
}

/** Owns one WebView's persistent mapping and observes SDK recovery without changing its origin. */
export class WebConnection {
  private profile: ConnectionProfile | undefined = undefined;
  private origin: string = '';
  private generation: number = 0;
  private foreground: boolean = true;
  private active: boolean = false;
  private state: WebConnectionState = WebConnectionState.Connected;
  private pending: Promise<void> | undefined = undefined;
  private closing: Promise<void> | undefined = undefined;
  private closeRemote: boolean = false;
  private reading: boolean = false;
  private recoveryNotice: boolean = false;
  private changed: (state: WebConnectionState, recovered: boolean) => void;

  constructor(changed: (state: WebConnectionState, recovered: boolean) => void) {
    this.changed = changed;
  }

  /** Adopt an authenticated SDK mapping; its listener stays owned until explicit close. */
  activate(profile: ConnectionProfile, origin: string): void {
    if (this.closing || this.closeRemote) {
      throw new Error('Connection cleanup has not completed');
    }
    this.foreground = true;
    this.profile = profile;
    this.origin = origin;
    this.generation += 1;
    connectionDiagnostic('connection.activated', { generation: this.generation, remote: profile.mode === ConnectionMode.Remote });
    this.active = true;
    this.state = WebConnectionState.Connected;
    this.recoveryNotice = false;
  }

  /** Suspend App polling and notifications while leaving SDK automatic recovery active. */
  background(): void {
    connectionDiagnostic('connection.background', { generation: this.generation, current: this.active });
    this.foreground = false;
  }

  /** Resume notifications and wake a paused SDK peer; an intact retained page can skip healthy HTTP verification. */
  foregrounded(verifyEndpoint: boolean = true): Promise<void> {
    this.foreground = true;
    connectionDiagnostic('connection.foreground', { generation: this.generation, phase: verifyEndpoint ? 1 : 0 });
    return this.recover(verifyEndpoint);
  }

  /** Retain the page when its renderer or business connection becomes unavailable. */
  disconnected(): void {
    if (this.active) {
      this.publish(WebConnectionState.Disconnected, false, this.generation);
    }
  }

  /** Observe automatic SDK recovery; polling never creates a peer or resets its retry budget. */
  async check(): Promise<void> {
    const profile = this.profile;
    if (!this.active || !this.foreground || this.reading || this.pending ||
      !profile || profile.mode !== ConnectionMode.Remote) {
      return;
    }
    const generation = this.generation;
    this.reading = true;
    try {
      const status: BrokerStatus = await native.brokerStatus();
      await this.inspect(status, profile, generation, false);
    } catch (error) {
      if (this.state !== WebConnectionState.Disconnected) {
        connectionDiagnosticFailure('connection.status_failed', error, { generation: generation });
      }
      this.publish(WebConnectionState.Disconnected, false, generation);
    } finally {
      this.reading = false;
    }
  }

  /** Cancel before joining pending work; retired callbacks cannot restore an explicitly closed page. */
  close(): Promise<void> {
    connectionDiagnostic('connection.close_requested', { generation: this.generation, current: this.active,
      remote: this.closeRemote || this.profile?.mode === ConnectionMode.Remote, phase: this.pending ? 1 : 0 });
    if (this.closing) {
      return this.closing;
    }
    this.closeRemote = this.closeRemote || (this.active && this.profile?.mode === ConnectionMode.Remote);
    this.active = false;
    this.generation += 1;
    this.profile = undefined;
    const work = this.finishClose(this.pending);
    this.closing = work;
    work.then(() => this.finishClosing(work), () => this.finishClosing(work));
    return work;
  }

  private finishClosing(work: Promise<void>): void {
    if (this.closing === work) {
      this.closing = undefined;
    }
  }

  private async finishClose(pending: Promise<void> | undefined): Promise<void> {
    let closed = false;
    try {
      if (this.closeRemote) {
        await native.brokerClose();
      }
      closed = true;
    } finally {
      if (pending) {
        await pending;
      }
      if (closed) {
        this.closeRemote = false;
      }
    }
  }

  private recover(verifyEndpoint: boolean): Promise<void> {
    if (this.pending) {
      return this.pending;
    }
    const profile = this.profile;
    if (!this.active || !this.foreground || !profile || this.closing) {
      return Promise.resolve();
    }
    const work = this.restore(profile, this.generation, verifyEndpoint);
    this.pending = work;
    work.then(() => {
      if (this.pending === work) {
        this.pending = undefined;
      }
    });
    return work;
  }

  private current(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private publish(state: WebConnectionState, recovered: boolean, generation: number): void {
    if (!this.current(generation)) {
      return;
    }
    if (this.state !== state || recovered) {
      connectionDiagnostic('connection.state', { generation: generation, recovered: recovered,
        state: state === WebConnectionState.Connected ? 0 : state === WebConnectionState.Disconnected ? 1 :
          state === WebConnectionState.Recovering ? 2 : 3 });
    }
    this.state = state;
    this.recoveryNotice = state === WebConnectionState.Connected && (this.recoveryNotice || recovered);
    if (this.foreground) {
      try {
        this.changed(state, this.recoveryNotice);
        this.recoveryNotice = false;
      } catch (error) {
        // A detached renderer retains its pending recovery notification for the next foreground.
      }
    }
  }

  private async probe(token: string): Promise<DshProbeResult> {
    try {
      return await native.dshProbe({ origin: this.origin, token: token });
    } catch (error) {
      // An unavailable HTTP probe leaves the same page and SDK mapping in place.
      return { state: 'unreachable', httpStatus: 0 };
    }
  }

  private async verify(profile: ConnectionProfile, generation: number): Promise<void> {
    const recovered = this.state !== WebConnectionState.Connected;
    const started = Date.now();
    const result: DshProbeResult = await this.probe(profile.token);
    connectionDiagnostic('connection.probe_result', { generation: generation, status: result.httpStatus,
      phase: result.state === 'ok' ? 0 : result.state === 'unauthorized' ? 1 : result.state === 'forbidden' ? 2 :
        result.state === 'not-dsh' ? 3 : 4, elapsedMs: Date.now() - started });
    this.publish(result.state === 'ok' ? WebConnectionState.Connected : WebConnectionState.Disconnected,
      result.state === 'ok' && recovered, generation);
  }

  private async inspect(status: BrokerStatus, profile: ConnectionProfile,
    generation: number, verifyConnected: boolean): Promise<void> {
    if (!this.current(generation)) {
      return;
    }
    if (status.errorCode === 'DSH_BROKER_AUTH') {
      this.publish(WebConnectionState.AuthenticationRequired, false, generation);
      return;
    }
    if (status.localUrl.replace(/\/$/, '') !== this.origin) {
      this.publish(WebConnectionState.Disconnected, false, generation);
      return;
    }
    if (status.state === 'connected') {
      if (verifyConnected || this.state !== WebConnectionState.Connected || this.recoveryNotice) {
        await this.verify(profile, generation);
      }
      return;
    }
    const recovering = status.state === 'connecting' || status.state === 'reconnecting' ||
      status.state === 'retry_wait';
    this.publish(recovering ? WebConnectionState.Recovering : WebConnectionState.Disconnected, false, generation);
  }

  private async restore(profile: ConnectionProfile, generation: number, verifyEndpoint: boolean): Promise<void> {
    try {
      if (profile.mode === ConnectionMode.Local) {
        if (verifyEndpoint) {
          await this.verify(profile, generation);
        } else {
          this.publish(this.state, false, generation);
        }
        return;
      }
      const status: BrokerStatus = await native.brokerStatus();
      if (!this.current(generation)) {
        return;
      }
      if (status.localUrl.replace(/\/$/, '') === this.origin && status.state === 'paused' &&
        status.errorCode !== 'DSH_BROKER_AUTH') {
        this.publish(WebConnectionState.Recovering, false, generation);
        const accepted: BrokerStatus = await native.brokerReconnect();
        if (accepted.localUrl.replace(/\/$/, '') === this.origin && accepted.state === 'paused' &&
          accepted.errorCode !== 'DSH_BROKER_AUTH') {
          // An accepted request may precede the SDK coordinator's first state transition.
          this.publish(WebConnectionState.Recovering, false, generation);
        } else {
          await this.inspect(accepted, profile, generation, true);
        }
        return;
      }
      await this.inspect(status, profile, generation, verifyEndpoint);
    } catch (error) {
      connectionDiagnosticFailure('connection.restore_failed', error, { generation: generation });
      this.publish(WebConnectionState.Disconnected, false, generation);
    }
  }
}
