import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// Run the actual parser and injected JS, not a second copy of their rules.
const source = readFileSync(new URL('../entry/src/main/ets/launcher/ContextActions.ets', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source.replace("import url from '@ohos.url';", 'const url = { URL };'))
  .replaceAll('export ', '');
const { contextTarget, CONTEXT_CAPTURE_SCRIPT } = new Function('URL', executable +
  '\nreturn {contextTarget, CONTEXT_CAPTURE_SCRIPT};')(URL);
const home = '/storage/Users/currentUser';

test('whole selections accept HTTP URLs and normalize contained home paths', () => {
  assert.equal(contextTarget('https://example.com/a?q=1#b', home).link, 'https://example.com/a?q=1#b');
  assert.equal(contextTarget('"~/Documents/a b.txt"', home).path, `${home}/Documents/a b.txt`);
  assert.equal(contextTarget(`${home}/dev/../Documents/a.txt`, home).path, `${home}/Documents/a.txt`);
  for (const text of ['javascript:alert(1)', 'file:///etc/passwd', '~/../../etc/passwd',
    `${home}Other/a`, 'https://user:pass@example.com', 'prefix https://example.com', '~/a\nb']) {
    const parsed = contextTarget(text, home);
    assert.equal(parsed.link + parsed.path, '', text);
  }
});

function capture(chunks, nodeIndex, offset, options = {}) {
  let listener;
  class Element {
    closest(selector) {
      if (selector === 'input[type="password"]') return options.password ? this : null;
      if (selector === 'a[href]') return options.link ? { href: options.link } : null;
      return null;
    }
  }
  const element = new Element();
  const root = { parentElement: {}, display: 'block' };
  const span = { parentElement: root, display: 'inline' };
  const nodes = chunks.map(text => ({ nodeType: 3, textContent: text, length: text.length, parentElement: span }));
  const window = { getSelection: () => options.selection || '' };
  window.top = window;
  const document = {
    body: {},
    addEventListener(name, callback) { assert.equal(name, 'contextmenu'); listener = callback; },
    caretRangeFromPoint: () => ({ startContainer: nodes[nodeIndex], startOffset: offset }),
    createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () =>
      options.blank ? [] : [{ left: 0, right: 100, top: 0, bottom: 100 }] }),
    createTreeWalker: () => {
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    },
  };
  runInNewContext(CONTEXT_CAPTURE_SCRIPT, {
    window, document, Element, HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    Node: { TEXT_NODE: 3 }, NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: element => ({ display: element.display }),
  });
  listener({ target: element, clientX: 50, clientY: 50 });
  return JSON.parse(JSON.stringify(window.__dshAppContext));
}

test('point lookup joins highlighted spans and selects only the clicked token', () => {
  assert.equal(capture(['See https://other.test then ~/Doc', 'uments/a.txt today'], 1, 5).candidate,
    '~/Documents/a.txt');
  assert.equal(capture(['(https://example.com/a?q=1). next'], 0, 15).candidate,
    'https://example.com/a?q=1');
  assert.equal(capture(['https://example.com/a_(b) next'], 0, 15).candidate,
    'https://example.com/a_(b)');
});

test('quoted paths with spaces retain spaces', () => {
  assert.equal(capture(['Open "~/Documents/a ', 'b.txt" next'], 1, 2).candidate, '~/Documents/a b.txt');
});

test('native links and selections take precedence over point lookup', () => {
  const result = capture(['~/wrong.txt'], 0, 3, { selection: 'chosen', link: 'https://example.com/' });
  assert.equal(result.selection, 'chosen');
  assert.equal(result.candidate, '');
  assert.equal(result.link, 'https://example.com/');
});

test('abbreviated paths never become actionable parent directories', () => {
  for (const path of [`${home}/...`, `${home}/…`, '~/a....txt', '~/.../../a', '~/folder/....']) {
    assert.equal(contextTarget(path, home).path, '', path);
    const hovered = capture([path], 0, 3).candidate;
    assert.equal(hovered, '', path);
  }
  for (const path of ['~/a.txt', '~/a..txt', '~/Documents/.', '~/Documents/..']) {
    assert.notEqual(contextTarget(path, home).path, '', path);
    assert.equal(capture([path], 0, 3).candidate, path);
  }
  assert.equal(contextTarget('https://example.com/a...', home).link, 'https://example.com/a...');
});

test('blank pixels, passwords and oversized blocks are not guessed', () => {
  assert.equal(capture(['~/a.txt'], 0, 2, { blank: true }).candidate, '');
  assert.equal(capture(['~/secret'], 0, 2, { password: true, selection: 'secret' }).selection, '');
  assert.equal(capture(['a'.repeat(17000), '~/a.txt'], 1, 2).candidate, '');
});
