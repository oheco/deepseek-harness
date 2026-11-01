import common from '@ohos.app.ability.common';
import util from '@ohos.util';
import native, { BrokerInfo, BrokerConnectOptions, BrokerLoginResult, BrokerStatus, DshProbeResult } from 'libdsh_launcher.so';
import { ConnectionMode, ConnectionProfile, connectionPort, connectionUrl, serviceOrigin, validConnection, parseConnections, encodeConnections } from '../launcher/ConnectionProfile';
import { ConnectionStore } from '../launcher/ConnectionStore';
import { ConnectionField } from './ConnectionField';
import { DiagnosticLogs } from './DiagnosticLogs';
import { connectionDiagnostic, connectionDiagnosticFailure, nextDiagnosticOperation, diagnosticBrokerState } from '../launcher/ConnectionDiagnostics';
import { WindowSession, focusWindow, openInNewWindow, windowRegistry } from '../launcher/WindowRegistry';

/** Parent page delegates system Back to the mounted connection flow. */
export class ConnectionHomeController {
  onBack: (() => boolean) | undefined = undefined;

  back(): boolean {
    return this.onBack ? this.onBack() : false;
  }
}

interface BrokerFailure extends Error {
  code?: string;
}

enum LauncherPage {
  Home = 'home',
  Mode = 'mode',
  Login = 'login',
  Brokers = 'brokers',
  Config = 'config',
  Diagnostics = 'diagnostics'
}

enum ConnectionTestState {
  Idle,
  Testing,
  Success,
  Failure
}

/** Restores the active identity when a service edit is cancelled before choosing its broker. */
class BrokerIdentitySnapshot {
  serviceUrl: string = '';
  account: string = '';
  accessToken: string = '';
  authSessionId: string = '';
  localPort: number = 0;
  brokerId: string = '';
  brokerName: string = '';
  peerPassword: string = '';
}

/** Insert or replace `connection` in the committed list, moving a renewed managed login to its other connections. */
function withSavedConnection(committed: ConnectionProfile[], connection: ConnectionProfile): ConnectionProfile[] {
  const next = committed.filter((item: ConnectionProfile) => item.id !== connection.id)
    .map((item: ConnectionProfile): ConnectionProfile => {
      if (connection.authSessionId === '' || item.mode !== ConnectionMode.Remote ||
        item.serviceUrl !== connection.serviceUrl || item.account !== connection.account) { return item; }
      const updated = parseConnections(encodeConnections([item]))[0];
      updated.authSessionId = connection.authSessionId;
      updated.accessToken = '';
      return updated;
    });
  const oldIndex = committed.findIndex((item: ConnectionProfile) => item.id === connection.id);
  if (oldIndex < 0) {
    next.push(connection);
  } else {
    next.splice(oldIndex, 0, connection);
  }
  return next;
}

/**
 * Owns saved connections and drafts; the parent owns a successfully opened WebView mapping. Every native call uses
 * the window's broker channel, and a connection open in another window is switched to instead of opened twice.
 */
@Component
export struct ConnectionHome {
  controller: ConnectionHomeController = new ConnectionHomeController();
  onOpen: (address: string, remote: boolean, connection: ConnectionProfile) => boolean = () => false;
  onPrepare: (connection: ConnectionProfile) => Promise<boolean> = async () => false;
  onDisconnect: (id: string) => Promise<void> = async () => {};
  /** Returns and clears the saved connection id this window was created to open, or ''. */
  onTakeOpenRequest: () => string = () => '';
  /** Native broker channel owned by this window. */
  channel: number = 0;
  @Prop retainedConnectionId: string = '';
  /** Saved connection ids open in other windows of this App. */
  @Prop heldElsewhere: string[] = [];
  @StorageProp('dshColorMode') private colorMode: number = -1;
  @State private page: LauncherPage = LauncherPage.Home;
  @State private connections: ConnectionProfile[] = [];
  @State private listRevision: number = 0;
  @State private testLabelWidth: number = 0;
  @State private brokers: BrokerInfo[] = [];
  @State private viewportWidth: number = 800;
  @State private busy: boolean = false;
  @State private loaded: boolean = false;
  @State private message: Resource = $r('app.string.connections_loading');
  @State private messageError: boolean = false;
  @State private mode: ConnectionMode = ConnectionMode.Local;
  @State private name: string = '';
  @State private port: string = '3080';
  @State private token: string = '';
  @State private serviceUrl: string = '';
  @State private account: string = '';
  @State private password: string = '';
  @State private accessToken: string = '';
  @State private authSessionId: string = '';
  private localPort: number = 0;
  @State private brokerId: string = '';
  @State private brokerName: string = '';
  @State private peerPassword: string = '';
  @State private editing: boolean = false;
  @State private testState: ConnectionTestState = ConnectionTestState.Idle;
  private editingId: string = '';
  private store: ConnectionStore = new ConnectionStore();
  @State private paths: NavPathStack = new NavPathStack();
  private identityBeforeEdit: BrokerIdentitySnapshot | undefined = undefined;
  private generation: number = 0;
  private attached: boolean = false;
  private transferred: boolean = false;
  private pendingWork: Promise<void> = Promise.resolve();
  private returning: boolean = false;
  private abilityContext: common.UIAbilityContext | undefined = undefined;
  private diagnosticTimer: number = -1;
  private stopObservingConnections: (() => void) | undefined = undefined;

  private observeOperation(operation: number, generation: number, phase: number): void {
    clearInterval(this.diagnosticTimer);
    const started = Date.now();
    connectionDiagnostic('home.phase', { operation: operation, generation: generation, phase: phase });
    this.diagnosticTimer = setInterval(() => connectionDiagnostic('home.phase_pending', {
      operation: operation, generation: generation, phase: phase, elapsedMs: Date.now() - started,
      attached: this.attached, current: generation === this.generation }), 5000);
  }

  private runTask(action: () => Promise<void>): void {
    this.pendingWork = action();
    this.pendingWork.catch((error: Error) => {
      if (this.attached) {
        this.busy = false;
        this.feedback($r('app.string.web_action_failed'), true);
      }
    });
  }

  aboutToAppear(): void {
    this.abilityContext = getContext(this) as common.UIAbilityContext;
    this.attached = true;
    this.controller.onBack = () => this.handleBack();
    this.stopObservingConnections = windowRegistry().observeConnections((source: number) => {
      if (source !== this.channel) {
        this.refreshConnections();
      }
    });
    this.runTask(() => this.loadInitialConnections());
  }

  aboutToDisappear(): void {
    connectionDiagnostic('home.disappeared', { generation: this.generation });
    clearInterval(this.diagnosticTimer);
    this.attached = false;
    this.generation += 1;
    this.controller.onBack = undefined;
    if (this.stopObservingConnections) {
      this.stopObservingConnections();
      this.stopObservingConnections = undefined;
    }
    this.disposeFlow().catch((error: Error) => {
      // A detached page cannot publish cleanup diagnostics.
    });
  }

  private async disposeFlow(): Promise<void> {
    if (!this.transferred) {
      try {
        await native.brokerClose(this.channel);
      } catch (error) {
        // The owner has already requested cancellation before awaiting the UI operation.
      }
    }
    try {
      await this.pendingWork;
    } catch (error) {
      // Cancelled operations settle before the detached flow is released.
    }
  }

  private context(): common.UIAbilityContext {
    if (this.abilityContext === undefined) {
      throw new Error('the connection page is not mounted');
    }
    return this.abilityContext;
  }

  private feedback(message: Resource, error: boolean = false): void {
    this.message = message;
    this.messageError = error;
  }

  /** Rows capture a profile snapshot, so each committed list gets fresh rendering keys and callbacks. */
  private publishConnections(connections: ConnectionProfile[]): void {
    this.listRevision += 1;
    this.connections = connections;
  }

  /** Loads the list, then opens the connection a new window was created for. */
  private async loadInitialConnections(): Promise<void> {
    await this.loadConnections();
    const request = this.onTakeOpenRequest();
    const connection = this.connections.find((item: ConnectionProfile): boolean => item.id === request);
    if (request !== '' && this.attached && this.loaded && connection !== undefined) {
      await this.openConnection(connection);
    }
  }

  /** Publishes another window's committed list without cancelling this window's current operation. */
  private refreshConnections(): void {
    if (!this.attached || !this.loaded) {
      return;
    }
    this.store.read().then((connections: ConnectionProfile[]) => {
      if (this.attached && this.loaded) {
        this.publishConnections(connections);
      }
    }, (error: Error) => {
      connectionDiagnosticFailure('home.refresh_failed', error, { channel: this.channel });
    });
  }

  /** Tells other windows that this window committed the shared list. */
  private announceConnections(): void {
    windowRegistry().connectionsChanged(this.channel);
  }

  private async loadConnections(): Promise<void> {
    const generation = ++this.generation;
    this.busy = true;
    try {
      const connections = await this.store.load(this.context());
      if (this.attached && generation === this.generation) {
        this.publishConnections(connections);
        this.loaded = true;
        this.feedback($r('app.string.connections_hint'));
      }
    } catch (error) {
      if (this.attached && generation === this.generation) {
        this.loaded = false;
        this.feedback($r('app.string.connections_load_failed'), true);
      }
    } finally {
      if (this.attached && generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private navigate(page: LauncherPage): void {
    if (page !== this.page) {
      this.page = page;
      this.paths.pushPath({ name: page }, true);
    }
  }

  private handleBack(): boolean {
    if (this.currentPage() === LauncherPage.Diagnostics) {
      this.paths.pop();
      this.page = this.currentPage();
      return true;
    }
    if (this.paths.size() === 0 && !this.busy) {
      return false;
    }
    this.goBack();
    return true;
  }

  private async goBack(): Promise<void> {
    if (this.returning) {
      return;
    }
    this.returning = true;
    this.generation += 1;
    this.busy = true;
    const work = this.pendingWork;
    try {
      if (!this.transferred) {
        await native.brokerClose(this.channel);
      }
    } catch (error) {
      // A failed close still leaves pending UI work to settle before the route is popped.
    }
    try {
      await work;
    } catch (error) {
      // Cancelled work cannot publish a draft or transfer a mapping.
    }
    if (!this.attached) {
      return;
    }
    if (this.page === LauncherPage.Login && this.identityBeforeEdit !== undefined) {
      this.restoreIdentity();
    }
    this.paths.pop(true);
    this.page = this.currentPage();
    this.feedback($r('app.string.connections_hint'));
    if (this.page === LauncherPage.Home) {
      this.password = '';
      await this.loadConnections();
      }
    this.busy = false;
    this.returning = false;
  }

  private resetDraft(): void {
    this.identityBeforeEdit = undefined;
    this.editingId = '';
    this.editing = false;
    this.mode = ConnectionMode.Local;
    this.name = '';
    this.port = '3080';
    this.token = '';
    this.serviceUrl = '';
    this.account = '';
    this.password = '';
    this.accessToken = '';
    this.authSessionId = '';
    this.localPort = 0;
    this.brokerId = '';
    this.brokerName = '';
    this.peerPassword = '';
    this.testState = ConnectionTestState.Idle;
    this.feedback($r('app.string.choose_mode_hint'));
  }

  private addConnection(): void {
    this.resetDraft();
    this.navigate(LauncherPage.Mode);
  }

  private chooseMode(mode: ConnectionMode): void {
    this.mode = mode;
    this.testState = ConnectionTestState.Idle;
    this.feedback($r(mode === ConnectionMode.Local ? 'app.string.local_hint' : 'app.string.remote_login_hint'));
    this.navigate(mode === ConnectionMode.Local ? LauncherPage.Config : LauncherPage.Login);
  }

  private editConnection(connection: ConnectionProfile): void {
    this.identityBeforeEdit = undefined;
    this.editingId = connection.id;
    this.editing = true;
    this.testState = ConnectionTestState.Idle;
    this.mode = connection.mode;
    this.name = connection.name;
    this.port = connection.port.toString();
    this.token = connection.token;
    this.serviceUrl = connection.serviceUrl;
    this.account = connection.account;
    this.password = '';
    this.accessToken = connection.accessToken;
    this.authSessionId = connection.authSessionId;
    this.localPort = connection.localPort;
    this.brokerId = connection.brokerId;
    this.brokerName = connection.brokerName;
    this.peerPassword = connection.peerPassword;
    this.feedback($r('app.string.edit_connection_hint'));
    this.navigate(LauncherPage.Config);
  }

  private profile(): ConnectionProfile {
    const connection = new ConnectionProfile();
    connection.id = this.editingId || util.generateRandomUUID();
    connection.name = this.name.trim();
    connection.mode = this.mode;
    connection.port = connectionPort(this.port);
    connection.token = this.token;
    if (this.mode === ConnectionMode.Remote) {
      connection.serviceUrl = serviceOrigin(this.serviceUrl);
      connection.account = this.account.trim();
      connection.accessToken = this.accessToken;
      connection.authSessionId = this.authSessionId;
      connection.localPort = this.localPort;
      connection.brokerId = this.brokerId;
      connection.brokerName = this.brokerName;
      connection.peerPassword = this.peerPassword;
    }
    return connection;
  }

  private draftValid(requireName: boolean = true): boolean {
    if (requireName && this.name.trim() === '') {
      this.feedback($r('app.string.name_required'), true);
      return false;
    }
    if (connectionPort(this.port) === 0) {
      this.feedback($r('app.string.port_invalid'), true);
      return false;
    }
    if (this.token.trim() === '' || /[\x00\r\n]/.test(this.token)) {
      this.feedback($r('app.string.token_required'), true);
      return false;
    }
    if (this.mode === ConnectionMode.Remote && (this.brokerId === '' || (this.accessToken === '' && this.authSessionId === '') ||
      serviceOrigin(this.serviceUrl) === '' || this.peerPassword === '')) {
      this.feedback($r('app.string.remote_config_required'), true);
      return false;
    }
    return true;
  }

  private async saveConnection(): Promise<void> {
    if (this.busy || !this.loaded || !this.draftValid()) {
      return;
    }
    const connection = this.profile();
    if (!validConnection(connection)) {
      this.feedback($r('app.string.connection_invalid'), true);
      return;
    }
    if (windowRegistry().holder(connection.id, this.channel) !== undefined) {
      this.feedback($r('app.string.connection_open_elsewhere'), true);
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    try {
      await this.releaseRetained();
      const next = await this.store.update((committed: ConnectionProfile[]) => withSavedConnection(committed, connection));
      this.announceConnections();
      if (this.attached && generation === this.generation) {
        this.publishConnections(next);
        this.page = LauncherPage.Home;
        this.paths.clear(true);
        this.identityBeforeEdit = undefined;
        this.password = '';
        this.feedback($r('app.string.connection_saved'));
          }
    } catch (error) {
      if (this.attached && generation === this.generation) {
        this.feedback($r('app.string.connection_save_failed'), true);
      }
    } finally {
      if (this.attached && generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private async deleteConnection(): Promise<void> {
    if (this.busy || !this.editing) {
      return;
    }
    const id = this.editingId;
    if (windowRegistry().holder(id, this.channel) !== undefined) {
      this.feedback($r('app.string.connection_open_elsewhere'), true);
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    try {
      await this.releaseRetained();
      const next = await this.store.update((committed: ConnectionProfile[]) =>
        committed.filter((item: ConnectionProfile) => item.id !== id));
      this.announceConnections();
      if (this.attached && generation === this.generation) {
        this.publishConnections(next);
        this.page = LauncherPage.Home;
        this.paths.clear(true);
        this.identityBeforeEdit = undefined;
        this.password = '';
        this.feedback($r('app.string.connection_deleted'));
      }
    } catch (error) {
      if (this.attached && generation === this.generation) {
        this.feedback($r('app.string.connection_save_failed'), true);
      }
    } finally {
      if (this.attached && generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private changeService(value: string): void {
    if (value !== this.serviceUrl) {
      this.testState = ConnectionTestState.Idle;
      this.accessToken = '';
      this.authSessionId = '';
      this.localPort = 0;
      this.brokerId = '';
      this.brokerName = '';
      this.peerPassword = '';
    }
    this.serviceUrl = value;
  }

  private changeAccount(value: string): void {
    if (value !== this.account) {
      this.testState = ConnectionTestState.Idle;
      this.accessToken = '';
      this.authSessionId = '';
      this.localPort = 0;
      this.brokerId = '';
      this.brokerName = '';
      this.peerPassword = '';
    }
    this.account = value;
  }

  private async login(): Promise<void> {
    const origin = serviceOrigin(this.serviceUrl);
    if (origin === '' || this.account.trim() === '' || this.password === '') {
      this.feedback($r('app.string.login_required'), true);
      return;
    }
    if (this.busy) {
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    this.feedback($r('app.string.broker_logging_in'));
    try {
      await this.releaseRetained();
      if (!this.attached || generation !== this.generation) { return; }
      const session: BrokerLoginResult = await native.brokerLogin({ channel: this.channel, serviceUrl: origin, account: this.account.trim(),
        password: this.password, tempDir: this.context().tempDir + '/dsh-broker',
        credentialDir: this.context().filesDir + '/dsh-broker-auth' });
      if (!this.attached || generation !== this.generation) {
        return;
      }
      this.password = '';
      this.serviceUrl = origin;
      this.accessToken = session.accessToken;
      this.authSessionId = session.authSessionId;
      const brokers: BrokerInfo[] = await native.brokerList({ channel: this.channel, serviceUrl: origin, accessToken: session.accessToken,
        authSessionId: session.authSessionId, credentialDir: this.context().filesDir + '/dsh-broker-auth',
        tempDir: this.context().tempDir + '/dsh-broker' });
      if (this.attached && generation === this.generation) {
        this.brokers = brokers;
        if (this.identityBeforeEdit !== undefined &&
          this.identityBeforeEdit.serviceUrl === origin && this.identityBeforeEdit.account === this.account.trim() &&
          brokers.some((broker: BrokerInfo): boolean => broker.id === this.identityBeforeEdit?.brokerId && broker.online)) {
          this.brokerId = this.identityBeforeEdit.brokerId;
          this.brokerName = this.identityBeforeEdit.brokerName;
          this.peerPassword = this.identityBeforeEdit.peerPassword;
          this.identityBeforeEdit = undefined;
          this.feedback($r('app.string.remote_config_hint'));
          this.returnToConfig();
        } else {
          this.feedback($r('app.string.brokers_hint'));
          this.navigate(LauncherPage.Brokers);
        }
      }
    } catch (error) {
      if (this.attached && generation === this.generation) {
        this.feedback($r('app.string.broker_login_failed'), true);
      }
    } finally {
      if (this.attached && generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private async changeBroker(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (this.accessToken === '' && this.authSessionId === '') {
      this.navigate(LauncherPage.Login);
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    try {
      const brokers: BrokerInfo[] = await native.brokerList({ channel: this.channel, serviceUrl: serviceOrigin(this.serviceUrl),
        accessToken: this.accessToken, authSessionId: this.authSessionId,
        credentialDir: this.context().filesDir + '/dsh-broker-auth', tempDir: this.context().tempDir + '/dsh-broker' });
      if (this.attached && generation === this.generation) {
        this.brokers = brokers;
        this.feedback($r('app.string.brokers_hint'));
        this.navigate(LauncherPage.Brokers);
      }
    } catch (error) {
      if (this.attached && generation === this.generation) {
        this.feedback($r('app.string.broker_login_failed'), true);
        this.navigate(LauncherPage.Login);
      }
    } finally {
      if (this.attached && generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private selectBroker(broker: BrokerInfo): void {
    if (this.busy || !broker.online) {
      return;
    }
    this.testState = ConnectionTestState.Idle;
    if (broker.id !== this.brokerId) {
      this.peerPassword = '';
      this.localPort = 0;
    }
    this.brokerId = broker.id;
    this.brokerName = broker.name;
    if (this.name.trim() === '') {
      this.name = broker.name;
    }
    this.identityBeforeEdit = undefined;
    this.feedback($r('app.string.remote_config_hint'));
    this.returnToConfig();
  }

  private async releaseRetained(): Promise<void> {
    if (this.retainedConnectionId !== '') {
      await this.onDisconnect(this.retainedConnectionId);
    }
    this.transferred = false;
  }

  private async disconnectSaved(id: string): Promise<void> {
    if (this.busy) {
      connectionDiagnostic('home.disconnect_busy', { generation: this.generation });
      return;
    }
    const operation = nextDiagnosticOperation();
    const started = Date.now();
    connectionDiagnostic('home.disconnect_begin', { operation: operation, generation: this.generation });
    this.busy = true;
    this.observeOperation(operation, this.generation, 5);
    try {
      await this.onDisconnect(id);
      this.transferred = false;
      this.feedback($r('app.string.connection_disconnected'));
      connectionDiagnostic('home.disconnect_complete', { operation: operation, elapsedMs: Date.now() - started });
    } catch (error) {
      connectionDiagnosticFailure('home.disconnect_failed', error, { operation: operation, elapsedMs: Date.now() - started });
      this.feedback($r('app.string.broker_connection_failed'), true);
    } finally {
      clearInterval(this.diagnosticTimer);
      this.busy = false;
    }
  }

  private async rememberPort(connection: ConnectionProfile, port: number): Promise<void> {
    if (connection.localPort === port) { return; }
    const next = await this.store.update((committed: ConnectionProfile[]): ConnectionProfile[] => {
      if (!committed.some((item: ConnectionProfile): boolean => item.id === connection.id)) { return committed; }
      return committed.map((item: ConnectionProfile): ConnectionProfile => {
        if (item.id !== connection.id) { return item; }
        const updated = parseConnections(encodeConnections([item]))[0];
        updated.localPort = port;
        return updated;
      });
    });
    if (next.some((item: ConnectionProfile): boolean => item.id === connection.id)) {
      this.announceConnections();
      if (this.attached) { this.publishConnections(next); }
    }
    connection.localPort = port;
    if (this.editingId === connection.id) { this.localPort = port; }
  }

  private remoteOptions(connection: ConnectionProfile): BrokerConnectOptions {
    return { channel: this.channel, serviceUrl: connection.serviceUrl, accessToken: connection.accessToken,
      authSessionId: connection.authSessionId, credentialDir: this.context().filesDir + '/dsh-broker-auth',
      brokerId: connection.brokerId, peerPassword: connection.peerPassword, localPort: connection.localPort,
      remotePort: connection.port, tempDir: this.context().tempDir + '/dsh-broker' };
  }

  private probeFeedback(result: DshProbeResult): void {
    switch (result.state) {
      case 'ok': this.feedback($r('app.string.connection_test_ok')); break;
      case 'unauthorized': this.feedback($r('app.string.connection_token_failed'), true); break;
      case 'forbidden': this.feedback($r('app.string.connection_forbidden'), true); break;
      case 'not-dsh': this.feedback($r('app.string.connection_not_dsh'), true); break;
      default: this.feedback($r('app.string.connection_unreachable'), true); break;
    }
  }

  private brokerFailure(error: BrokerFailure, saved: ConnectionProfile | undefined = undefined): void {
    if (error && error.code === 'DSH_BROKER_AUTH') {
      if (saved) {
        this.editConnection(saved);
      }
      this.accessToken = '';
      this.authSessionId = '';
      this.password = '';
      this.feedback($r('app.string.broker_login_expired'), true);
      this.navigate(LauncherPage.Login);
    } else {
      this.feedback($r('app.string.broker_connection_failed'), true);
    }
  }

  private async testConnection(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (!this.draftValid(false)) {
      this.testState = ConnectionTestState.Failure;
      return;
    }
    const connection = this.profile();
    const generation = ++this.generation;
    this.busy = true;
    this.testState = ConnectionTestState.Testing;
    let mappingAttempted = false;
    this.feedback($r(connection.mode === ConnectionMode.Local ? 'app.string.local_hint' : 'app.string.remote_config_hint'));
    try {
      await this.releaseRetained();
      if (!this.attached || generation !== this.generation) { return; }
      let origin = 'http://127.0.0.1:' + connection.port.toString();
      if (connection.mode === ConnectionMode.Remote) {
        mappingAttempted = true;
        const mapping: BrokerStatus = await native.brokerConnect(this.remoteOptions(connection));
        if (!this.attached || generation !== this.generation) { return; }
        await this.rememberPort(connection, mapping.localPort);
        origin = mapping.localUrl.replace(/\/$/, '');
      }
      if (!this.attached || generation !== this.generation) {
        return;
      }
      const result: DshProbeResult = await native.dshProbe({ channel: this.channel, origin: origin, token: connection.token });
      if (this.attached && generation === this.generation) {
        this.testState = result.state === 'ok' ? ConnectionTestState.Success : ConnectionTestState.Failure;
        if (result.state !== 'ok') {
          this.probeFeedback(result);
        }
      }
    } catch (error) {
      if (this.attached && generation === this.generation) {
        this.testState = ConnectionTestState.Failure;
        this.brokerFailure(error as BrokerFailure);
      }
    } finally {
      try {
        if (mappingAttempted) {
          await native.brokerClose(this.channel);
        }
      } catch (error) {
        if (this.attached && generation === this.generation) {
          this.testState = ConnectionTestState.Failure;
          this.feedback($r('app.string.broker_connection_failed'), true);
        }
      } finally {
        if (this.attached && generation === this.generation) {
          this.busy = false;
        }
      }
    }
  }

  /** Brings the window that holds a connection to the foreground. */
  private async switchToWindow(session: WindowSession): Promise<void> {
    connectionDiagnostic('home.switch_window', { channel: this.channel, targetChannel: session.channel });
    try {
      await focusWindow(this.context(), session);
      if (this.attached) { this.feedback($r('app.string.connection_switched_window')); }
    } catch (error) {
      connectionDiagnosticFailure('home.switch_window_failed', error, { channel: this.channel });
      if (this.attached) { this.feedback($r('app.string.window_action_failed'), true); }
    }
  }

  /** Switches to the window holding `connection` without waiting for this window's current operation. */
  private async switchToHolder(connection: ConnectionProfile): Promise<void> {
    const holder = windowRegistry().holder(connection.id, this.channel);
    if (holder !== undefined) {
      await this.switchToWindow(holder);
    }
  }

  /** Opens a saved connection in a new window, or switches to the window that already holds it. */
  private async openNewWindow(connection: ConnectionProfile): Promise<void> {
    if (this.busy) {
      return;
    }
    const holder = windowRegistry().holder(connection.id, this.channel);
    if (holder !== undefined) {
      await this.switchToWindow(holder);
      return;
    }
    connectionDiagnostic('home.new_window', { channel: this.channel });
    try {
      await openInNewWindow(this.context(), connection.id);
      if (this.attached) { this.feedback($r('app.string.new_window_opening')); }
    } catch (error) {
      connectionDiagnosticFailure('home.new_window_failed', error, { channel: this.channel });
      if (this.attached) { this.feedback($r('app.string.window_action_failed'), true); }
    }
  }

  private async openConnection(connection: ConnectionProfile): Promise<void> {
    if (this.busy) {
      connectionDiagnostic('home.open_busy', { generation: this.generation });
      return;
    }
    const holder = windowRegistry().holder(connection.id, this.channel);
    if (holder !== undefined) {
      await this.switchToWindow(holder);
      return;
    }
    const operation = nextDiagnosticOperation();
    const started = Date.now();
    const generation = ++this.generation;
    const remote = connection.mode === ConnectionMode.Remote;
    connectionDiagnostic('home.open_begin', { operation: operation, generation: generation, remote: remote });
    windowRegistry().claim(this.channel, connection.id);
    this.busy = true;
    this.feedback($r('app.string.opening'));
    let opened = false;
    let mappingAttempted = false;
    try {
      this.observeOperation(operation, generation, 1);
      if (await this.onPrepare(connection)) {
        opened = true;
        this.transferred = true;
        connectionDiagnostic('home.open_retained', { operation: operation, generation: generation });
        return;
      }
      this.transferred = false;
      if (!this.attached || generation !== this.generation) { return; }
      let origin = 'http://127.0.0.1:' + connection.port.toString();
      if (remote) {
        mappingAttempted = true;
        this.observeOperation(operation, generation, 2);
        const mapping: BrokerStatus = await native.brokerConnect(this.remoteOptions(connection));
        connectionDiagnostic('home.broker_connected', { operation: operation, generation: generation,
          state: diagnosticBrokerState(mapping.state) });
        if (!this.attached || generation !== this.generation) { return; }
        await this.rememberPort(connection, mapping.localPort);
        origin = mapping.localUrl.replace(/\/$/, '');
      }
      if (!this.attached || generation !== this.generation) { return; }
      this.observeOperation(operation, generation, 3);
      const result: DshProbeResult = await native.dshProbe({ channel: this.channel, origin: origin, token: connection.token });
      connectionDiagnostic('home.probe_complete', { operation: operation, generation: generation,
        status: result.httpStatus, phase: result.state === 'ok' ? 1 : 0 });
      if (!this.attached || generation !== this.generation) { return; }
      if (result.state !== 'ok') {
        this.probeFeedback(result);
        return;
      }
      const address = connectionUrl(origin, connection.token);
      this.transferred = true;
      try {
        this.observeOperation(operation, generation, 4);
        if (!this.onOpen(address, remote, connection)) {
          connectionDiagnostic('home.handoff_refused', { operation: operation, generation: generation });
          throw new Error('WebView handoff was refused');
        }
        opened = true;
        connectionDiagnostic('home.handoff_complete', { operation: operation, generation: generation });
      } catch (error) {
        connectionDiagnosticFailure('home.handoff_failed', error, { operation: operation, generation: generation });
        this.transferred = false;
        throw new Error('WebView handoff failed');
      }
    } catch (error) {
      connectionDiagnosticFailure('home.open_failed', error, { operation: operation, generation: generation });
      if (this.attached && generation === this.generation) {
        this.brokerFailure(error as BrokerFailure, remote ? connection : undefined);
      }
    } finally {
      try {
        if (!opened && mappingAttempted) {
          connectionDiagnostic('home.failed_open_cleanup', { operation: operation, generation: generation });
          await native.brokerClose(this.channel);
        }
      } catch (error) {
        connectionDiagnosticFailure('home.failed_open_cleanup_failed', error, { operation: operation, generation: generation });
        if (this.attached && generation === this.generation) {
          this.feedback($r('app.string.broker_connection_failed'), true);
        }
      } finally {
        windowRegistry().unclaim(this.channel, connection.id);
        clearInterval(this.diagnosticTimer);
        connectionDiagnostic('home.open_end', { operation: operation, generation: generation,
          current: this.attached && generation === this.generation, elapsedMs: Date.now() - started, phase: opened ? 1 : 0 });
        if (this.attached && generation === this.generation) { this.busy = false; }
      }
    }
  }

  private currentPage(): LauncherPage {
    const names = this.paths.getAllPathName();
    return names.length === 0 ? LauncherPage.Home : this.pageForName(names[names.length - 1]);
  }

  private pageForName(name: string): LauncherPage {
    switch (name) {
      case LauncherPage.Mode: return LauncherPage.Mode;
      case LauncherPage.Login: return LauncherPage.Login;
      case LauncherPage.Brokers: return LauncherPage.Brokers;
      case LauncherPage.Config: return LauncherPage.Config;
      case LauncherPage.Diagnostics: return LauncherPage.Diagnostics;
      default: throw new Error('unsupported connection destination');
    }
  }

  private returnToConfig(): void {
    const indexes = this.paths.getIndexByName(LauncherPage.Config);
    if (indexes.length > 0) {
      this.paths.popToIndex(indexes[indexes.length - 1], true);
      this.page = LauncherPage.Config;
    } else {
      this.navigate(LauncherPage.Config);
    }
  }

  private modifyService(): void {
    if (this.busy) {
      return;
    }
    const identity = new BrokerIdentitySnapshot();
    identity.serviceUrl = this.serviceUrl;
    identity.account = this.account;
    identity.accessToken = this.accessToken;
    identity.authSessionId = this.authSessionId;
    identity.localPort = this.localPort;
    identity.brokerId = this.brokerId;
    identity.brokerName = this.brokerName;
    identity.peerPassword = this.peerPassword;
    this.identityBeforeEdit = identity;
    this.password = '';
    this.feedback($r('app.string.remote_login_hint'));
    this.navigate(LauncherPage.Login);
  }

  private restoreIdentity(): void {
    const identity = this.identityBeforeEdit;
    if (identity === undefined) {
      return;
    }
    this.serviceUrl = identity.serviceUrl;
    this.account = identity.account;
    this.accessToken = identity.accessToken;
    this.authSessionId = identity.authSessionId;
    this.localPort = identity.localPort;
    this.brokerId = identity.brokerId;
    this.brokerName = identity.brokerName;
    this.peerPassword = identity.peerPassword;
    this.password = '';
    this.identityBeforeEdit = undefined;
    this.testState = ConnectionTestState.Idle;
  }

  private title(page: LauncherPage = this.page): Resource {
    switch (page) {
      case LauncherPage.Mode: return $r('app.string.add_connection');
      case LauncherPage.Login: return $r('app.string.remote_login');
      case LauncherPage.Brokers: return $r('app.string.choose_broker');
      case LauncherPage.Config: return $r(this.mode === ConnectionMode.Local ? 'app.string.local_settings' : 'app.string.remote_settings');
      case LauncherPage.Diagnostics: return $r('app.string.diagnostics_title');
      default: return $r('app.string.connections_title');
    }
  }

  @Builder
  private status() {
    Row({ space: 10 }) {
      LoadingProgress().width(20).height(20).color($r('app.color.accent'))
        .visibility(this.busy && this.page !== LauncherPage.Config ? Visibility.Visible : Visibility.Hidden)
      Text(this.message).fontSize(13).fontColor($r(this.messageError ? 'app.color.warning' : 'app.color.muted'))
        .layoutWeight(1).maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
    }.width('100%').height(56).padding({ top: 12, bottom: 12 })
  }

  @Builder
  private connectionRow(connection: ConnectionProfile) {
    Row({ space: 12 }) {
      Button({ type: ButtonType.Normal }) {
        Column({ space: 6 }) {
          Text(connection.name).fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Row({ space: 8 }) {
            Text($r(connection.mode === ConnectionMode.Local ? 'app.string.mode_local' : 'app.string.mode_remote'))
              .fontSize(12).fontColor($r('app.color.accent'))
            Text(connection.mode === ConnectionMode.Local ? '127.0.0.1:' + connection.port.toString() :
              connection.brokerName + ' · ' + connection.port.toString())
              .fontSize(12).fontColor($r('app.color.muted')).maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
          }.width('100%')
        }.alignItems(HorizontalAlign.Start).width('100%')
      }.layoutWeight(1).constraintSize({ minHeight: 80 }).padding(16)
      .backgroundColor(Color.Transparent).borderRadius(12)
      .enabled(!this.busy).onClick(() => this.runTask(() => this.openConnection(connection)))
      if (this.retainedConnectionId === connection.id) {
        Button($r('app.string.disconnect_connection')).fontSize(13).height(40)
          .backgroundColor($r('app.color.canvas')).fontColor($r('app.color.ink'))
          .enabled(!this.busy).onClick(() => this.runTask(() => this.disconnectSaved(connection.id)))
      } else if (this.heldElsewhere.includes(connection.id)) {
        Button($r('app.string.switch_window')).fontSize(13).height(40)
          .backgroundColor($r('app.color.canvas')).fontColor($r('app.color.ink'))
          .onClick(() => { this.switchToHolder(connection); })
      } else if (this.viewportWidth >= 600) {
        Button($r('app.string.open_new_window')).fontSize(13).height(40)
          .backgroundColor($r('app.color.canvas')).fontColor($r('app.color.ink'))
          .enabled(!this.busy).onClick(() => this.runTask(() => this.openNewWindow(connection)))
      }
      Button($r('app.string.edit_connection')).fontSize(13).height(40).margin({ right: 12 })
        .backgroundColor($r('app.color.canvas')).fontColor($r('app.color.ink'))
        .enabled(!this.busy && !this.heldElsewhere.includes(connection.id)).onClick(() => this.editConnection(connection))
    }.width('100%').backgroundColor($r('app.color.card')).borderRadius(16)
    .border({ width: 1, color: $r('app.color.border') })
  }

  @Builder
  private homePage() {
    Column({ space: 16 }) {
      if (this.connections.length === 0) {
        Column({ space: 10 }) {
          Text($r('app.string.connections_empty')).fontSize(19).fontColor($r('app.color.ink'))
          Text($r('app.string.connections_empty_hint')).fontSize(14).fontColor($r('app.color.muted'))
            .textAlign(TextAlign.Center)
        }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center)
      } else {
        List({ space: 12 }) {
          ForEach(this.connections, (connection: ConnectionProfile) => {
            ListItem() {
              this.connectionRow(connection)
            }
          }, (connection: ConnectionProfile) => connection.id + ':' + this.listRevision.toString())
        }.layoutWeight(1).width('100%')
      }
      if (!this.loaded && !this.busy) {
        Button($r('app.string.retry')).onClick(() => this.runTask(() => this.loadConnections()))
      }
      Row() {
        Button('+', { type: ButtonType.Circle }).fontSize(32).width(56).height(56)
          .backgroundColor($r('app.color.accent')).fontColor($r('app.color.on_accent'))
          .accessibilityText($r('app.string.add_connection')).enabled(this.loaded && !this.busy)
          .onClick(() => this.addConnection())
      }.width('100%').justifyContent(FlexAlign.Center).padding({ bottom: 16 })
    }.width('100%').layoutWeight(1)
  }

  @Builder
  private modePage() {
    Column({ space: 20 }) {
      Button($r('app.string.mode_local')).width('100%').height(60).fontSize(18)
        .backgroundColor($r('app.color.card')).fontColor($r('app.color.ink'))
        .border({ width: 1, color: $r('app.color.border') }).onClick(() => this.chooseMode(ConnectionMode.Local))
      Button($r('app.string.mode_remote')).width('100%').height(60).fontSize(18)
        .backgroundColor($r('app.color.card')).fontColor($r('app.color.ink'))
        .border({ width: 1, color: $r('app.color.border') }).onClick(() => this.chooseMode(ConnectionMode.Remote))
    }.width('100%').padding({ top: 32 })
  }

  @Builder
  private loginPage() {
    Column({ space: 18 }) {
      ConnectionField({ label: $r('app.string.service_address'), value: this.serviceUrl, locked: this.busy, onEdited: (value: string) => this.changeService(value) })
      Text($r('app.string.service_address_hint')).fontSize(12).fontColor($r('app.color.muted'))
        .width('100%')
      ConnectionField({ label: $r('app.string.broker_account'), value: this.account, locked: this.busy, onEdited: (value: string) => this.changeAccount(value) })
      ConnectionField({ label: $r('app.string.broker_password'), value: this.password, secret: true, locked: this.busy })
      Text($r('app.string.ca_system_trust')).fontSize(12).fontColor($r('app.color.muted')).width('100%')
      Button($r('app.string.broker_login')).width('100%').height(48)
        .backgroundColor($r('app.color.accent')).fontColor($r('app.color.on_accent'))
        .enabled(!this.busy).onClick(() => this.runTask(() => this.login()))
    }.width('100%')
  }

  @Builder
  private brokersPage() {
    Column({ space: 12 }) {
      if (!this.brokers.some((broker: BrokerInfo): boolean => broker.online)) {
        Text($r('app.string.brokers_empty')).fontSize(15).fontColor($r('app.color.muted')).padding(24)
      }
      ForEach(this.brokers, (broker: BrokerInfo) => {
        Button({ type: ButtonType.Normal }) {
          Row({ space: 12 }) {
            Text(broker.name).fontSize(17).fontColor($r('app.color.ink')).layoutWeight(1)
            Text($r(broker.online ? 'app.string.broker_online' : 'app.string.broker_offline'))
              .fontSize(12).fontColor($r('app.color.muted'))
          }.width('100%')
        }.width('100%').height(64).padding(16).borderRadius(12).backgroundColor($r('app.color.card'))
        .border({ width: 1, color: $r('app.color.border') }).enabled(broker.online && !this.busy)
        .onClick(() => this.selectBroker(broker))
      }, (broker: BrokerInfo) => broker.id)
      Button($r('app.string.refresh_brokers')).enabled(!this.busy).onClick(() => this.runTask(() => this.changeBroker()))
    }.width('100%')
  }

  @Builder
  private configPage() {
    Column({ space: 18 }) {
      ConnectionField({ label: $r('app.string.connection_name'), value: this.name, locked: this.busy })
      if (this.mode === ConnectionMode.Remote) {
        Row({ space: 12 }) {
          Column({ space: 6 }) {
            Text($r('app.string.broker_service')).fontSize(14).fontColor($r('app.color.muted'))
            Text(this.serviceUrl).fontSize(15).fontColor($r('app.color.ink')).maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.account).fontSize(13).fontColor($r('app.color.muted')).maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          Button($r('app.string.modify')).height(40).fontSize(14).enabled(!this.busy)
            .backgroundColor(Color.Transparent).fontColor($r('app.color.accent'))
            .onClick(() => this.modifyService())
        }.width('100%').padding(16).backgroundColor($r('app.color.card')).borderRadius(12)
        Row({ space: 12 }) {
          Column({ space: 6 }) {
            Text($r('app.string.selected_broker')).fontSize(14).fontColor($r('app.color.muted'))
            Text(this.brokerName).fontSize(15).fontColor($r('app.color.ink')).maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          Button($r('app.string.modify')).height(40).fontSize(14).enabled(!this.busy)
            .backgroundColor(Color.Transparent).fontColor($r('app.color.accent'))
            .onClick(() => this.runTask(() => this.changeBroker()))
        }.width('100%').padding(16).backgroundColor($r('app.color.card')).borderRadius(12)
        ConnectionField({ label: $r('app.string.peer_password'), value: this.peerPassword, secret: true, locked: this.busy, onEdited: () => this.testState = ConnectionTestState.Idle })
        Text($r('app.string.peer_password_hint')).fontSize(12).fontColor($r('app.color.muted')).width('100%')
      }
      Column({ space: 8 }) {
        Text($r(this.mode === ConnectionMode.Local ? 'app.string.local_port' : 'app.string.remote_port'))
          .fontSize(14).fontColor($r('app.color.ink'))
        TextInput({ text: this.port, placeholder: '3080' }).type(InputType.Number).maxLength(5).height(48)
          .fontColor($r('app.color.ink')).backgroundColor($r('app.color.card')).borderRadius(12)
          .border({ width: 1, color: $r('app.color.border') }).enabled(!this.busy)
          .onChange((value: string) => {
            this.port = value;
            this.testState = ConnectionTestState.Idle;
          })
      }.width('100%').alignItems(HorizontalAlign.Start)
      ConnectionField({ label: $r('app.string.dsh_token'), value: this.token, secret: true, locked: this.busy, onEdited: () => this.testState = ConnectionTestState.Idle })
      if (this.mode === ConnectionMode.Local) {
        Text($r('app.string.local_hint')).fontSize(12).fontColor($r('app.color.muted')).width('100%')
      }
    }.width('100%')
  }

  @Builder
  private configActions() {
    Column() {
      Row({ space: 12 }) {
        Button({ type: ButtonType.Normal }) {
          Stack({ alignContent: Alignment.Center }) {
            Text($r('app.string.test_connection')).fontColor($r('app.color.ink')).fontSize(14)
              .maxLines(1).constraintSize({ maxWidth: 'calc(100% - 56vp)' })
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .onAreaChange((_, area: Area) => this.testLabelWidth = Number(area.width))
            if (this.testState !== ConnectionTestState.Idle) {
              Stack() {
                if (this.testState === ConnectionTestState.Testing) {
                  LoadingProgress().width(20).height(20).color($r('app.color.accent'))
                    .accessibilityText($r('app.string.test_in_progress'))
                } else if (this.testState === ConnectionTestState.Success) {
                  Image($r('app.media.connection_test_success')).width(20).height(20)
                    .accessibilityText($r('app.string.test_success'))
                } else if (this.testState === ConnectionTestState.Failure) {
                  Image($r('app.media.connection_test_failure')).width(20).height(20)
                    .accessibilityText($r('app.string.test_failure'))
                }
              }.width(20).height(20).translate({ x: -this.testLabelWidth / 2 - 18 })
            }
          }.width('100%').height('100%')
        }.layoutWeight(1).height(48).padding(0).enabled(!this.busy).borderRadius(24)
          .backgroundColor($r('app.color.card'))
          .onClick(() => this.runTask(() => this.testConnection()))
        if (this.editing) {
          Button($r('app.string.delete_connection')).fontSize(14).layoutWeight(1).height(48).borderRadius(24)
            .fontColor($r('app.color.warning')).backgroundColor($r('app.color.card'))
            .enabled(!this.busy).onClick(() => this.runTask(() => this.deleteConnection()))
        }
      }.width('100%')
    }.width('100%').constraintSize({ maxWidth: 600 }).padding({ top: 16, bottom: 16 })
  }

  @Builder
  private homeMenu() {
    Button($r('app.string.diagnostics_title'), { type: ButtonType.Normal }).id('diagnostics-open')
      .height(40).padding({ left: 12, right: 12 }).fontSize(14)
      .fontColor($r('app.color.accent')).backgroundColor(Color.Transparent).borderRadius(20)
      .onClick(() => this.navigate(LauncherPage.Diagnostics))
  }

  @Builder
  private destinationMenu(name: string) {
    if (name === LauncherPage.Config) {
      Button($r('app.string.save_connection'), { type: ButtonType.Normal }).height(40).padding({ left: 16, right: 16 })
        .fontSize(16).fontColor($r('app.color.accent')).backgroundColor(Color.Transparent).borderRadius(20)
        .enabled(this.loaded && !this.busy).onClick(() => this.runTask(() => this.saveConnection()))
    }
  }

  @Builder
  private destination(name: string) {
    NavDestination() {
      if (name === LauncherPage.Diagnostics) {
        DiagnosticLogs()
      } else {
      Column() {
        Column() {
          this.status()
        }.width('100%').constraintSize({ maxWidth: 1000 })
          .padding({ left: this.viewportWidth < 600 ? 20 : 36, right: this.viewportWidth < 600 ? 20 : 36 })
        Scroll() {
          Column() {
            Column() {
              if (name === LauncherPage.Mode) {
                this.modePage()
              } else if (name === LauncherPage.Login) {
                this.loginPage()
              } else if (name === LauncherPage.Brokers) {
                this.brokersPage()
              } else if (name === LauncherPage.Config) {
                this.configPage()
              }
            }.width('100%').constraintSize({ maxWidth: 600 }).padding({ top: 16, bottom: 24 })
          }.width('100%').constraintSize({ maxWidth: 1000 })
            .padding({ left: this.viewportWidth < 600 ? 20 : 36, right: this.viewportWidth < 600 ? 20 : 36 })
        }.layoutWeight(1).width('100%').align(Alignment.Top)
        if (name === LauncherPage.Config) {
          Column() {
            this.configActions()
          }.width('100%').constraintSize({ maxWidth: 1000 })
            .padding({ left: this.viewportWidth < 600 ? 20 : 36, right: this.viewportWidth < 600 ? 20 : 36 })
        }
      }.width('100%').height('100%')
      }
    }.title(this.title(this.pageForName(name)))
      .menus(this.destinationMenu(name)).hideToolBar(true)
      .backgroundColor($r('app.color.panel'))
      .onBackPressed(() => this.handleBack())
  }

  build() {
    WithTheme({ colorMode: this.colorMode === 0 ? ThemeColorMode.DARK :
      this.colorMode === 1 ? ThemeColorMode.LIGHT : ThemeColorMode.SYSTEM }) {
      Navigation(this.paths) {
        Column() {
          this.status()
          this.homePage()
        }.width('100%').height('100%').constraintSize({ maxWidth: 1000 })
          .padding({ left: this.viewportWidth < 600 ? 20 : 36, right: this.viewportWidth < 600 ? 20 : 36 })
      }.title($r('app.string.connections_title')).titleMode(NavigationTitleMode.Mini)
        .menus(this.homeMenu)
        .hideBackButton(true).hideToolBar(true).mode(NavigationMode.Stack)
        .navDestination(this.destination).width('100%').height('100%')
        .backgroundColor($r('app.color.panel'))
        .onAreaChange((_, area: Area) => this.viewportWidth = Number(area.width))
    }
  }
}
