import test from 'node:test';
import assert from 'node:assert/strict';

// The owner API is on; fetch answers what each test sets.
globalThis.__DAILY_PLANNER_CONFIG__ = { PLANNER_API_URL: '/api' };
let answer = { status: 200, body: {} };
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
  return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
};
const api = await import('../src/lib/planner-api.js');

test('a gift keeps its own status, so a switched-off or refunded link is explained as such', async () => {
  answer = { status: 200, body: { org: 'Acme', seats: 10, redeemed: 2, available: false, status: 'inactive', revoked: true } };
  const gift = await api.fetchGift('ABCD-EFGH-JKMN');
  assert.deepEqual([gift.ok, gift.status, gift.httpStatus, gift.revoked], [true, 'inactive', 200, true]);
  assert.equal(requests.at(-1).url, '/api/gifts/ABCD-EFGH-JKMN');
  answer = { status: 404, body: { error: 'We could not find this gift link.' } };
  assert.deepEqual(await api.fetchGift('ABCD-EFGH-JKMN'), { error: 'We could not find this gift link.', ok: false, status: 404 });
  // Other routes keep the HTTP status as before.
  answer = { status: 200, body: { kind: 'plus', license: 'DP1.a.b' } };
  assert.equal((await api.claimPurchase('ch_abc123')).status, 200);
});

test('the licence check sends the licence and nothing else', async () => {
  answer = { status: 200, body: { ok: true, revoked: true } };
  const result = await api.checkPlusLicense('DP1.payload.signature');
  assert.deepEqual([result.ok, result.revoked], [true, true]);
  assert.deepEqual(requests.at(-1), { url: '/api/plus/check', method: 'POST', body: { license: 'DP1.payload.signature' } });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const offline = await api.checkPlusLicense('DP1.payload.signature');
  assert.deepEqual([offline.ok, offline.status, offline.revoked], [false, 0, undefined], 'a network error is never a revocation');
});
