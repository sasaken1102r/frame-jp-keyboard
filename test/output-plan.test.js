import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphemes, planCalls } from '../src/output-plan.js';

test('minimal mode: a run of non-ASCII text is one call (one keymap swap in gamescope)', () => {
  assert.deepEqual(planCalls([{ text: 'てすとです' }], { buffered: false }), ['てすとです']);
  assert.deepEqual(planCalls([{ text: '今日はいい天気' }], { buffered: false }), ['今日はいい天気']);
});

test('minimal mode: ASCII stays one call per character; runs split around it', () => {
  assert.deepEqual(planCalls([{ text: 'hello ' }], { buffered: false }), ['h', 'e', 'l', 'l', 'o', ' ']);
  assert.deepEqual(planCalls([{ text: 'Aあいb' }], { buffered: false }), ['A', 'あい', 'b']);
  assert.deepEqual(planCalls([{ text: 'です。' }], { buffered: false }), ['です。']);
});

test('keys stay separate calls, in order', () => {
  const ops = [{ key: 'Backspace' }, { key: 'Backspace' }, { text: 'はい' }, { key: 'Enter' }];
  assert.deepEqual(planCalls(ops, { buffered: false }), ['Backspace', 'Backspace', 'はい', 'Enter']);
});

test('buffered mode: one grapheme per call (the VR buffer moves its cursor by one per call)', () => {
  assert.deepEqual(planCalls([{ text: 'かんじ' }], { buffered: true }), ['か', 'ん', 'じ']);
  assert.deepEqual(planCalls([{ text: 'a👍🏽' }], { buffered: true }), ['a', '👍🏽']);
});

test('graphemes keep combined characters together', () => {
  assert.deepEqual(graphemes('が'), ['が']);
  assert.deepEqual(graphemes('か\u3099'), ['か\u3099']);
  assert.equal(graphemes('👍🏽').length, 1);
});

test('createOutput: a commit is one HandleVirtualKeyDown call; buffered mode spaces graphemes in order', async () => {
  const { createOutput } = await import('../src/steam.js');
  const calls = [];
  const manager = { HandleVirtualKeyDown: (s) => calls.push(s), m_fnVROnTextEnteredOverride: () => {} };
  const saved = globalThis.SteamUIStore;
  globalThis.SteamUIStore = { WindowStore: { SteamUIWindows: [{ VirtualKeyboardManager: manager }] } };
  try {
    let buffered = false;
    const send = createOutput(() => ({ buffered }));
    send([{ text: 'てすとです' }]);
    send([{ key: 'Backspace' }, { text: 'ok' }]);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(calls, ['てすとです', 'Backspace', 'o', 'k']);
    calls.length = 0;
    buffered = true;
    send([{ text: 'かな' }]);
    send([{ text: 'だ' }]);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(calls, ['か', 'な', 'だ']);
  } finally {
    globalThis.SteamUIStore = saved;
  }
});

test('a commit and the Enter after it go out at once, one call per run', async () => {
  const { createOutput } = await import('../src/steam.js');
  const calls = [];
  const manager = { HandleVirtualKeyDown: (s) => calls.push(s), m_fnVROnTextEnteredOverride: () => {} };
  const saved = globalThis.SteamUIStore;
  globalThis.SteamUIStore = { WindowStore: { SteamUIWindows: [{ VirtualKeyboardManager: manager }] } };
  try {
    const send = createOutput(() => ({ buffered: false, }));
    const t0 = performance.now();
    send([{ text: 'てすとです' }, { key: 'Enter' }]);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(calls, ['てすとです', 'Enter']);
    assert.ok(performance.now() - t0 < 100);
  } finally {
    globalThis.SteamUIStore = saved;
  }
});

test('isForeignKeyboardTarget: open for another overlay than the Steam window', async () => {
  const { isForeignKeyboardTarget } = await import('../src/steam.js');
  const main = 'valve.steam.gamepadui.main';
  const app = { bIsOpen: true, sOverlayKey: 'gamescope.gamescope-0.window.72', unAppID: 0 };
  assert.equal(isForeignKeyboardTarget(app, main, undefined), true);
  assert.equal(isForeignKeyboardTarget({ ...app, sOverlayKey: main }, main, undefined), false);
  assert.equal(isForeignKeyboardTarget({ ...app, unAppID: 570 }, main, 570), false);
  assert.equal(isForeignKeyboardTarget({ ...app, sOverlayKey: '' }, main, undefined), false); // unknown: leave as is
  assert.equal(isForeignKeyboardTarget({ ...app, bIsOpen: false }, main, undefined), false);
  assert.equal(isForeignKeyboardTarget(null, main, undefined), false);
});

test('createOutput: Enter for another window skips a Steam UI field\'s Enter hook; its own field keeps it', async () => {
  const { createOutput } = await import('../src/steam.js');
  const calls = [];
  const manager = {
    HandleVirtualKeyDown: (s) => calls.push(['hvkd', s]),
    DispatchKeypress: (s) => calls.push(['dispatch', s]),
    m_fnVROnTextEnteredOverride: () => {},
    m_ActiveElementProps: { onEnterKeyPress: () => null },
  };
  const saved = globalThis.SteamUIStore;
  globalThis.SteamUIStore = { WindowStore: { SteamUIWindows: [{ VirtualKeyboardManager: manager, GetVROverlayKey: () => 'valve.steam.gamepadui.main' }] } };
  try {
    let vrStatus = { bIsOpen: true, bMinimal: true, sOverlayKey: 'gamescope.gamescope-0.window.72', unAppID: 0 };
    const send = createOutput(() => ({ buffered: false, vrStatus }));
    send([{ text: 'かんじ' }, { key: 'Enter' }]);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls.splice(0), [['hvkd', 'かんじ'], ['dispatch', 'Enter']]);
    vrStatus = { ...vrStatus, sOverlayKey: 'valve.steam.gamepadui.main' };
    send([{ key: 'Enter' }]);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls.splice(0), [['hvkd', 'Enter']]);
    manager.m_ActiveElementProps = null;
    vrStatus = { ...vrStatus, sOverlayKey: 'gamescope.gamescope-0.window.72' };
    send([{ key: 'Enter' }]);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls.splice(0), [['hvkd', 'Enter']]);
  } finally {
    globalThis.SteamUIStore = saved;
  }
});
