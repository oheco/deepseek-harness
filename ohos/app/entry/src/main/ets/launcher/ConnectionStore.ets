import preferences from '@ohos.data.preferences';
import common from '@ohos.app.ability.common';
import { ConnectionProfile, encodeConnections, parseConnections } from './ConnectionProfile';

/**
 * App-private preferences contain tokens; shared Documents is only an optional import source. Every window of the
 * process shares one preferences document, so reads and writes run in one process-wide queue and each write applies
 * its change to the latest committed list.
 */
export class ConnectionStore {
  private static queue: Promise<void> = Promise.resolve();
  private data: preferences.Preferences | undefined = undefined;

  /** Loads the existing document before permitting edits; malformed data remains untouched. */
  async load(context: common.UIAbilityContext): Promise<ConnectionProfile[]> {
    const data = await preferences.getPreferences(context, { name: 'dsh_connections' });
    const connections = await ConnectionStore.serialize(() => ConnectionStore.current(data));
    this.data = data;
    return connections;
  }

  /** Read the latest committed list after earlier writes from any window. */
  async read(): Promise<ConnectionProfile[]> {
    const data = this.loaded();
    return await ConnectionStore.serialize(() => ConnectionStore.current(data));
  }

  /**
   * Apply one change to the latest committed list. Callers publish the returned list only after this resolves.
   * @param change Function from the committed list to its successor; returning its argument unchanged skips the write.
   * @returns The committed successor.
   */
  async update(change: (connections: ConnectionProfile[]) => ConnectionProfile[]): Promise<ConnectionProfile[]> {
    const data = this.loaded();
    return await ConnectionStore.serialize(async () => {
      const committed = await ConnectionStore.current(data);
      const next = change(committed);
      if (next !== committed) {
        await ConnectionStore.write(data, next);
      }
      return next;
    });
  }

  private loaded(): preferences.Preferences {
    if (this.data === undefined) {
      throw new Error('connection preferences are not loaded');
    }
    return this.data;
  }

  private static async current(data: preferences.Preferences): Promise<ConnectionProfile[]> {
    const raw = await data.get('connections_v1', '');
    if (typeof raw !== 'string') {
      throw new Error('invalid connection preference type');
    }
    return parseConnections(raw);
  }

  private static async write(data: preferences.Preferences, connections: ConnectionProfile[]): Promise<void> {
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

  private static serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = ConnectionStore.queue.then(operation);
    ConnectionStore.queue = result.then(() => {}, () => {});
    return result;
  }
}
