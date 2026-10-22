import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlannerApi, createMemoryStore } from '../server/planner-api.js';
import {
  ATTENTION_SECTIONS, attentionBySection, attentionNote, attentionWhen, buildAttention, GIFT_EXPIRY_DAYS, NEW_REVIEW_DAYS,
  REFUND_FOLLOW_UP_DAYS, setupChecks, TEAM_REPLY_DAYS, timeAgo, timeUntil
} from '../admin/attention.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = ms => new Date(NOW - ms).toISOString();
const later = ms => new Date(NOW + ms).toISOString();
const format = { money: (amount, currency) => (amount == null ? '' : `${amount / 100} ${currency}`), number: String };
const AFFILIATE_URL = 'https://affiliates.example.com/daily-planner';
const CONFIG = { SUPPORT_EMAIL: 'hello@example.com', LEGAL_ADDRESS: '1 rue de la Paix, Paris', PLUS_PUBLIC_KEY: 'pub', AFFILIATE_URL };

/** A deployment with nothing to do; each test adds its own trouble. */
function calm(extra = {}) {
  return {
    version: '1.26.0',
    generatedAt: new Date(NOW).toISOString(),
    setup: {
      email: { configured: true, ownerEmail: 'owner@example.com' },
      payments: { configured: true, mode: 'live', webhookSecretSet: true, error: '', products: { plus: { EUR: 'p1', USD: 'p2' }, gift: { EUR: 'g1', USD: 'g2' } } },
      plus: { configured: true, publicKey: 'pub' },
      twoFactor: true
    },
    refunds: [], revocations: [], teamRequests: [], gifts: [], reviews: [],
    ...extra
  };
}
const build = (summary, options = {}) => buildAttention(summary, { now: NOW, config: CONFIG, pageVersion: '1.26.0', ...format, ...options });
const texts = items => items.map(item => item.text);

test('relative times read as plain English, past and future', () => {
  assert.equal(timeAgo(ago(20 * 1000), NOW), 'just now');
  assert.equal(timeAgo(ago(5 * MINUTE), NOW), '5 min ago');
  assert.equal(timeAgo(ago(2 * HOUR + 10 * MINUTE), NOW), '2 h ago');
  assert.equal(timeAgo(ago(DAY + HOUR), NOW), '1 day ago');
  assert.equal(timeAgo(ago(3 * DAY), NOW), '3 days ago');
  assert.equal(timeAgo(ago(15 * DAY), NOW), '2 weeks ago');
  assert.equal(timeAgo(ago(75 * DAY), NOW), '2 months ago');
  assert.equal(timeAgo(ago(400 * DAY), NOW), '1 year ago');
  assert.equal(timeAgo(later(HOUR), NOW), 'just now', 'a clock a little ahead never says “in the future”');
  assert.equal(timeAgo('', NOW), '');
  assert.equal(timeAgo('not a date', NOW), '');
  assert.equal(timeUntil(later(9 * DAY + HOUR), NOW), 'in 9 days');
  assert.equal(timeUntil(later(5 * HOUR), NOW), 'in 5 h');
  assert.equal(timeUntil(later(30 * 1000), NOW), 'in 1 min');
  assert.equal(timeUntil(ago(HOUR), NOW), 'expired');
});

test('each line says when it started, ends or was made; Setup has no date', () => {
  assert.equal(attentionWhen({ when: 'since', at: ago(3 * DAY) }, NOW), '3 days ago');
  assert.equal(attentionWhen({ when: 'until', at: later(9 * DAY + HOUR) }, NOW), 'in 9 days');
  assert.equal(attentionWhen({ when: 'created', at: ago(21 * DAY) }, NOW), 'created 3 weeks ago');
  assert.equal(attentionWhen({ when: 'setup', at: '' }, NOW), 'this deployment');
});

test('a calm deployment has nothing to list', () => {
  assert.deepEqual(build(calm()), []);
  assert.deepEqual(buildAttention(null), []);
  assert.equal(attentionNote([]), '');
  assert.deepEqual(attentionBySection([]), { sections: {}, rows: new Map() });
});

test('refunds: waiting and not matched come first; revoked by hand, restored and settled ones are not to-dos', () => {
  const summary = calm({
    refunds: [
      { id: 'ref_partial', kind: 'refund', item: 'plus', checkoutId: 'ch_p', fullRefund: false, amount: 500, currency: 'EUR', revoked: '', status: '', createdAt: ago(2 * DAY), inForce: false },
      { id: 'ref_full', kind: 'refund', item: 'plus', checkoutId: 'ch_f', fullRefund: true, amount: 2900, currency: 'EUR', revoked: 'license:abc', status: '', createdAt: ago(DAY), inForce: true },
      { id: 'ref_unmatched', kind: 'refund', item: '', fullRefund: true, amount: 2900, currency: 'EUR', revoked: 'order:ord_1', status: '', createdAt: ago(3 * HOUR), inForce: true },
      { id: 'ref_restored', kind: 'refund', item: '', fullRefund: true, amount: 2900, currency: 'EUR', revoked: 'order:ord_2', status: '', createdAt: ago(5 * HOUR), inForce: false },
      { id: 'ref_waiting', kind: 'refund', item: '', amount: 2900, currency: 'EUR', status: 'pending', attempts: 3, createdAt: ago(40 * DAY) },
      { id: 'disp_gift', kind: 'dispute', item: 'gift', checkoutId: 'ch_g', fullRefund: true, amount: 59500, currency: 'EUR', revoked: 'gift:x', status: '', createdAt: ago(4 * DAY), inForce: true },
      { id: 'disp_old', kind: 'dispute', item: 'plus', checkoutId: 'ch_o', fullRefund: true, revoked: 'license:y', status: '', createdAt: ago((REFUND_FOLLOW_UP_DAYS + 1) * DAY), inForce: true }
    ],
    // Revoked by hand: never a to-do.
    revocations: [{ target: 'license:zzz', source: 'owner_abc', kind: 'license', label: 'zzz', reason: 'owner', createdAt: ago(HOUR) }],
    gifts: [{ code: 'ABCD-EFGH-JKMN', org: 'Acme Studio', checkoutRef: 'ch_g', status: 'inactive', seats: 50, redeemed: 3, createdAt: ago(10 * DAY), expiresAt: later(300 * DAY) }]
  });
  const items = build(summary);
  assert.deepEqual(texts(items), [
    'Refund waiting for Creem',
    'A refund matched no purchase',
    'Dispute on Acme Studio’s gift',
    'Partial refund on a Plus purchase'
  ]);
  assert.deepEqual(items.map(item => item.tone), ['urgent', 'urgent', 'warn', 'warn']);
  assert.deepEqual(items.map(item => item.rows[0]), ['refund:ref_waiting', 'refund:ref_unmatched', 'refund:disp_gift', 'refund:ref_partial']);
  assert.ok(items.every(item => item.section === 'refunds' && item.when === 'since'));
  assert.equal(items[0].at, summary.refunds[4].createdAt, 'a waiting refund stays listed however old');
  assert.match(items[0].detail, /^29 EUR · Nothing is switched off until Creem’s transaction can be read \(3 tries\)\.$/);
  assert.match(items[1].detail, /^29 EUR · Find the payment in Creem/);
  assert.equal(attentionNote(items), `Refund decisions aren’t recorded here, so refunds and disputes stay listed for ${REFUND_FOLLOW_UP_DAYS} days.`);
});

test('an older API without inForce: a refund is restored when its revocations are gone', () => {
  const refund = { id: 'ref_old', kind: 'refund', item: '', fullRefund: true, revoked: 'order:ord_1', status: '', createdAt: ago(HOUR) };
  assert.equal(build(calm({ refunds: [refund], revocations: [] })).length, 0);
  assert.equal(build(calm({ refunds: [refund], revocations: [{ source: 'ref_old', target: 'order:ord_1' }] })).length, 1);
  assert.equal(build(calm({ refunds: [refund], refundsUnavailable: true })).filter(item => item.section === 'refunds').length, 0);
});

test('a refund the server ignored (the other Creem mode than its order) is not a to-do', () => {
  // As server/planner-api.js records it: not matched, nothing revoked, and a note that says why.
  const ignored = { id: 'ref_mode', kind: 'refund', orderId: 'ord_1', item: '', checkoutId: '', fullRefund: true, scope: 'full', amount: 2900, currency: 'EUR', revoked: '', status: '', note: 'Ignored: it is in live mode, but its order was paid in test mode.', createdAt: ago(HOUR), inForce: false };
  const dispute = { ...ignored, id: 'disp_mode', kind: 'dispute', note: 'Ignored: it is in test mode, but its order was paid in live mode.' };
  assert.deepEqual(build(calm({ refunds: [ignored, dispute] })), []);
  // Not matched for any other reason: still urgent.
  assert.deepEqual(texts(build(calm({ refunds: [{ ...ignored, note: '' }] }))), ['A refund matched no purchase']);
  const server = readFileSync(new URL('../server/planner-api.js', import.meta.url), 'utf8');
  assert.match(server, /note: otherMode \? `Ignored: /, 'the server still starts the note of an ignored refund with “Ignored”');
});

test('a partial refund is no longer a decision once the payment was switched off by a later refund or a revocation', () => {
  const partial = { id: 'ref_part', kind: 'refund', orderId: 'ord_a', item: 'plus', checkoutId: 'ch_a', fullRefund: false, scope: 'partial', amount: 500, currency: 'EUR', revoked: '', status: '', note: '', createdAt: ago(3 * DAY), inForce: false };
  // The rest, refunded later: its scope says it completed the refund, and it revoked Plus.
  const completes = { ...partial, id: 'ref_rest', fullRefund: true, scope: 'completes', amount: 2400, revoked: 'checkout:ch_a order:ord_a license:abc', createdAt: ago(DAY), inForce: true };
  assert.deepEqual(texts(build(calm({ refunds: [partial] }))), ['Partial refund on a Plus purchase']);
  assert.deepEqual(build(calm({ refunds: [completes, partial] })), []);
  // Matched by its order alone (an older row without a checkout id) …
  assert.deepEqual(build(calm({ refunds: [{ ...completes, checkoutId: '' }, partial] })), []);
  // … or by a revocation of its checkout, whatever made it.
  assert.deepEqual(build(calm({ refunds: [partial], revocations: [{ target: 'checkout:ch_a', source: 'disp_x', kind: 'checkout', label: 'ch_a' }] })), []);
  // Restored by the owner: the partial refund is a decision again.
  assert.deepEqual(texts(build(calm({ refunds: [{ ...completes, inForce: false }, partial] }))), ['Partial refund on a Plus purchase']);
  // Another payment's full refund changes nothing.
  assert.deepEqual(texts(build(calm({ refunds: [{ ...completes, checkoutId: 'ch_b', orderId: 'ord_b' }, partial] }))), ['Partial refund on a Plus purchase']);
});

test('every dispute is listed until it is restored, even one on a payment already refunded', () => {
  const refund = { id: 'ref_full', kind: 'refund', orderId: 'ord_a', item: 'plus', checkoutId: 'ch_a', fullRefund: true, scope: 'full', amount: 2900, currency: 'EUR', revoked: 'checkout:ch_a license:abc', status: '', note: '', createdAt: ago(3 * DAY), inForce: true };
  // As the server records it: nothing left to revoke.
  const dispute = { ...refund, id: 'disp_late', kind: 'dispute', revoked: '', note: 'Already switched off by an earlier refund or dispute.', createdAt: ago(DAY), inForce: false };
  const items = build(calm({ refunds: [dispute, refund] }));
  assert.deepEqual(texts(items), ['Dispute on a Plus purchase']);
  assert.equal(items[0].detail, '29 EUR · An earlier refund or dispute already switched it off. Answer it in Creem.');
  assert.equal(items[0].tone, 'warn');
  const revoking = build(calm({ refunds: [{ ...dispute, revoked: 'license:abc', note: '', inForce: true }] }));
  assert.equal(revoking[0].detail, '29 EUR · Plus is off. Follow it in Creem; Restore it if you win.');
  assert.deepEqual(build(calm({ refunds: [{ ...dispute, revoked: 'license:abc', note: '', inForce: false }] })), [], 'restored: won');
  // A row that says nothing about what happened (an older API): still listed, without guessing.
  assert.equal(build(calm({ refunds: [{ ...dispute, note: '' }] }))[0].detail, '29 EUR · Nothing was switched off. Answer it in Creem, and revoke it by hand if needed.');
});

test('team requests from the last 14 days wait for a reply, oldest first', () => {
  const items = build(calm({
    teamRequests: [
      { id: 3, company: 'Globex', kind: 'question', teamSize: 12, name: '', email: 'ana@globex.example', createdAt: ago(HOUR) },
      { id: 2, company: 'Acme Studio', kind: 'quote', teamSize: 50, name: 'Jane Doe', email: 'jane@acme.example', createdAt: ago(3 * DAY) },
      { id: 1, company: 'Initech', kind: 'invoice', teamSize: 30, createdAt: ago((TEAM_REPLY_DAYS + 1) * DAY) }
    ]
  }));
  assert.deepEqual(texts(items), ['Quote request from Acme Studio waiting for a reply', 'Question from Globex waiting for a reply']);
  assert.deepEqual(items.map(item => item.detail), ['50 people · Jane Doe', '12 people · ana@globex.example']);
  assert.deepEqual(items.map(item => item.rows[0]), ['team:2', 'team:3']);
  assert.equal(attentionNote(items), `Replies aren’t recorded here, so team requests stay listed for ${TEAM_REPLY_DAYS} days.`);
  assert.match(attentionNote([...items, { kind: 'refund-unmatched' }]), /team requests stay listed for 14 days and refunds for 30\.$/);
  assert.deepEqual(build(calm({ teamRequestsUnavailable: true, teamRequests: [{ id: 9, company: 'X', createdAt: ago(HOUR) }] })).map(item => item.text), ['Database: migration 0002_team_requests.sql not applied']);
});

test('a question waits for a reply too: who asked and the start of the question, never “a team” or “0 people”', () => {
  const long = `Can I ${'really '.repeat(20)}pay by invoice?`;
  const items = build(calm({
    teamRequests: [
      { id: 5, company: '', kind: 'question', teamSize: 0, timing: '', name: 'Ann', email: 'ann@example.com', message: 'Can I pay\nby invoice?', createdAt: ago(HOUR) },
      { id: 4, company: '', kind: 'question', teamSize: 0, timing: '', name: '', email: 'bo@example.com', message: long, createdAt: ago(2 * HOUR) }
    ]
  }));
  assert.deepEqual(texts(items), ['Question from bo@example.com waiting for a reply', 'Question from Ann waiting for a reply']);
  assert.equal(items[1].detail, '“Can I pay by invoice?”');
  assert.ok(items[0].detail.length <= 82 && items[0].detail.endsWith('…”'), items[0].detail);
  assert.ok(items.every(item => item.section === 'teams' && !/people|a team/.test(`${item.text} ${item.detail}`)));
  assert.equal(ATTENTION_SECTIONS.teams, 'Requests and questions');
});

test('Setup: test mode, legal pages, two-factor and a stale page each get a line, in the card’s order', () => {
  const summary = calm({ version: '1.27.0' });
  summary.setup.payments.mode = 'test';
  summary.setup.twoFactor = false;
  const items = build(summary, { config: { PLUS_PUBLIC_KEY: 'pub', SUPPORT_EMAIL: 'hello@example.com', AFFILIATE_URL } });
  assert.deepEqual(texts(items), [
    'This dashboard is 1.26.0, 1.27.0 is deployed: reload it',
    'Creem is in test mode: no real payments',
    'Legal pages: postal address missing',
    'Two-factor sign-in is off'
  ]);
  assert.ok(items.every(item => item.tone === 'warn' && item.section === 'setup' && item.when === 'setup'));
  assert.deepEqual(items.map(item => item.rows[0]), ['setup:version', 'setup:payments', 'setup:legal', 'setup:sign-in']);
  assert.equal(items[0].icon, 'version');
  const blank = build(calm(), { config: { PLUS_PUBLIC_KEY: 'pub' } });
  assert.deepEqual(texts(blank), ['Partners: the Creem sign-up link isn’t set', 'Legal pages: contact address and postal address missing']);
  assert.deepEqual(build(calm(), { config: { ...CONFIG, AFFILIATE_URL: 'http://not-https.example.com' } }).map(item => [item.text, item.tone, item.rows[0]]), [['Partners: the Creem sign-up link isn’t set', 'warn', 'setup:partners']]);
});

test('Setup: a legal value the pages can’t use is not ready, with the same checks as legal/legal-details.js', () => {
  const legal = config => Object.fromEntries(setupChecks(calm(), { config: { ...CONFIG, ...config }, pageVersion: '1.26.0' }).map(check => [check.key, check])).legal;
  assert.equal(legal({ PRIVACY_EMAIL: 'privacy@example.com', LEGAL_PHONE: '+33 1 99 00 12 34', LEGAL_REGISTRATION: 'SIRET 1' }).state, 'ok');
  assert.equal(legal({ LEGAL_PHONE: '' }).state, 'ok', 'no phone number: recommended, not required');
  const bad = legal({ SUPPORT_EMAIL: 'ben at example dot com', PRIVACY_EMAIL: 'privacy@example', LEGAL_PHONE: '+33 1 99 00 12 34 (office)' });
  assert.equal(bad.state, 'warn');
  assert.deepEqual(bad.problems, [
    'Legal pages: DAILY_PLANNER_SUPPORT_EMAIL is set, but not used (not a plain email address)',
    'Legal pages: DAILY_PLANNER_PRIVACY_EMAIL is set, but not used (not a plain email address)',
    'Legal pages: DAILY_PLANNER_LEGAL_PHONE is set, but not used (not a phone number)'
  ]);
  assert.equal(legal({ LEGAL_PHONE: '+33199001234' }).state, 'ok', 'the phone as the owner types it: E.164');
  assert.deepEqual(legal({ LEGAL_PHONE: '+330199001234' }).problems, [
    'Legal pages: DAILY_PLANNER_LEGAL_PHONE is set, but not used (not a phone number: after +33, the 9 digits of the number, without its leading 0)'
  ], 'a French number with its 0 says what to change');
  assert.deepEqual(legal({ SUPPORT_EMAIL: 'me@example.com?bcc=x@example.com', LEGAL_ADDRESS: '  ' }).problems, [
    'Legal pages: postal address missing',
    'Legal pages: DAILY_PLANNER_SUPPORT_EMAIL is set, but not used (not a plain email address)'
  ], 'an unusable address is said once, not also as missing');
});

test('the Setup card says “set, but not used” with the legal pages’ own checks, and calls the phone number recommended', () => {
  const source = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ legalDetails, legalEmail, legalValueProblem \} from '\.\.\/legal\/legal-details\.js';/);
  assert.match(source, /`set, but not used: \$\{problem\}`/);
  const variables = /const LEGAL_VARIABLES = \[([\s\S]*?)\n\];/.exec(source)?.[1] || '';
  assert.match(variables, /\['LEGAL_PHONE', 'recommended \(French law asks an individual publisher for one\)/);
  assert.doesNotMatch(variables, /\['LEGAL_PHONE', 'optional/);
  // How to write the phone number (E.164, no spaces), and how the page shows it.
  assert.match(variables, /\['LEGAL_PHONE', '[^']*international form, <code>\+33<\/code> then the number without its 0, with no spaces \(e\.g\. <code>\+33199001234<\/code>\)[^']*<code>\+33 1 99 00 12 34<\/code>/);
  assert.match(source, /if \(key === 'LEGAL_PHONE'\) return `set, shown as \$\{esc\(legalDetails\(APP_CONFIG\)\.phone\)\}`;/, 'Setup shows how the number reads');
  assert.match(variables, /\['SUPPORT_EMAIL', '[^']*on the Contact page \(“Prefer email\? Write to …”\)/);
  assert.doesNotMatch(variables, /Support” line|Support line/, 'no footer shows it any more (1.32)');
});

test('Setup: missing pieces are urgent and come before every to-do', () => {
  const summary = calm({ refundsUnavailable: true, reviewsUnavailable: true, teamRequests: [{ id: 1, company: 'Acme', kind: 'quote', teamSize: 5, createdAt: ago(HOUR) }] });
  summary.setup.email = { configured: false, ownerEmail: '' };
  summary.setup.payments = { configured: false };
  summary.setup.plus = { configured: false, keySet: true };
  const items = build(summary);
  assert.deepEqual(texts(items), [
    'Email isn’t set up: nothing can be sent',
    'Owner email isn’t set: no team request notifications',
    'The Plus signing key isn’t valid',
    'Payments aren’t set up: nothing can be bought online',
    'Database: 2 migrations not applied',
    'Quote request from Acme waiting for a reply'
  ]);
  assert.deepEqual(items.map(item => item.tone), ['urgent', 'urgent', 'urgent', 'urgent', 'urgent', 'warn']);
});

test('setupChecks gives the Setup card its states', () => {
  const summary = calm();
  summary.setup.payments.products.gift.USD = '';
  summary.setup.payments.webhookSecretSet = false;
  const checks = Object.fromEntries(setupChecks(summary, { config: { ...CONFIG, PLUS_PUBLIC_KEY: '' }, pageVersion: '1.26.0' }).map(check => [check.key, check]));
  assert.deepEqual(Object.keys(checks), ['version', 'email', 'owner-email', 'plus', 'payments', 'links', 'partners', 'legal', 'database', 'sign-in']);
  assert.equal(checks.partners.state, 'ok');
  assert.equal(checks.version.state, 'ok');
  assert.equal(checks.plus.state, 'warn');
  assert.deepEqual(checks.plus.problems, ['The app has no Plus public key']);
  assert.equal(checks.payments.state, 'warn');
  assert.deepEqual(checks.payments.problems, ['Creem: 1 product id is missing', 'Creem’s webhook secret isn’t set: refunds don’t switch Plus off']);
  assert.deepEqual(checks.legal.problems, []);
  assert.equal(setupChecks(calm({ version: '' }), { config: CONFIG, pageVersion: '1.26.0' })[0].state, 'warn', 'an API that reports no version');
  assert.deepEqual(setupChecks({ version: '1.26.0' }), [], 'an API that does not report its setup');
});

test('gifts: about to expire (soonest first) and fully claimed are worth a look, below every to-do', () => {
  const items = build(calm({
    gifts: [
      { code: 'AAAA-AAAA-AAAA', org: 'Acme Studio', status: 'available', seats: 50, redeemed: 12, createdAt: ago(355 * DAY), expiresAt: later(9 * DAY + HOUR) },
      { code: 'BBBB-BBBB-BBBB', org: 'Globex', status: 'available', seats: 10, redeemed: 2, createdAt: ago(360 * DAY), expiresAt: later(2 * DAY) },
      { code: 'CCCC-CCCC-CCCC', org: 'Initech', status: 'available', seats: 10, redeemed: 2, createdAt: ago(10 * DAY), expiresAt: later((GIFT_EXPIRY_DAYS + 1) * DAY) },
      { code: 'DDDD-DDDD-DDDD', org: 'Umbrella', status: 'claimed', seats: 10, limit: 11, redeemed: 11, createdAt: ago(21 * DAY), expiresAt: later(340 * DAY) },
      { code: 'EEEE-EEEE-EEEE', org: 'Hooli', status: 'expired', seats: 10, redeemed: 1, createdAt: ago(400 * DAY), expiresAt: ago(DAY) },
      { code: 'FFFF-FFFF-FFFF', org: 'Vandelay', status: 'inactive', seats: 10, redeemed: 1, createdAt: ago(10 * DAY), expiresAt: later(3 * DAY) }
    ],
    teamRequests: [{ id: 1, company: 'Acme Studio', kind: 'invoice', teamSize: 50, createdAt: ago(DAY) }]
  }));
  assert.deepEqual(texts(items), [
    'Invoice request from Acme Studio waiting for a reply',
    'Globex’s gift link is about to expire',
    'Acme Studio’s gift link is about to expire',
    'Umbrella’s gift link is fully claimed'
  ]);
  assert.deepEqual(items.slice(1).map(item => item.tone), ['info', 'info', 'info']);
  assert.equal(items[2].detail, '12 of 50 seats activated');
  assert.equal(attentionWhen(items[2], NOW), 'in 9 days');
  assert.equal(items[3].detail, '11 of 11 activations used');
  assert.equal(attentionWhen(items[3], NOW), 'created 3 weeks ago');
  assert.deepEqual(texts(build(calm({ plusUnavailable: true, gifts: [{ code: 'X', org: 'X', status: 'claimed', createdAt: ago(DAY) }] }))), ['Database: migration 0003_plus.sql not applied']);
  assert.deepEqual(texts(build(calm({ partnersUnavailable: true }))), ['Database: migration 0006_partners.sql not applied']);
  assert.deepEqual(texts(build(calm({ partnerCommissionsUnavailable: true }))), ['Database: run migrations/0007_partner_commissions.sql to track team commissions']);
});

test('new reviews are one line, from the oldest, pointing at every new review', () => {
  const items = build(calm({
    reviews: [
      { id: 7, name: 'Marie', rating: 5, createdAt: ago(HOUR) },
      { id: 6, name: '', rating: 4, createdAt: ago(5 * DAY) },
      { id: 2, name: 'Old', rating: 5, createdAt: ago((NEW_REVIEW_DAYS + 1) * DAY) }
    ]
  }));
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '2 new reviews to read');
  assert.deepEqual(items[0].rows, ['review:7', 'review:6']);
  assert.equal(attentionWhen(items[0], NOW), '5 days ago');
  assert.equal(build(calm({ reviews: [{ id: 7, name: 'Marie', createdAt: ago(HOUR) }] }))[0].text, 'New review from Marie to read');
  assert.equal(build(calm({ reviews: [{ id: 7, name: ' ', createdAt: ago(HOUR) }] }))[0].text, 'New review to read');
});

test('cards count their rows and take their most urgent tone', () => {
  const summary = calm({
    refunds: [
      { id: 'r1', kind: 'refund', item: '', fullRefund: true, revoked: '', status: '', createdAt: ago(HOUR) },
      { id: 'r2', kind: 'refund', item: 'plus', fullRefund: false, revoked: '', status: '', createdAt: ago(HOUR) }
    ],
    reviews: [{ id: 1, name: 'A', createdAt: ago(HOUR) }, { id: 2, name: 'B', createdAt: ago(2 * HOUR) }]
  });
  summary.setup.payments.mode = 'test';
  summary.setup.payments.webhookSecretSet = false;
  const { sections, rows } = attentionBySection(build(summary));
  assert.deepEqual(sections, {
    refunds: { count: 2, tone: 'urgent' },
    setup: { count: 1, tone: 'warn' },
    reviews: { count: 2, tone: 'info' }
  });
  assert.equal(rows.get('refund:r1'), 'urgent');
  assert.equal(rows.get('refund:r2'), 'warn');
  assert.equal(rows.get('setup:payments'), 'warn', 'two problems, one Setup row');
  assert.equal(rows.get('review:2'), 'info');
  assert.deepEqual(Object.keys(ATTENTION_SECTIONS), ['refunds', 'teams', 'partners', 'setup', 'gifts', 'reviews']);
});

test('the summary’s own time is “now” when none is given', () => {
  const summary = calm({ teamRequests: [{ id: 1, company: 'Acme', kind: 'quote', createdAt: ago((TEAM_REPLY_DAYS - 1) * DAY) }] });
  assert.equal(buildAttention(summary, { config: CONFIG, pageVersion: '1.26.0' }).length, 1);
  assert.equal(buildAttention({ ...summary, generatedAt: later(2 * DAY) }, { config: CONFIG, pageVersion: '1.26.0' }).length, 0);
});

test('the admin summary carries the dates the list reads', async () => {
  const store = createMemoryStore({
    teamRequests: [{ id: 1, email: 'jane@acme.example', name: 'Jane', company: 'Acme Studio', teamSize: 50, timing: 'later', plan: '', currency: '', kind: 'quote', message: '', locale: 'en', appVersion: '1.26.0', source: 'landing', createdAt: ago(DAY) }],
    refunds: [{ id: 'ref_1', kind: 'refund', orderId: 'ord_1', transactionId: 'tran_1', checkoutId: '', item: '', amount: 2900, currency: 'EUR', fullRefund: true, scope: 'full', reason: '', revoked: '', status: '', note: '', attempts: 0, notified: true, createdAt: ago(HOUR) }],
    reviews: [{ id: 2, appVersion: '1.26.0', rating: 5, text: 'Calm and clear.', name: 'Marie', createdAt: ago(2 * HOUR) }]
  });
  const api = createPlannerApi({ store, adminToken: 'secret', now: () => new Date(NOW) });
  const summary = await (await api(new Request('https://planner.test/api/admin/summary', { headers: { authorization: 'Bearer secret' } }))).json();
  assert.equal(summary.generatedAt, new Date(NOW).toISOString());
  assert.equal(summary.teamRequests[0].createdAt, ago(DAY));
  assert.equal(summary.refunds[0].createdAt, ago(HOUR));
  assert.equal(summary.reviews[0].createdAt, ago(2 * HOUR));
  const items = buildAttention(summary, { config: CONFIG, pageVersion: summary.version, ...format });
  assert.deepEqual(texts(items.filter(item => item.section !== 'setup')), [
    'A refund matched no purchase',
    'Quote request from Acme Studio waiting for a reply',
    'New review from Marie to read'
  ]);
});

test('team commissions earned and not paid: one line each, the longest-waiting first, after team requests', () => {
  const owed = (id, code, commission, earnedDaysAgo, extra = {}) => ({ checkoutId: id, code, plan: 'up-to-50', rate: 10, base: commission * 10, basis: 'before-tax', commission, currency: 'EUR', earnedAt: ago(earnedDaysAgo * DAY), createdAt: ago((earnedDaysAgo + 14) * DAY), ...extra });
  const summary = calm({
    partners: { toPay: [owed('ch_new', 'ANNA', 4958, 1), owed('ch_old', 'COACH', 1625, 9, { plan: 'up-to-10', basis: 'paid', base: 16250, exact: false, checks: ['tax'] })] },
    teamRequests: [{ id: 3, company: 'Acme', kind: 'invoice', createdAt: ago(HOUR) }]
  });
  const items = build(summary);
  assert.deepEqual(items.map(item => [item.kind, item.tone, item.section, item.rows[0], item.when]), [
    ['team', 'warn', 'teams', 'team:3', 'since'],
    ['partner-pay', 'warn', 'partners', 'partner:ch_old', 'earned'],
    ['partner-pay', 'warn', 'partners', 'partner:ch_new', 'earned']
  ]);
  const [, old, recent] = items;
  // The tax isn't recorded: the figure is only an upper bound, and the line says what to check.
  assert.equal(old.text, 'Pay COACH at most 16.25 EUR (10% of a team gift)');
  assert.equal(old.detail, 'Tax not recorded: check it in Creem, and pay 10% of the price before tax · Team gift for up to 10 people · 10% of 162.5 EUR paid, tax included · by bank transfer, then Mark as paid');
  assert.equal(recent.text, 'Pay ANNA 49.58 EUR (10% of a team gift)');
  assert.match(recent.detail, /^Team gift for up to 50 people · 10% of 495\.8 EUR before tax · /);
  assert.equal(attentionWhen(old, NOW), 'earned 9 days ago');
  assert.equal(attentionBySection(items).sections.partners.count, 2);
  // The rate the API reports wins; nothing listed while 0006 is missing; nothing when all is paid.
  assert.match(build(calm({ partnerProgram: { teamRate: 12 }, partners: { toPay: [owed('ch_x', 'X', 100, 2)] } }))[0].text, /\(12% of a team gift\)$/);
  assert.deepEqual(build(calm({ partnersUnavailable: true, partners: { toPay: [owed('ch_x', 'X', 100, 2)] } })).filter(item => item.kind === 'partner-pay'), []);
  // Without migration 0007 nothing can be marked as paid: no “Pay …” line, only Setup’s one line to run it.
  assert.deepEqual(texts(build(calm({ partnerCommissionsUnavailable: true, partners: { toPay: [owed('ch_x', 'X', 100, 2)] } }))), ['Database: run migrations/0007_partner_commissions.sql to track team commissions']);
  assert.deepEqual(build(calm({ partners: { toPay: [] } })), []);
});

test('a team commission to check says what before paying: an invented code, a refund of unknown amount', () => {
  const owed = (id, code, extra = {}) => ({ checkoutId: id, code, plan: 'up-to-10', amount: 19500, rate: 10, base: 16250, basis: 'before-tax', commission: 1625, exact: true, currency: 'EUR', checks: [], earnedAt: ago(2 * DAY), createdAt: ago(16 * DAY), ...extra });
  const [bad] = build(calm({ partners: { toPay: [owed('ch_bad', 'BADCODE', { checks: ['code'] })] } }));
  assert.equal(bad.text, 'Pay BADCODE 16.25 EUR (10% of a team gift)');
  assert.equal(bad.detail, 'Check that BADCODE is a partner in Creem → Affiliate Hub before paying · Team gift for up to 10 people · 10% of 162.5 EUR before tax · by bank transfer, then Mark as paid');
  const [refunded] = build(calm({ partners: { toPay: [owed('ch_ref', 'CAMILLE', { checks: ['refund'], exact: false, refundUnknown: true })] } }));
  assert.equal(refunded.text, 'Pay CAMILLE at most 16.25 EUR (10% of a team gift)');
  assert.match(refunded.detail, /^Part refunded, amount unknown: check the refund in Creem before paying · /);
});

test('the dashboard loads the helpers and reloads them with its other files', () => {
  const source = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/attention\.js'/);
  assert.match(source, /DASHBOARD_FILES = \[[^\]]*'\.\/attention\.js'/);
  assert.match(source, /from '\.\/partners-view\.js'/);
  assert.match(source, /DASHBOARD_FILES = \[[^\]]*'\.\/partners-view\.js'[^\]]*'\.\.\/src\/lib\/pricing\.js'/, 'and the prices they import');
  assert.match(source, /partners: '\[data-owner-partners\]'/, 'a partner line points at the Partners card');
  const page = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
  assert.ok(page.indexOf('data-owner-attention') < page.indexOf('data-owner-kpis'), 'the panel comes first in the dashboard');
});
