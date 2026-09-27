import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthyClient, BINDING_NAME, REPLY_NAME } from '../src/anthy-client.js';

/**
 * A fake page scope with the injector's binding: requests are answered asynchronously through the
 * reply function, like Runtime.evaluate("__fjkAnthyReply(...)").
 * @param {(request: object) => object|null} answer - Returns the reply fields (null = never answer)
 * @returns {{scope: object, requests: object[]}} Scope and the requests seen
 * @example
 * fakeScope((r) => ({ ok: true }))
 */
const fakeScope = (answer) => {
  const requests = [];
  const scope = {};
  scope[BINDING_NAME] = (json) => {
    const request = JSON.parse(json);
    requests.push(request);
    const fields = answer(request);
    if (fields) setTimeout(() => scope[REPLY_NAME]({ id: request.id, ...fields }), 1);
  };
  return { scope, requests };
};

test('requests carry an id and the reply resolves the matching call', async () => {
  const { scope, requests } = fakeScope((r) => (r.op === 'convert' ? { ok: true, segments: [{ reading: r.reading, candidates: ['漢字'] }] } : { ok: true }));
  const client = createAnthyClient({ scope });
  assert.equal(await client.init(), true);
  const [a, b] = await Promise.all([client.convert('かんじ'), client.convert('かな', [2])]);
  assert.deepEqual(a, [{ reading: 'かんじ', candidates: ['漢字'] }]);
  assert.equal(b[0].reading, 'かな');
  assert.deepEqual(requests.map((r) => r.op), ['hello', 'convert', 'convert']);
  assert.deepEqual(requests[2].lengths, [2]);
  assert.equal(new Set(requests.map((r) => r.id)).size, 3);
  assert.ok(client.info.requests === 3 && client.info.pending === 0);
  client.destroy();
});

test('commit and commitPrediction send what is needed for learning', async () => {
  const { scope, requests } = fakeScope(() => ({ ok: true }));
  const client = createAnthyClient({ scope });
  assert.equal(await client.commit({ reading: 'きかい', lengths: [3], choices: [1], texts: ['器械'] }), true);
  assert.equal(await client.commitPrediction({ reading: 'てん', index: 0, text: '天気' }), true);
  assert.deepEqual(requests[0], { id: 1, op: 'commit', reading: 'きかい', lengths: [3], choices: [1], texts: ['器械'] });
  assert.equal(requests[1].op, 'commitPrediction');
  client.destroy();
});

test('no binding (old injector, no libanthy): init reports unavailable', async () => {
  const warnings = [];
  const client = createAnthyClient({ scope: {}, warn: (m) => warnings.push(m) });
  assert.equal(await client.init(), false);
  assert.ok(warnings[0].includes('not available'));
});

test('an error reply rejects; a missing reply times out', async () => {
  const { scope } = fakeScope((r) => (r.op === 'predict' ? { ok: false, error: 'TypeError' } : null));
  const client = createAnthyClient({ scope, timeoutMs: 30 });
  await assert.rejects(client.predict('て'), /predict failed/);
  await assert.rejects(client.convert('て'), /timed out/);
  assert.equal(client.info.failures, 2);
  client.destroy();
});

test('destroy rejects pending requests and removes the reply function', async () => {
  const { scope } = fakeScope(() => null);
  const client = createAnthyClient({ scope, timeoutMs: 1000 });
  const pending = client.convert('て');
  client.destroy();
  await assert.rejects(pending, /destroyed/);
  assert.equal(scope[REPLY_NAME], undefined);
});
