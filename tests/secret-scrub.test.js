import test from 'node:test';
import assert from 'node:assert/strict';
import { HIDDEN, scrubAnswer, scrubUpstream, secretPart, upstreamText } from '../server/secret-scrub.js';
import { runConfigChecks } from '../server/admin-config.js';
import { generatePlusKeyPair } from '../server/licenses.js';

// The one scrubber of the owner's routes (server/secret-scrub.js): what a
// service says never brings back a secret, not even a part of it.

// Fixed values whose runs of 4 characters appear in none of the server's own words.
const KEYS = {
  resend: 're_Zyxwvutsrqponmlkjihgfedcba12',
  creem: 'creem_live_ABCDEFGHIJKLMNOPQRSTUV',
  creemTest: 'creem_test_QwXzJkVbNmPfTgHy7531',
  webhook: 'whsec_SecretSecretSecret1234567890'
};
const ECHOES = {
  'ending in 4': secret => `API key ending in ${secret.slice(-4)} is invalid`,
  masked: secret => `Invalid key ${secret.slice(0, 8)}****${secret.slice(-6)}`,
  'masked with dots': secret => `Invalid key ${secret.slice(0, 6)}…${secret.slice(-4)}`,
  'prefix only': secret => `Invalid API key ${secret.slice(0, secret.indexOf('_') + 2)}...`,
  'middle fragment': secret => `bad key fragment ${secret.slice(9, 21)}`,
  'URL-encoded': secret => `key=${[...secret].map(character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')}`,
  'JSON-escaped': secret => `key ${[...secret].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}`,
  'HTML entities': secret => `key ${[...secret].map(character => `&#${character.charCodeAt(0)};`).join('')}`,
  whole: secret => `Invalid key ${secret}`
};
/** Every run of 4 characters of the secret part of `secret` found in `text`. */
const runs = (text, secret) => {
  const body = secretPart(secret);
  const found = [];
  for (let start = 0; start + 4 <= body.length; start += 1) if (text.toLowerCase().includes(body.slice(start, start + 4).toLowerCase())) found.push(body.slice(start, start + 4));
  return found;
};

test('a secret’s public part is its well-known prefix only', () => {
  assert.equal(secretPart(KEYS.resend), 'Zyxwvutsrqponmlkjihgfedcba12');
  assert.equal(secretPart(KEYS.creem), 'ABCDEFGHIJKLMNOPQRSTUV');
  assert.equal(secretPart(KEYS.creemTest), 'QwXzJkVbNmPfTgHy7531');
  assert.equal(secretPart('creem_7Hc2kP0qLmN'), '7Hc2kP0qLmN');
  assert.equal(secretPart(KEYS.webhook), 'SecretSecretSecret1234567890');
  assert.equal(secretPart('JBSWY3DPEHPK3PXP'), 'JBSWY3DPEHPK3PXP');
});

test('after a 401 or a 403 nothing of what a service said is kept', () => {
  for (const status of [401, 403, '401']) assert.equal(upstreamText(status, 'Invalid key, ending in ba12', [KEYS.resend]), '');
  assert.equal(upstreamText(422, 'Price must be at least 100', [KEYS.resend]), 'Price must be at least 100');
  assert.equal(upstreamText(500, '', [KEYS.resend]), '');
});

test('every partial echo is hidden: the end, a masked form, the prefix alone, a fragment, encoded or escaped', () => {
  const all = Object.values(KEYS);
  for (const secret of all) {
    for (const [name, make] of Object.entries(ECHOES)) {
      const message = make(secret);
      const out = upstreamText(422, message, all);
      assert.deepEqual(runs(out, secret), [], `${name} of ${secret.slice(0, 6)}…: “${message}” → “${out}”`);
      assert.ok(!/\b(?:creem_test|creem|whsec|re)_[^\s[]/.test(out), `${name}: no key-shaped token left in “${out}”`);
    }
  }
  assert.equal(upstreamText(422, ECHOES['ending in 4'](KEYS.resend), [KEYS.resend]), `API key ending in ${HIDDEN} is invalid`);
  assert.equal(upstreamText(422, ECHOES.masked(KEYS.resend), [KEYS.resend]), `Invalid key ${HIDDEN}`);
  assert.equal(upstreamText(422, ECHOES['middle fragment'](KEYS.resend), [KEYS.resend]), `bad key fragment ${HIDDEN}`);
  // Encoded so the patterns can't see it: dropped whole.
  assert.equal(upstreamText(422, ECHOES['URL-encoded'](KEYS.resend), [KEYS.resend]), '');
  assert.equal(upstreamText(422, ECHOES['JSON-escaped'](KEYS.resend), [KEYS.resend]), '');
  // A key-shaped token is hidden even when it isn't one of ours.
  assert.equal(scrubUpstream('Use creem_test_Abc or whsec_x', []), `Use ${HIDDEN} or ${HIDDEN}`);
  assert.equal(scrubUpstream('a'.repeat(500), [], 40).length, 41);
});

test('the last pass over a whole answer hides secrets without touching our own words or public values', async () => {
  const pair = await generatePlusKeyPair();
  const secrets = [...Object.values(KEYS), pair.signingKey, 'dev'];
  const answer = {
    words: 'Check that it is the live key (a test key starts with creem_test_); looks like a Creem test key (creem_test_…), whsec_…, re_…',
    env: 'CREEM_TEST_MODE=1',
    publicKey: pair.publicKey,
    sql: 'CREATE TABLE IF NOT EXISTS events (day TEXT NOT NULL);',
    dev: 'a dev token of 3 characters is not looked for',
    echoes: [KEYS.resend, encodeURIComponent(pair.signingKey), `name ${KEYS.creem.slice(0, 20)}`, `${secretPart(KEYS.webhook).slice(3, 15)}`],
    kept: { secret: KEYS.webhook }
  };
  const out = scrubAnswer(answer, secrets, new Set(['kept']));
  assert.equal(out.words, answer.words);
  assert.equal(out.env, answer.env);
  assert.equal(out.publicKey, pair.publicKey, 'the public key of the pair stays whole');
  assert.equal(out.sql, answer.sql);
  assert.equal(out.dev, answer.dev);
  assert.deepEqual(out.echoes, [HIDDEN, HIDDEN, `name ${HIDDEN}`, HIDDEN]);
  assert.equal(out.kept.secret, KEYS.webhook, 'a key listed in `keep` is left as it is');
});

test('the configuration check never shows a part of the Resend key Resend echoed', async () => {
  for (const [name, make] of Object.entries(ECHOES)) {
    for (const status of [400, 401, 403]) {
      const message = make(KEYS.resend);
      const fetch = async url => (String(url).includes('resend') ? new Response(JSON.stringify({ name: 'validation_error', message }), { status }) : new Response('{}', { status: 404 }));
      const out = await runConfigChecks({ env: { RESEND_API_KEY: KEYS.resend }, fetch, origin: 'https://planner.example.com' });
      assert.deepEqual(runs(JSON.stringify(out), KEYS.resend), [], `${name}, HTTP ${status}`);
      const item = out.items.find(entry => entry.name === 'RESEND_API_KEY');
      assert.equal(item.state, 'problem');
      if (status !== 400) assert.doesNotMatch(item.summary, /Invalid|ending in|fragment|key=|\[hidden\]/, `${status}: our own words only: ${item.summary}`);
    }
  }
});
