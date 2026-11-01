import common from '@ohos.app.ability.common';
import Want from '@ohos.app.ability.Want';

/** Want parameter naming the specified EntryAbility instance that should receive the launch. */
export const WINDOW_KEY_PARAMETER: string = 'dshWindowKey';
/** Want parameter requesting a new window instead of reusing the most recently active one. */
export const NEW_WINDOW_PARAMETER: string = 'dshNewWindow';
/** Want parameter carrying a saved connection id that a new window opens after loading its list. */
export const OPEN_CONNECTION_PARAMETER: string = 'dshOpenConnection';
/** LocalStorage key carrying the window's native broker channel to its pages. */
export const WINDOW_CHANNEL_KEY: string = 'dshWindowChannel';
/** LocalStorage key carrying a one-time open request to the window's connection list. */
export const OPEN_CONNECTION_KEY: string = 'dshOpenConnection';

const WINDOW_KEY_PATTERN: RegExp = /^dsh-window-[1-9][0-9]{0,9}$/;
const MAX_CHANNEL: number = 2147483647;

/** One EntryAbility window: its specified instance key, native broker channel and held connections. */
export class WindowSession {
  readonly key: string;
  readonly channel: number;
  /** Connection whose WebView this window keeps, or ''. */
  connectionId: string = '';
  /** Connection this window is currently opening, or ''. */
  pendingId: string = '';

  constructor(key: string, channel: number) {
    this.key = key;
    this.channel = channel;
  }
}

/**
 * Routes launches between windows of one App process. Every window owns a distinct broker channel, so live
 * connections in different windows never share native mappings; a saved connection is open in at most one window
 * through the App's own controls.
 */
export class WindowRegistry {
  private sessions: Map<string, WindowSession> = new Map<string, WindowSession>();
  private activity: string[] = [];
  private pendingKeys: string[] = [];
  private keyCounter: number = 0;
  private channelCounter: number = 0;
  private windowListeners: Set<() => void> = new Set<() => void>();
  private listListeners: Set<(source: number) => void> = new Set<(source: number) => void>();

  /** Mint a key that no live or pending window uses. */
  createKey(): string {
    let key = '';
    do {
      this.keyCounter = this.keyCounter >= 999999999 ? 1 : this.keyCounter + 1;
      key = 'dsh-window-' + this.keyCounter.toString();
    } while (this.sessions.has(key) || this.pendingKeys.indexOf(key) >= 0);
    return key;
  }

  /**
   * Choose the specified instance for a launch. A live requested key is focused; a requested key with the new-window
   * flag creates that instance; any other launch reuses the most recently active window unless it asks for a new one.
   * @param want Launch Want passed to AbilityStage.onAcceptWant.
   * @returns Specified instance key.
   */
  acceptWant(want: Want): string {
    const requested = requestedKey(want);
    const newWindow = newWindowRequested(want);
    if (requested !== '' && (this.sessions.has(requested) || newWindow)) {
      return requested;
    }
    if (!newWindow) {
      const recent = this.mostRecent();
      if (recent !== undefined) {
        return recent.key;
      }
    }
    const key = this.createKey();
    this.pendingKeys.push(key);
    return key;
  }

  /**
   * Register a created EntryAbility. Its key comes from the launch Want or, for a system launch, from the key
   * `acceptWant` returned for it.
   * @param want Want passed to UIAbility.onCreate.
   * @returns New window with a channel unused by every live window.
   */
  attach(want: Want): WindowSession {
    const requested = requestedKey(want);
    let key = '';
    if (requested !== '' && !this.sessions.has(requested)) {
      key = requested;
      const pending = this.pendingKeys.indexOf(requested);
      if (pending >= 0) {
        this.pendingKeys.splice(pending, 1);
      }
    } else {
      const pending = this.pendingKeys.shift();
      key = pending !== undefined && !this.sessions.has(pending) ? pending : this.createKey();
    }
    const session = new WindowSession(key, this.createChannel());
    this.sessions.set(key, session);
    this.activity.push(key);
    this.notifyWindows();
    return session;
  }

  /** Remove a destroyed window; its connection becomes available to other windows. */
  detach(session: WindowSession): void {
    if (this.sessions.get(session.key) !== session) {
      return;
    }
    this.sessions.delete(session.key);
    this.activity = this.activity.filter((key: string): boolean => key !== session.key);
    this.notifyWindows();
  }

  /** Record the window the user brought to the foreground most recently. */
  activated(session: WindowSession): void {
    if (this.sessions.get(session.key) !== session) {
      return;
    }
    this.activity = this.activity.filter((key: string): boolean => key !== session.key);
    this.activity.push(session.key);
  }

  /** Look up a live window by its broker channel. */
  session(channel: number): WindowSession | undefined {
    return this.live().find((session: WindowSession): boolean => session.channel === channel);
  }

  /** Publish the connection a window holds open, or '' after it closes. */
  hold(channel: number, connectionId: string): void {
    const session = this.session(channel);
    if (session === undefined || session.connectionId === connectionId) {
      return;
    }
    session.connectionId = connectionId;
    this.notifyWindows();
  }

  /** Mark the connection a window starts opening, so other windows switch to it instead of opening it again. */
  claim(channel: number, connectionId: string): void {
    const session = this.session(channel);
    if (session !== undefined && session.pendingId !== connectionId) {
      session.pendingId = connectionId;
      this.notifyWindows();
    }
  }

  /** Clear a finished open attempt; a successful open is already published through `hold`. */
  unclaim(channel: number, connectionId: string): void {
    const session = this.session(channel);
    if (session !== undefined && session.pendingId === connectionId) {
      session.pendingId = '';
      this.notifyWindows();
    }
  }

  /** Find another live window that holds or is opening this connection. */
  holder(connectionId: string, exceptChannel: number): WindowSession | undefined {
    return this.live().find((session: WindowSession): boolean => connectionId !== '' &&
      session.channel !== exceptChannel && (session.connectionId === connectionId || session.pendingId === connectionId));
  }

  /** Connection ids held or being opened by windows other than `channel`, without duplicates. */
  heldElsewhere(channel: number): string[] {
    const ids: string[] = [];
    for (const session of this.live()) {
      for (const id of [session.connectionId, session.pendingId]) {
        if (session.channel !== channel && id !== '' && ids.indexOf(id) < 0) {
          ids.push(id);
        }
      }
    }
    return ids.sort();
  }

  /** Observe window creation, destruction and held connections; returns the unsubscribe function. */
  observeWindows(listener: () => void): () => void {
    this.windowListeners.add(listener);
    return () => {
      this.windowListeners.delete(listener);
    };
  }

  /** Observe committed saved-connection changes; returns the unsubscribe function. */
  observeConnections(listener: (source: number) => void): () => void {
    this.listListeners.add(listener);
    return () => {
      this.listListeners.delete(listener);
    };
  }

  /** Announce a committed saved-connection document written by window `source`. */
  connectionsChanged(source: number): void {
    Array.from(this.listListeners).forEach((listener: (source: number) => void) => {
      try {
        listener(source);
      } catch (error) {
        // A detached page cannot interrupt delivery to the other windows.
      }
    });
  }

  private live(): WindowSession[] {
    return Array.from(this.sessions.values());
  }

  private mostRecent(): WindowSession | undefined {
    for (let index = this.activity.length - 1; index >= 0; index--) {
      const session = this.sessions.get(this.activity[index]);
      if (session !== undefined) {
        return session;
      }
    }
    return undefined;
  }

  private createChannel(): number {
    let channel = 0;
    do {
      this.channelCounter = this.channelCounter >= MAX_CHANNEL ? 1 : this.channelCounter + 1;
      channel = this.channelCounter;
    } while (this.session(channel) !== undefined);
    return channel;
  }

  private notifyWindows(): void {
    Array.from(this.windowListeners).forEach((listener: () => void) => {
      try {
        listener();
      } catch (error) {
        // A detached page cannot interrupt delivery to the other windows.
      }
    });
  }
}

function requestedKey(want: Want): string {
  const value: Object | undefined = want?.parameters ? want.parameters[WINDOW_KEY_PARAMETER] : undefined;
  return typeof value === 'string' && WINDOW_KEY_PATTERN.test(value) ? value : '';
}

function newWindowRequested(want: Want): boolean {
  const value: Object | undefined = want?.parameters ? want.parameters[NEW_WINDOW_PARAMETER] : undefined;
  return value === true || value === 'true';
}

/** Saved connection id that a new window opens once, or ''. */
export function openRequest(want: Want): string {
  const value: Object | undefined = want?.parameters ? want.parameters[OPEN_CONNECTION_PARAMETER] : undefined;
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : '';
}

const registry: WindowRegistry = new WindowRegistry();

/** The registry shared by every EntryAbility window of this App process. */
export function windowRegistry(): WindowRegistry {
  return registry;
}

/**
 * Read the broker channel EntryAbility stored for its window.
 * @param storage LocalStorage passed to `loadContent`.
 * @returns Positive channel number.
 */
export function storageChannel(storage: LocalStorage | undefined): number {
  const channel: number | undefined = storage?.get<number>(WINDOW_CHANNEL_KEY);
  if (channel === undefined || !Number.isSafeInteger(channel) || channel < 1 || channel > MAX_CHANNEL) {
    throw new Error('the window has no broker channel');
  }
  return channel;
}

/**
 * Read and clear the one-time open request EntryAbility stored for its window.
 * @param storage LocalStorage passed to `loadContent`.
 * @returns Saved connection id, or ''.
 */
export function takeOpenRequest(storage: LocalStorage | undefined): string {
  const request: string | undefined = storage?.get<string>(OPEN_CONNECTION_KEY);
  storage?.set<string>(OPEN_CONNECTION_KEY, '');
  return request ?? '';
}

function launchWant(context: common.UIAbilityContext, parameters: Record<string, Object>): Want {
  const want: Want = { bundleName: context.abilityInfo.bundleName, abilityName: context.abilityInfo.name,
    parameters: parameters };
  return want;
}

/**
 * Bring another live window to the foreground through its specified instance key.
 * @param context Context of the requesting window.
 * @param session Target window.
 */
export async function focusWindow(context: common.UIAbilityContext, session: WindowSession): Promise<void> {
  const parameters: Record<string, Object> = {};
  parameters[WINDOW_KEY_PARAMETER] = session.key;
  await context.startAbility(launchWant(context, parameters));
}

/**
 * Create a window that opens `connectionId` after loading its saved connections.
 * @param context Context of the requesting window.
 * @param connectionId Saved connection id.
 */
export async function openInNewWindow(context: common.UIAbilityContext, connectionId: string): Promise<void> {
  const parameters: Record<string, Object> = {};
  parameters[WINDOW_KEY_PARAMETER] = registry.createKey();
  parameters[NEW_WINDOW_PARAMETER] = true;
  parameters[OPEN_CONNECTION_PARAMETER] = connectionId;
  await context.startAbility(launchWant(context, parameters));
}
