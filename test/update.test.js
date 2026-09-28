import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater } from '../src/update.js';

/**
 * Build an updater with a recording `send` and a change counter, for assertions.
 * @param {'ja'|'en'} [lang='ja'] - Language
 * @returns {{updater: ReturnType<typeof createUpdater>, sent: object[], changes: number}} Test rig
 * @example
 * const { updater, sent } = rig();
 */
const rig = (lang = 'ja') => {
  const sent = [];
  const state = { changes: 0 };
  const updater = createUpdater({ lang, send: (m) => sent.push(m), onChange: () => { state.changes += 1; } });
  return { updater, sent, state };
};

test('update: tapping the indicator shows "checking" and asks the injector to check', () => {
  const { updater, sent } = rig();
  updater.tapIndicator();
  assert.equal(updater.view.banner.kind, 'checking');
  assert.deepEqual(sent, [{ action: 'check' }]);
});

test('update: a forced up-to-date answer shows a toast, then clears itself', async () => {
  const { updater } = rig();
  updater.tapIndicator();
  updater.receive({ source: 'check', forced: true, answer: { status: 'up-to-date', current: '0.5.3' } });
  assert.equal(updater.view.banner.kind, 'toast');
  assert.match(updater.view.banner.title, /0\.5\.3/);
  assert.equal(updater.view.badge, false);
});

test('update: a forced update-available (installable) answer shows a confirm banner and sets the badge', () => {
  const { updater } = rig();
  updater.tapIndicator();
  updater.receive({
    source: 'check', forced: true,
    answer: { status: 'update-available', current: '0.5.3', latest: '0.6.0', url: 'https://example/', installable: true },
  });
  assert.equal(updater.view.badge, true);
  assert.equal(updater.view.banner.kind, 'confirm');
  assert.match(updater.view.banner.title, /0\.6\.0/);
});

test('update: confirming asks the injector to install and shows "installing"', () => {
  const { updater, sent } = rig();
  updater.receive({
    source: 'check', forced: true,
    answer: { status: 'update-available', latest: '0.6.0', installable: true },
  });
  updater.tapConfirmYes();
  assert.deepEqual(sent.at(-1), { action: 'install' });
  assert.equal(updater.view.banner.kind, 'checking');
  assert.equal(updater.view.badge, false);
});

test('update: cancelling the confirmation just hides the banner (badge stays)', () => {
  const { updater } = rig();
  updater.receive({
    source: 'check', forced: true,
    answer: { status: 'update-available', latest: '0.6.0', installable: true },
  });
  updater.tapConfirmNo();
  assert.equal(updater.view.banner, null);
  assert.equal(updater.view.badge, true);
});

test('update: not installable shows a dismissable "update by hand" banner', () => {
  const { updater } = rig();
  updater.tapIndicator();
  updater.receive({
    source: 'check', forced: true,
    answer: { status: 'update-available', latest: '0.6.0', installable: false, reason: 'no-checksums' },
  });
  assert.equal(updater.view.banner.kind, 'dismissable');
  updater.tapDismiss();
  assert.equal(updater.view.banner, null);
});

test('update: a forced check error shows the reason, falling back to "other" for unknown codes', () => {
  const { updater } = rig();
  updater.tapIndicator();
  updater.receive({ source: 'check', forced: true, answer: { status: 'error', error: 'network' } });
  assert.match(updater.view.banner.title, /GitHub/);

  updater.tapIndicator();
  updater.receive({ source: 'check', forced: true, answer: { status: 'error', error: 'something-new' } });
  assert.equal(updater.view.banner.kind, 'dismissable');
});

test('update: an unsolicited (automatic) answer only raises the badge, never a banner', () => {
  const { updater, state } = rig();
  updater.receive({ source: 'check', forced: false, answer: { status: 'update-available', latest: '0.6.0', installable: true } });
  assert.equal(updater.view.badge, true);
  assert.equal(updater.view.banner, null);
  assert.ok(state.changes > 0); // still redraws, so the badge appears

  updater.receive({ source: 'check', forced: false, answer: { status: 'error', error: 'network' } });
  assert.equal(updater.view.banner, null);
});

test('update: install progress pushed after confirming (running / failed / done)', () => {
  const { updater } = rig();
  updater.receive({ source: 'check', forced: true, answer: { status: 'update-available', latest: '0.6.0', installable: true } });
  updater.tapConfirmYes();

  updater.receive({ source: 'state', answer: { state: 'running', step: 'download' } });
  assert.equal(updater.view.banner.kind, 'checking');

  updater.receive({ source: 'state', answer: { state: 'failed', error: 'checksum-mismatch' } });
  assert.equal(updater.view.banner.kind, 'dismissable');
  assert.match(updater.view.banner.title, /壊れ/);
});

test('update: English strings are used when lang is "en"', () => {
  const { updater } = rig('en');
  updater.tapIndicator();
  assert.match(updater.view.banner.title, /Checking/);
});

test('update: a malformed message is ignored rather than throwing', () => {
  const { updater } = rig();
  assert.doesNotThrow(() => updater.receive(null));
  assert.doesNotThrow(() => updater.receive({ source: 'check' }));
  assert.equal(updater.view.banner, null);
});
