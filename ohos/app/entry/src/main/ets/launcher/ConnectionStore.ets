import preferences from '@ohos.data.preferences';
import common from '@ohos.app.ability.common';
import { ConnectionProfile, encodeConnections, parseConnections } from './ConnectionProfile';

/** App-private preferences contain tokens; shared Documents is only an optional import source. */
export class ConnectionStore {
  private data: preferences.Preferences | undefined = undefined;

  /** Loads the existing document before permitting edits; malformed data remains untouched. */
  async load(context: common.UIAbilityContext): Promise<ConnectionProfile[]> {
    const data = await preferences.getPreferences(context, { name: 'dsh_connections' });
    const raw = await data.get('connections_v1', '');
    if (typeof raw !== 'string') {
      throw new Error('invalid connection preference type');
    }
    const connections = parseConnections(raw);
    this.data = data;
    return connections;
  }

  /** Callers serialize saves and publish their new list only after flush succeeds. */
  async save(connections: ConnectionProfile[]): Promise<void> {
    const data = this.data;
    if (data === undefined) {
      throw new Error('connection preferences are not loaded');
    }
    const next = encodeConnections(connections);
    const previous = await data.get('connections_v1', '');
    await data.put('connections_v1', next);
    try {
      await data.flush();
    } catch (error) {
      // A failed flush must not leak a draft into the next save's in-memory document.
      await data.put('connections_v1', previous);
      throw new Error('unable to flush connection preferences');
    }
  }
}
