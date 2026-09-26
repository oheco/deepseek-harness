import url from '@ohos.url';

/** A menu target is data, never a shell command. */
export class ContextTarget {
  link: string = '';
  path: string = '';
}

/** Parse a whole selection; normalize home paths without expanding shell syntax. */
export function contextTarget(text: string, home: string): ContextTarget {
  const target = new ContextTarget();
  let value = text.trim();
  if (value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {
    return target;
  }
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('`') && value.endsWith('`')))) {
    value = value.slice(1, -1);
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new url.URL(value);
      if (parsed.hostname !== '' && !/\s/.test(value) && parsed.username === '' && parsed.password === '') {
        target.link = parsed.href;
      }
    } catch (_) {
      // Invalid URL text has no open action.
    }
    return target;
  }
  // Abbreviated display paths are not actionable; keep literal . and .. legal.
  if (/\.{3,}|…/.test(value)) {
    return target;
  }
  if (value === '~' || value.startsWith('~/')) {
    value = home + value.slice(1);
  }
  if (value !== home && !value.startsWith(home + '/')) {
    return target;
  }
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  value = '/' + parts.join('/');
  if (value === home || value.startsWith(home + '/')) {
    target.path = value;
  }
  return target;
}

/** Data returned from the page script; native code validates it before use. */
export class ContextSnapshot {
  selection: string = '';
  candidate: string = '';
  link: string = '';
  time: number = 0;
}

/**
 * Capture CSS-pixel coordinates from the actual contextmenu event, not ArkUI
 * physical pixels. No native bridge is exposed, and no selection is changed.
 * Only the top document participates; iframe/canvas text is not guessed.
 */
export const CONTEXT_CAPTURE_SCRIPT: string = `(() => {
  if (window !== window.top) return;
  const key = '__dshAppContext';
  function nearPoint(event) {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.closest('input,textarea,[contenteditable="true"]')) return '';
    let node, offset;
    if (document.caretPositionFromPoint) {
      const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
      if (caret) { node = caret.offsetNode; offset = caret.offset; }
    } else if (document.caretRangeFromPoint) {
      const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (caret) { node = caret.startContainer; offset = caret.startOffset; }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return '';
    // A nearest caret can be far from a blank-area click. Require a glyph hit.
    const glyph = document.createRange();
    const i = Math.min(offset, Math.max(0, node.length - 1));
    glyph.setStart(node, i); glyph.setEnd(node, Math.min(i + 1, node.length));
    const hit = Array.from(glyph.getClientRects()).some(r =>
      event.clientX >= r.left - 3 && event.clientX <= r.right + 3 &&
      event.clientY >= r.top - 3 && event.clientY <= r.bottom + 3);
    if (!hit) return '';
    let root = node.parentElement;
    while (root.parentElement && root !== document.body &&
      ['inline','contents'].includes(getComputedStyle(root).display)) root = root.parentElement;
    if (!root || root === document.body) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = '', at = -1, n, count = 0;
    while ((n = walker.nextNode()) && count++ < 512) {
      if (text.length + n.length > 16384) return '';
      if (n === node) at = text.length + offset;
      text += n.textContent;
    }
    if (n || at < 0) return '';
    // Quotes permit spaces in paths. Prefer these to whitespace-delimited tokens.
    const quoted = /([\x22\x27\x60])([^\x22\x27\x60\\r\\n]+)\\1/g;
    let match;
    while ((match = quoted.exec(text))) {
      if (at >= match.index + 1 && at < match.index + match[0].length &&
        /^(https?:\\/\\/|~\\/|\\/storage\\/Users\\/currentUser(?:\\/|$))/.test(match[2])) return match[2];
    }
    const tokens = /https?:\\/\\/[^\\s<>\x22\x27\x60]+|(?:~\\/|\\/storage\\/Users\\/currentUser(?:\\/|$))[^\\s<>\x22\x27\x60]*/g;
    while ((match = tokens.exec(text))) {
      if (at < match.index || at > match.index + match[0].length) continue;
      const isUrl = /^https?:/.test(match[0]);
      if (!isUrl && /\\.{3,}|…/.test(match[0])) return '';
      let token = match[0].replace(isUrl ? /[.,;:!?，。；：！？]+$/ : /[,;:!?，。；：！？]+$/, '');
      for (const pair of [['(',')'],['[',']'],['{','}']]) {
        while (token.endsWith(pair[1]) && token.split(pair[1]).length > token.split(pair[0]).length)
          token = token.slice(0, -1);
      }
      return token;
    }
    return '';
  }
  document.addEventListener('contextmenu', event => {
    const element = event.target instanceof Element ? event.target : null;
    const state = { selection: '', candidate: '', link: '', time: Date.now() };
    window[key] = state;
    if (!element || element.closest('input[type="password"]')) return;
    try {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        state.selection = element.value.slice(element.selectionStart || 0, element.selectionEnd || 0);
      } else {
        state.selection = String(window.getSelection() || '');
      }
      state.selection = state.selection.slice(0, 8192);
      const anchor = element.closest('a[href]');
      state.link = anchor ? anchor.href : '';
      if (!state.selection && !state.link) state.candidate = nearPoint(event);
    } catch (_) { /* Unsupported DOM surfaces keep only the native menu data. */ }
  }, true);
})();`;

/** Read only the trusted local top document and reject stale right-click data. */
export function contextSnapshotScript(origin: string): string {
  return '(() => { if (location.origin !== ' + JSON.stringify(origin) + ') return "";' +
    'const s = window.__dshAppContext; window.__dshAppContext = null;' +
    'return s && Date.now() - s.time < 2000 ? JSON.stringify(s) : ""; })()';
}
