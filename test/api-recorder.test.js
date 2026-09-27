import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, installApiRecorder } from '../src/api-recorder.js';

test('arguments are described without their text', () => {
  assert.equal(describe('かんじ'), 'text:3:non-ascii');
  assert.equal(describe('ab'), 'text:2:ascii');
  assert.equal(describe('aあ'), 'text:2:mixed');
  assert.equal(describe('Enter'), 'Enter');
  assert.equal(describe('\n'), '\\n');
  assert.equal(describe(false), false);
  assert.equal(describe(undefined), null);
  assert.equal(describe({}), 'object');
});

test('calls are logged, forwarded unchanged, and uninstall restores the originals', () => {
  const seen = [];
  const manager = {
    name: 'm',
    HandleVirtualKeyDown(text, shift) {
      seen.push([this.name, text, shift]);
      return 'r';
    },
  };
  const original = manager.HandleVirtualKeyDown;
  const client = { Input: { ControllerKeyboardSendText: (s) => seen.push(['send', s]) } };
  const entries = [];
  let ours = true;
  const rec = installApiRecorder({
    getManagers: () => [manager],
    isOurs: () => ours,
    onCall: (e) => entries.push(e),
    extra: (label, target, args) => (args[0] === 'Enter' ? { dismiss: false } : undefined),
    client,
  });
  assert.equal(rec.count, 2);
  assert.equal(manager.HandleVirtualKeyDown('かな', false), 'r');
  ours = false;
  manager.HandleVirtualKeyDown('Enter', false);
  client.Input.ControllerKeyboardSendText('x');
  assert.deepEqual(seen, [['m', 'かな', false], ['m', 'Enter', false], ['send', 'x']]);
  assert.deepEqual(entries.map(({ dt, ...e }) => e), [
    { fn: 'VKM0.HandleVirtualKeyDown', by: 'ours', args: ['text:2:non-ascii', false] },
    { fn: 'VKM0.HandleVirtualKeyDown', by: 'stock', args: ['Enter', false], dismiss: false },
    { fn: 'Input.ControllerKeyboardSendText', by: 'stock', args: ['text:1:ascii'] },
  ]);
  assert.ok(!JSON.stringify(entries).includes('かな'));
  rec.refresh(); // already wrapped: no double wrap
  assert.equal(rec.count, 2);
  rec.uninstall();
  assert.equal(manager.HandleVirtualKeyDown, original);
});

test('class methods are wrapped on the prototype (every instance) and IBus key events log only key classes', async () => {
  class Manager {
    HandleVirtualKeyDown(text) {
      this.DispatchKeypress(text);
    }

    DispatchKeypress() {}
  }
  const listed = new Manager();
  const hidden = new Manager(); // not in the manager list, e.g. another window's
  class Context {
    process_key_event(keyval) {
      return Promise.resolve(keyval === 0xff0d);
    }

    connect(signal, handler) {
      this.handler = handler;
    }
  }
  const entries = [];
  const rec = installApiRecorder({
    getManagers: () => [listed],
    isOurs: () => false,
    onCall: (e) => entries.push(e),
    client: {},
    ibus: { _Prototypes: { IBusInputContext: Context } },
  });
  hidden.HandleVirtualKeyDown('かな');
  const ctx = new Context();
  await ctx.process_key_event(0x3042, 0, 0);
  await ctx.process_key_event(0xff0d, 0, 0);
  ctx.connect('commit-text', () => 'ok');
  assert.equal(ctx.handler({ text: '漢字' }), 'ok');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(entries.map(({ fn, args, result }) => [fn, args, result]), [
    ['VKM?.HandleVirtualKeyDown', ['text:2:non-ascii'], undefined],
    ['VKM?.DispatchKeypress', ['text:2:non-ascii'], undefined],
    ['IBus.process_key_event', ['char', 0], false],
    ['IBus.process_key_event', ['Return', 0], true],
    ['IBus.connect', ['commit-text'], undefined],
    ['IBus.signal.commit-text', ['ibus-text:2:non-ascii'], undefined],
  ]);
  rec.uninstall();
  assert.equal(Manager.prototype.HandleVirtualKeyDown.__fjkWrapped, undefined);
  assert.equal(Context.prototype.process_key_event.__fjkWrapped, undefined);
});

test('read-only but configurable methods (Steam IBus prototypes) are wrapped and restored', () => {
  const proto = {};
  const reset = () => 'r';
  Object.defineProperty(proto, 'reset', { value: reset, writable: false, configurable: true, enumerable: false });
  const entries = [];
  const rec = installApiRecorder({ getManagers: () => [], isOurs: () => false, onCall: (e) => entries.push(e), client: {}, ibus: { _Prototypes: { IBusInputContext: proto } } });
  assert.equal(Object.create(proto).reset(), 'r');
  assert.equal(entries[0].fn, 'IBus.reset');
  rec.uninstall();
  assert.equal(proto.reset, reset);
  assert.equal(Object.getOwnPropertyDescriptor(proto, 'reset').writable, false);
});
