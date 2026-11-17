/**
 * Inject at document start to repair ArkWeb's opaque internal URL getters when probes fail.
 * Native URL construction, setters and other schemes retain their original behavior.
 */
export const WEB_RESOURCE_COMPATIBILITY_SCRIPT: string = `(() => {
  const NativeURL = window.URL;
  if (typeof NativeURL !== 'function') return;
  const prototype = NativeURL.prototype;
  const original = {
    hostname: Object.getOwnPropertyDescriptor(prototype, 'hostname'),
    pathname: Object.getOwnPropertyDescriptor(prototype, 'pathname')
  };
  const href = Object.getOwnPropertyDescriptor(prototype, 'href');
  if (!href || typeof href.get !== 'function') return;
  for (const name of ['hostname', 'pathname']) {
    const descriptor = original[name];
    if (!descriptor || !descriptor.configurable || typeof descriptor.get !== 'function') return;
  }
  const affected = { hostname: new Set(), pathname: new Set() };
  const path = '/__dsh_resource_probe__/a%20b.md';
  for (const [scheme, host] of [['dsh-resource', 'file'], ['sidebar', 'guide']]) {
    let sample;
    try { sample = new NativeURL(scheme + '://' + host + path + '?q=1#L2'); }
    catch (error) { continue; /* Getters cannot repair constructor rejection. */ }
    if (Reflect.apply(original.hostname.get, sample, []) !== host) affected.hostname.add(scheme);
    if (Reflect.apply(original.pathname.get, sample, []) !== path) affected.pathname.add(scheme);
  }
  if (affected.hostname.size === 0 && affected.pathname.size === 0) return;
  const replacement = {};
  for (const name of ['hostname', 'pathname']) {
    const descriptor = original[name];
    replacement[name] = { ...descriptor, get: function () {
      const native = Reflect.apply(descriptor.get, this, []);
      const address = Reflect.apply(href.get, this, []);
      const parts = /^(dsh-resource|sidebar):\\/\\/([^/?#]*)(\\/[^?#]*)?(?:[?#].*)?$/i.exec(address);
      if (!parts || !affected[name].has(parts[1].toLowerCase())) return native;
      const authority = parts[2];
      if (authority === '' || /[@:\\[\\]\\\\<>^|\\u0000-\\u001f\\u007f\\s]/.test(authority)) return native;
      return name === 'hostname' ? authority : (parts[3] || '');
    } };
  }
  try { Object.defineProperties(prototype, replacement); }
  catch (error) { Object.defineProperties(prototype, original); }
})();`;
