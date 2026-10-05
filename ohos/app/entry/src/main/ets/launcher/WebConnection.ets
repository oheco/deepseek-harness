import native, { BrokerStatus, DshProbeResult } from 'libdsh_launcher.so';
import { ConnectionMode, ConnectionProfile } from './ConnectionProfile';

/** Native transport state; a disconnected transport keeps its existing WebView. */
export enum WebConnectionState {
  Connected = 'connected',
  Disconnected = 'disconnected',
  Recovering = 'recovering'
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
  private reading: boolean = false;
  private recoveryNotice: boolean = false;
  private changed: (state: WebConnectionState, recovered: boolean) => void;

  constructor(changed: (state: WebConnectionState, recovered: boolean) => void) {
    this.changed = changed;
  }

  /** Adopt an authenticated SDK mapping; its listener stays owned until explicit close. */
  activate(profile: ConnectionProfile, origin: string): void {
    this.profile = profile;
    this.origin = origin;
    this.generation += 1;
    this.active = true;
    this.state = WebConnectionState.Connected;
    this.recoveryNotice = false;
  }

  /** Suspend App polling and notifications while leaving SDK automatic recovery active. */
  background(): void {
    this.foreground = false;
  }

  /** Verify the endpoint and manually wake a paused SDK peer; repeated events share pending work. */
  foregrounded(): Promise<void> {
    this.foreground = true;
    return this.recover();
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
      this.publish(WebConnectionState.Disconnected, false, generation);
    } finally {
      this.reading = false;
    }
  }

  /** Cancel before joining pending work; retired callbacks cannot restore an explicitly closed page. */
  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    const remote = this.active && this.profile?.mode === ConnectionMode.Remote;
    this.active = false;
    this.generation += 1;
    this.profile = undefined;
    const work = this.finishClose(remote, this.pending);
    this.closing = work;
    work.then(() => {
      if (this.closing === work) {
        this.closing = undefined;
      }
    });
    return work;
  }

  private async finishClose(remote: boolean, pending: Promise<void> | undefined): Promise<void> {
    try {
      if (remote) {
        await native.brokerClose();
      }
    } catch (error) {
      // A failed native close still requires the canceled App operation to settle.
    }
    if (pending) {
      await pending;
    }
  }

  private recover(): Promise<void> {
    if (this.pending) {
      return this.pending;
    }
    const profile = this.profile;
    if (!this.active || !this.foreground || !profile || this.closing) {
      return Promise.resolve();
    }
    const work = this.restore(profile, this.generation);
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
    const result: DshProbeResult = await this.probe(profile.token);
    this.publish(result.state === 'ok' ? WebConnectionState.Connected : WebConnectionState.Disconnected,
      result.state === 'ok' && recovered, generation);
  }

  private async inspect(status: BrokerStatus, profile: ConnectionProfile,
    generation: number, verifyConnected: boolean): Promise<void> {
    if (!this.current(generation)) {
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

  private async restore(profile: ConnectionProfile, generation: number): Promise<void> {
    try {
      if (profile.mode === ConnectionMode.Local) {
        await this.verify(profile, generation);
        return;
      }
      const status: BrokerStatus = await native.brokerStatus();
      if (!this.current(generation)) {
        return;
      }
      if (status.localUrl.replace(/\/$/, '') === this.origin && status.state === 'paused') {
        this.publish(WebConnectionState.Recovering, false, generation);
        const accepted: BrokerStatus = await native.brokerReconnect();
        if (accepted.localUrl.replace(/\/$/, '') === this.origin && accepted.state === 'paused') {
          // An accepted request may precede the SDK coordinator's first state transition.
          this.publish(WebConnectionState.Recovering, false, generation);
        } else {
          await this.inspect(accepted, profile, generation, true);
        }
        return;
      }
      await this.inspect(status, profile, generation, true);
    } catch (error) {
      this.publish(WebConnectionState.Disconnected, false, generation);
    }
  }
}
