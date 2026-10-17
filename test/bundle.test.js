import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';

// Exercise the same entry point and injector-visible API in both forms. The VM supplies only
// Steam's keyboard manager and the two CDP bindings; it never opens a real browser or sends input.
const exercise = async (code) => {
  const intervals = new Set();
  const requests = [];
  const updates = [];
  const saved = new Map();
  const scope = createContext({
    console: { log() {}, warn() {} },
    performance, queueMicrotask, clearTimeout,
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; },
    setInterval: (fn) => { intervals.add(fn); return fn; },
    clearInterval: (fn) => intervals.delete(fn),
    localStorage: { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    g_PopupManager: { GetPopupForVROverlayKey: () => null },
    SteamUIStore: { WindowStore: { SteamUIWindows: [{ VirtualKeyboardManager: { HandleVirtualKeyDown() {} } }] } },
  });
  scope.fjkUpdateBridge = (json) => updates.push(JSON.parse(json));
  scope.fjkAnthy = (json) => {
    const request = JSON.parse(json);
    requests.push(request);
    queueMicrotask(() => scope.__fjkAnthyReply({
      id: request.id, ok: true, predictions: [],
      segments: [{ reading: request.reading, candidates: ['漢字', '感じ'] }],
    }));
  };
  runInContext(code, scope);
  await new Promise(setImmediate);
  const api = scope.__fjk;
  assert.equal(api.state, 'running');
  assert.equal(api.version, 'test');
  assert.equal(api.debug.capture(true), true);
  const keys = Object.keys(api).sort();
  const debugKeys = Object.keys(api.debug).sort();
  await api.debug.type('かんじ');
  await api.debug.key('space');
  await api.debug.select(0);
  const kana = api.debug.state().output;
  assert.ok(kana.some((op) => op.text === '漢字'));
  assert.ok(requests.some((r) => r.op === 'commit'));
  api.debug.page('qwerty');
  const english = await api.debug.english('Helo');
  assert.ok(english.suggestions.some((s) => s.text === 'Hello'));
  const index = english.suggestions.findIndex((s) => s.text === 'Hello');
  const accepted = await api.debug.suggestion(index);
  assert.equal(accepted.output.at(-1).text, 'Hello ');
  api.updater.tapIndicator();
  assert.equal(updates.at(-1).action, 'check');
  api.updater.receive({ source: 'check', forced: true, answer: { status: 'up-to-date' } });
  api.settings.flickThreshold = 31;
  api.setEnabled(false);
  assert.equal(JSON.parse(saved.get('fjk.settings')).flickThreshold, 31);
  runInContext(code, scope);
  assert.equal(api.state, 'uninstalled');
  assert.notEqual(scope.__fjk, api);
  assert.equal(scope.__fjk.settings.flickThreshold, 31);
  assert.equal(intervals.size, 1);
  scope.__fjk.uninstall();
  await Promise.resolve();
  assert.equal(scope.__fjk, undefined);
  assert.equal(intervals.size, 0);
  return JSON.parse(JSON.stringify({ keys, debugKeys, kana, english, accepted, updates }));
};

test('minified bundle preserves the injector API, kana conversion, English suggestions and reinjection', async () => {
  const options = {
    entryPoints: ['src/main.js'], bundle: true, format: 'iife', target: 'chrome126',
    write: false, charset: 'utf8', legalComments: 'inline',
    define: { __FJK_VERSION__: JSON.stringify('test') },
  };
  const readable = (await build(options)).outputFiles[0].text;
  const minified = (await build({ ...options, minify: true })).outputFiles[0].text;
  const dictionary = await readFile(new URL('../src/data/words-en.js', import.meta.url), 'utf8');
  const notice = dictionary.match(/^\/\*![\s\S]*?\*\//)[0];
  assert.ok(minified.includes(notice), 'the complete dictionary copyright notice is retained');
  assert.deepEqual(await exercise(minified), await exercise(readable));
});
