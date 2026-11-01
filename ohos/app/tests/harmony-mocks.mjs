/** HarmonyOS SDK subsets shared by window-aware App tests; device behavior remains separate acceptance. */
import { createHash } from 'node:crypto';

/** `@ohos.security.cryptoFramework` message digest subset backed by Node SHA-256. */
export const cryptoFramework = {
  createMd(algorithm) {
    if (algorithm !== 'SHA256') throw new Error('unexpected digest ' + algorithm);
    const hash = createHash('sha256');
    return {
      updateSync(blob) { hash.update(blob.data); },
      digestSync() { return { data: new Uint8Array(hash.digest()) }; }
    };
  }
};

/** ArkUI LocalStorage subset: `set` updates only existing keys, as on device. */
export class LocalStorage {
  #values = new Map();
  setOrCreate(key, value) { this.#values.set(key, value); return true; }
  set(key, value) {
    if (!this.#values.has(key)) return false;
    this.#values.set(key, value);
    return true;
  }
  get(key) { return this.#values.get(key); }
}

/**
 * Storage that EntryAbility would pass to its page.
 * @param channel Native broker channel of the window.
 * @param openRequest Saved connection id the window opens once.
 * @returns LocalStorage subset.
 */
export function windowStorage(channel = 1, openRequest = '') {
  const storage = new LocalStorage();
  storage.setOrCreate('dshWindowChannel', channel);
  storage.setOrCreate('dshOpenConnection', openRequest);
  return storage;
}
