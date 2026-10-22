import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 1.33: an individual partner's yearly cap on team commissions, the partner's
// status (individual or business, migration 0008), commissions paid in parts,
// the private statement (signed link, that code only, nothing about buyers)
// and the visits counted through partner links.

// The client's visit count reads the runtime configuration when it loads.
globalThis.__DAILY_PLANNER_CONFIG__ = { PLANNER_API_URL: '/api/' };
const stored = new Map();
const storage = { getItem: key => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) };
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    sent.push({ url, body: JSON.parse(options.body || '{}') });
    return { ok: true, status: 204, json: async () => ({}) };
  }
  return realFetch(url, options);
};

const client = await import('../src/lib/planner-api.js');
const { createMemoryStore, createPlannerApi } = await import('../server/planner-api.js');
const { createD1Store } = await import('../server/d1-store.js');
const partners = await import('../server/partners.js');
const { partnerSummary, payoutCheck, partnerStatement, statementKey, verifyStatementKey, statementUrl, payoutPartId, payoutTarget, visitTotals, statementVisitsFrom, createPartnerLimits, PARTNER_VISIT_CODES_PER_DAY, capRefusalText } = partners;
const { PARTNER_PROGRAM } = await import('../src/lib/pricing.js');
const view = await import('../admin/partners-view.js');
const { buildAttention } = await import('../admin/attention.js');
const model = await import('../partners/statement-model.js');

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const NOW = Date.parse('2026-12-20T10:00:00Z');
const NEW_YEAR = Date.parse('2027-01-02T10:00:00Z');
/** A team gift through a partner's link, `daysAgo` before `at`, with its tax known (exact commission). */
const team = (checkoutId, plan, amount, tax, daysAgo, fields = {}, at = NOW) => ({ checkoutId, code: 'CAMILLE', kind: 'gift', plan, payer: 'owner', amount, tax, currency: 'EUR', member: false, mode: 'prod', createdAt: iso(at - daysAgo * DAY), ...fields });
const plus = (checkoutId, daysAgo, fields = {}) => ({ checkoutId, code: 'CAMILLE', kind: 'plus', plan: '', amount: 2900, tax: 483, currency: 'EUR', member: false, mode: 'prod', createdAt: iso(NOW - daysAgo * DAY), ...fields });
// up-to-1000: 10% of €4,162.50 = €416.25; up-to-100: €82.92; up-to-10: €16.25.
const BIG = ['up-to-1000', 499500, 83250];
const MID = ['up-to-100', 99500, 16583];
const SMALL = ['up-to-10', 19500, 3250];
const payout = (checkoutId, amount, paidAt, fields = {}) => ({ checkoutId, code: 'CAMILLE', amount, currency: 'EUR', note: '', paidAt, ...fields });

// ---- The yearly cap (pure) ------------------------------------------------------

test('PARTNER_PROGRAM caps an individual’s team commissions at €300 / $300 a calendar year', () => {
  assert.deepEqual({ ...PARTNER_PROGRAM.individualYearlyCap }, { EUR: 300, USD: 300 });
  assert.ok(Object.isFrozen(PARTNER_PROGRAM.individualYearlyCap));
  assert.equal(partners.yearlyCapCents('EUR'), 30000);
  assert.equal(partners.yearlyCapCents('USD'), 30000);
  assert.equal(partners.yearlyCapCents('GBP'), null, 'a currency it doesn’t name: no cap');
  assert.equal(partners.partnerStatus('Business'), 'business');
  assert.equal(partners.partnerStatus('anything'), 'individual', 'unknown reads as an individual: the safe side');
});

test('earned commissions share what is left of the cap, the oldest first; the rest is held, and a new year frees it', () => {
  const rows = [team('ch_big', ...BIG, 60), team('ch_mid', ...MID, 30), team('ch_soon', ...SMALL, 3), team('ch_usd', ...SMALL, 20, { currency: 'USD' }), team('ch_old', ...MID, 300)];
  // €100 paid this year (another commission, paid in March), €250 last year: only this year's counts.
  const payouts = [payout('ch_old', 10000, '2026-03-02T09:00:00Z'), payout('ch_gone', 25000, '2025-12-31T23:59:00Z')];
  const summary = partnerSummary(rows, [], [], { now: NOW, payouts });
  const sale = id => summary.team.find(row => row.checkoutId === id);
  assert.deepEqual([sale('ch_big').status, sale('ch_big').rest, sale('ch_big').payable, sale('ch_big').held], ['earned', 41625, 20000, 21625]);
  assert.deepEqual([sale('ch_mid').status, sale('ch_mid').payable, sale('ch_mid').held], ['held', 0, 8292]);
  assert.deepEqual([sale('ch_soon').status, sale('ch_soon').payable, sale('ch_soon').held], ['pending', 1625, 0], 'pending: not capped until earned');
  assert.deepEqual([sale('ch_usd').status, sale('ch_usd').payable, sale('ch_usd').held], ['earned', 1625, 0], 'dollars have their own cap');
  assert.deepEqual(sale('ch_big').cap, { year: 2026, limit: 30000, paid: 10000 });
  const camille = summary.codes[0];
  assert.deepEqual(camille.team.toPay, { EUR: 20000, USD: 1625 });
  assert.deepEqual(camille.team.held, { EUR: 29917 });
  assert.deepEqual(camille.cap, { year: 2026, lines: [{ currency: 'EUR', limit: 30000, paid: 10000, left: 20000, held: 29917 }, { currency: 'USD', limit: 30000, paid: 0, left: 30000, held: 0 }] });
  assert.deepEqual(summary.toPay.map(row => [row.checkoutId, row.payable, row.held]), [['ch_big', 20000, 21625], ['ch_usd', 1625, 0]], 'only what can be paid now');
  assert.deepEqual([summary.totals.team.toPayCount, summary.totals.team.heldCount, summary.totals.team.held], [2, 2, { EUR: 29917 }]);
  // 2 January: the new year's cap. March's €100 no longer counts.
  const next = partnerSummary(rows, [], [], { now: NEW_YEAR, payouts });
  const later = id => next.team.find(row => row.checkoutId === id);
  assert.deepEqual([later('ch_big').payable, later('ch_big').held, later('ch_mid').payable, later('ch_mid').held, later('ch_mid').status], [30000, 11625, 0, 8292, 'held']);
  assert.deepEqual([later('ch_soon').status, later('ch_soon').held], ['held', 1625], 'earned on 31 December, after the older ones');
  assert.deepEqual(next.codes[0].cap.lines[0], { currency: 'EUR', limit: 30000, paid: 0, left: 30000, held: 21542 });
});

test('a payment on 31 December counts for that year, not the next (UTC)', () => {
  const rows = [team('ch_big', ...BIG, 60, {}, NEW_YEAR)];
  const lastDay = [payout(payoutPartId('ch_big', 1), 30000, '2026-12-31T23:59:59Z')];
  const before = partnerSummary(rows, [], [], { now: Date.parse('2026-12-31T23:59:59.500Z'), payouts: lastDay });
  assert.deepEqual([before.team[0].status, before.team[0].payable, before.team[0].cap.paid], ['held', 0, 30000]);
  const after = partnerSummary(rows, [], [], { now: Date.parse('2027-01-01T00:00:00Z'), payouts: lastDay });
  assert.deepEqual([after.team[0].status, after.team[0].rest, after.team[0].payable, after.team[0].cap.paid], ['earned', 11625, 11625, 0]);
});

test('a business has no cap; before migration 0008 every partner is an individual', () => {
  const rows = [team('ch_big', ...BIG, 60), team('ch_mid', ...MID, 30)];
  const business = partnerSummary(rows, [], [], { now: NOW, profiles: [{ code: 'CAMILLE', status: 'business', updatedAt: iso(NOW) }] });
  assert.deepEqual(business.team.map(row => [row.status, row.payable, row.held, row.partner, row.cap]), [['earned', 8292, 0, 'business', null], ['earned', 41625, 0, 'business', null]]);
  assert.deepEqual([business.codes[0].partner, business.codes[0].cap, business.codes[0].team.toPay], ['business', null, { EUR: 49917 }]);
  // No profiles (0008 missing, or nothing recorded): an individual.
  const before = partnerSummary(rows, [], [], { now: NOW });
  assert.deepEqual([before.codes[0].partner, before.codes[0].team.toPay, before.codes[0].team.held], ['individual', { EUR: 30000 }, { EUR: 19917 }]);
  // Test-mode sales are never capped or counted.
  const tried = partnerSummary([team('ch_try', ...BIG, 60, { mode: 'test' })], [], [], { now: NOW });
  assert.deepEqual([tried.team, tried.toPay, tried.codes[0].cap], [[], [], null]);
});

test('Mark as paid takes what fits under the cap, refuses more (409), and keeps the rest owed until it is paid', () => {
  const rows = [team('ch_big', ...BIG, 60), team('ch_mid', ...MID, 30)];
  const summary = partnerSummary(rows, [], [], { now: NOW, payouts: [], rejections: [] });
  const asked = payoutCheck(summary, 'ch_big', { confirmed: true });
  assert.deepEqual([asked.status, asked.cap], [409, true], 'the whole commission is more than the cap leaves');
  assert.match(asked.error, /^416\.25 EUR is more than what fits under CAMILLE’s yearly cap for an individual: 300\.00 EUR of team commissions in 2026, 0\.00 EUR paid so far\. Mark 300\.00 EUR as paid now; the rest \(116\.25 EUR\) waits until CAMILLE invoices you as a business \(switch CAMILLE to Business on the Partners card\), or until 1 January 2027\.$/);
  assert.equal(payoutCheck(summary, 'ch_big', { confirmed: true, amount: 30001 }).status, 409);
  assert.equal(payoutCheck(summary, 'ch_big', { confirmed: true, amount: 41626 }).status, 400, 'more than the commission');
  assert.equal(payoutCheck(summary, 'ch_big', { confirmed: true, amount: 12000 }).status, 400, 'an exact commission takes the cap’s part, nothing else');
  const part = payoutCheck(summary, 'ch_big', { confirmed: true, amount: 30000 });
  assert.deepEqual([part.amount, part.final], [30000, false]);
  // The next one, held above the cap: nothing can be paid.
  const held = payoutCheck(summary, 'ch_mid', { confirmed: true });
  assert.deepEqual([held.status, held.cap], [409, true]);
  assert.match(held.error, /^This commission is above CAMILLE’s yearly cap for an individual: .*and what is left goes to older commissions first\. It waits until CAMILLE invoices you as a business/);
  // The part paid is kept as `<checkout>.1`; the rest is held until the new year.
  const paid = [payout(payoutPartId('ch_big', 1), 30000, iso(NOW))];
  assert.deepEqual(payoutTarget('ch_big.1'), { checkoutId: 'ch_big', part: 1 });
  assert.deepEqual(payoutTarget('ch_big'), { checkoutId: 'ch_big', part: 0 });
  const after = partnerSummary(rows, [], [], { now: NOW, payouts: paid });
  const big = after.team.find(row => row.checkoutId === 'ch_big');
  assert.deepEqual([big.status, big.paidAmount, big.rest, big.payable, big.held, big.parts, big.paidAt, big.lastPaidAt], ['held', 30000, 11625, 0, 11625, 1, '', iso(NOW)]);
  assert.deepEqual([after.codes[0].team.paid, after.codes[0].cap.lines[0].paid, after.codeChecks.CAMILLE], [{ EUR: 30000 }, 30000, 'paid']);
  assert.match(capRefusalText(big), /^This commission is above CAMILLE’s yearly cap for an individual: 300\.00 EUR of team commissions in 2026, 300\.00 EUR paid so far\. It waits/);
  // In the new year the rest is paid, and settles it (the checkout's own row).
  const january = partnerSummary(rows, [], [], { now: NEW_YEAR, payouts: paid });
  const rest = payoutCheck(january, 'ch_big', { confirmed: true });
  assert.deepEqual([rest.amount, rest.final], [11625, true]);
  const settled = partnerSummary(rows, [], [], { now: NEW_YEAR, payouts: [...paid, payout('ch_big', 11625, iso(NEW_YEAR))] });
  const done = settled.team.find(row => row.checkoutId === 'ch_big');
  assert.deepEqual([done.status, done.paidAmount, done.parts, settled.codes[0].cap.lines[0].paid], ['paid', 41625, 2, 11625]);
  assert.equal(payoutCheck(settled, 'ch_big', { confirmed: true }).status, 409, 'already paid');
  // What is left of 2027's cap goes to the next commission.
  assert.deepEqual([settled.team.find(row => row.checkoutId === 'ch_mid').payable], [8292]);
});

test('an upper bound under the cap: the amount paid settles it, unless the owner says more is owed (part)', () => {
  const rows = [team('ch_bound', 'up-to-1000', 499500, null, 60)];
  const summary = partnerSummary(rows, [], [], { now: NOW });
  const sale = summary.team[0];
  assert.deepEqual([sale.exact, sale.rest, sale.payable, sale.held], [false, 49950, 30000, 19950]);
  assert.equal(payoutCheck(summary, 'ch_bound', { confirmed: true }).status, 400, 'the amount paid is needed');
  assert.equal(payoutCheck(summary, 'ch_bound', { confirmed: true, amount: 40000 }).status, 409, 'more than the cap leaves');
  assert.deepEqual(payoutCheck(summary, 'ch_bound', { confirmed: true, amount: 30000 }).final, true, 'the whole commission, as the owner says');
  assert.deepEqual(payoutCheck(summary, 'ch_bound', { confirmed: true, amount: 30000, part: true }).final, false, 'part of it: the rest waits');
  assert.deepEqual(payoutCheck(summary, 'ch_bound', { confirmed: true, amount: 25000, part: true }).final, true, 'below the cap’s part: never a part');
});

test('paid in part, then refunded or found to be no partner: the part paid stays paid, the rest earns nothing', () => {
  const rows = [team('ch_big', ...BIG, 60)];
  const paid = [payout('ch_big.1', 30000, iso(NOW - DAY))];
  const disputed = partnerSummary(rows, [{ checkoutId: 'ch_big', reason: 'dispute' }], [], { now: NOW, payouts: paid });
  assert.deepEqual([disputed.team[0].status, disputed.team[0].paidAmount, disputed.team[0].state, disputed.toPay], ['paid', 30000, 'disputed', []]);
  const rejected = partnerSummary(rows, [], [], { now: NOW, payouts: paid, rejections: [{ code: 'CAMILLE' }] });
  assert.deepEqual([rejected.team[0].status, rejected.codes[0].team.held], ['paid', {}]);
  assert.match(view.commissionState(disputed.team[0], { day: value => value.slice(0, 10), money: (cents, currency) => `${(cents / 100).toFixed(2)} ${currency}` }).detail, /Disputed after you paid part of it: the rest earns nothing/);
});

// ---- The statement (pure) --------------------------------------------------------

test('a statement link is signed per code with a key derived from ADMIN_TOKEN, and checked in constant time', async () => {
  const key = await statementKey('admin-secret', 'CAMILLE');
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(await statementKey('admin-secret', 'CAMILLE'), key, 'the same link every time');
  assert.notEqual(await statementKey('admin-secret', 'camille'), key, 'codes are case-sensitive');
  assert.notEqual(await statementKey('other-secret', 'CAMILLE'), key, 'rotating ADMIN_TOKEN changes every link');
  assert.equal(await statementKey('', 'CAMILLE'), '');
  assert.equal(await statementKey('admin-secret', 'not a code!'), '');
  assert.equal(await statementKey('admin-secret', ' CAMILLE'), '', 'exactly the code');
  assert.equal(await verifyStatementKey('admin-secret', 'CAMILLE', key), true);
  assert.equal(await verifyStatementKey('admin-secret', 'ANNA', key), false, 'another code’s key fails');
  assert.equal(await verifyStatementKey('admin-secret', 'CAMILLE', key.toUpperCase()), false);
  assert.equal(await verifyStatementKey('admin-secret', 'CAMILLE', `${key.slice(0, -1)}0`.replace(/0$/, key.endsWith('0') ? '1' : '0')), false);
  assert.equal(await verifyStatementKey('', 'CAMILLE', key), false);
  assert.equal(await verifyStatementKey('admin-secret', 'CAMILLE', null), false);
  // Apart from the waitlist's removal tokens and sessions, which use the same secret.
  const { waitlistRemoveToken } = await import('../server/admin-auth.js');
  assert.ok(!(await waitlistRemoveToken('admin-secret', 'CAMILLE')).includes(key));
  assert.equal(await statementUrl('https://planner.example.com/', 'admin-secret', 'CAMILLE'), `https://planner.example.com/partners/statement/?code=CAMILLE&key=${key}`);
  const source = readFileSync(new URL('../server/partners.js', import.meta.url), 'utf8');
  assert.match(source, /'partner-statement-key'/, 'domain separation');
  assert.doesNotMatch(source, /console\.(?:log|warn)/, 'nothing logged');
});

test('a statement shows that code only: visits, purchases by kind, each team commission’s state — nothing about a buyer', () => {
  const rows = [
    plus('ch_plus', 40), plus('ch_gift', 35, { kind: 'gift', plan: 'gift-1', member: true }), plus('ch_family', 5, { kind: 'gift', plan: 'family-5', currency: 'USD', amount: 9900, tax: 0 }),
    plus('ch_refunded', 50), team('ch_big', ...BIG, 60), team('ch_mid', ...MID, 30), team('ch_soon', ...SMALL, 3),
    team('ch_paid', ...SMALL, 200), plus('ch_try', 2, { mode: 'test' }),
    team('ch_anna', ...BIG, 40, { code: 'ANNA' }), plus('ch_anna_plus', 9, { code: 'ANNA' })
  ];
  const statement = partnerStatement('CAMILLE', {
    rows,
    states: [{ checkoutId: 'ch_refunded', reason: 'refund' }],
    payouts: [payout('ch_paid', 1625, '2026-07-01T10:00:00Z', { note: 'SEPA 42 to IBAN FR76…' }), payout('ch_anna', 30000, iso(NOW), { code: 'ANNA' })],
    profiles: [{ code: 'ANNA', status: 'business', updatedAt: iso(NOW) }],
    visits: [{ day: '2026-12-20', count: 4 }, { day: '2026-11-25', count: 6 }, { day: '2026-10-01', count: 10 }, { day: '2026-01-02', count: 100 }, { day: '2025-12-31', count: 1000 }],
    now: NOW
  });
  assert.deepEqual(statement.visits, { last30: 10, last90: 20, year: 120, yearOf: 2026 });
  assert.deepEqual(statement.creem, [{ kind: 'plus', label: 'Plus', count: 2, refunded: 1 }, { kind: 'gift-1', label: 'Give Plus', count: 1, refunded: 0 }, { kind: 'family-5', label: 'Plus Family', count: 1, refunded: 0 }]);
  assert.deepEqual(statement.team.map(line => [line.soldOn, line.seats, line.commission, line.status, line.payable, line.held, line.paidOn]), [
    ['2026-12-17', 10, 1625, 'pending', 0, 0, ''],
    ['2026-11-20', 100, 8292, 'held', 0, 8292, ''],
    ['2026-10-21', 1000, 41625, 'earned', 28375, 13250, ''],
    ['2026-06-03', 10, 1625, 'paid', 0, 0, '2026-07-01']
  ]);
  assert.deepEqual([statement.partner, statement.cap.lines[0].paid, statement.totals.toPay, statement.totals.held, statement.totals.paid], ['individual', 1625, { EUR: 28375 }, { EUR: 21542 }, { EUR: 1625 }]);
  // Nothing about a buyer, a checkout, another partner, a payout note or what was paid for a purchase.
  const json = JSON.stringify(statement);
  for (const word of ['ch_', 'ANNA', 'SEPA', 'IBAN', 'member', '"amount"', '"tax"', 'country', 'email', '499500', '2900', 'checkout']) assert.ok(!json.includes(word), word);
  // A code with nothing yet: an empty statement, its status from the profile.
  const anna = partnerStatement('NEWBIE', { rows, profiles: [{ code: 'NEWBIE', status: 'business' }], visits: null, now: NOW });
  assert.deepEqual([anna.partner, anna.visits, anna.team, anna.cap, anna.creem.map(row => row.count)], ['business', null, [], null, [0, 0, 0]]);
  assert.equal(statementVisitsFrom(NOW), '2026-01-01', 'the whole year when longer than 90 days');
  assert.equal(statementVisitsFrom(Date.parse('2027-02-01T00:00:00Z')), '2026-11-04');
  assert.deepEqual(visitTotals([{ day: '2027-01-01', count: 2 }], Date.parse('2027-01-01T08:00:00Z')), { last30: 2, last90: 2, year: 2, yearOf: 2027 });
});

test('the statement page says each state in the partner’s words, with the cap and how to get paid', () => {
  assert.deepEqual(model.statementParams('?code=CAMILLE&key=0b94fa480f0521b4241995787508b602'), { code: 'CAMILLE', key: '0b94fa480f0521b4241995787508b602' });
  for (const search of ['', '?code=CAMILLE', '?code=CAMILLE&key=xyz', '?code=a&key=0b94fa480f0521b4241995787508b602', '?code=bad code&key=0b94fa480f0521b4241995787508b602']) assert.equal(model.statementParams(search), null, search);
  const line = fields => model.teamLineView({ soldOn: '2026-10-02', seats: 100, commission: 8292, exact: true, currency: 'EUR', earnedOn: '2026-10-16', paidOn: '', paidAmount: null, payable: 0, held: 0, ...fields });
  assert.deepEqual(line({ status: 'pending' }), { soldOn: '2 Oct 2026', what: 'Team gift · up to 100 people', amount: '€82.92', label: 'Pending', detail: 'Earned on 16 Oct 2026 if the gift isn’t refunded', tone: 'wait', off: false });
  assert.equal(line({ status: 'earned', payable: 8292 }).detail, 'We pay it by bank transfer within 30 days');
  assert.equal(model.teamLineView({ status: 'earned', commission: 8292, currency: 'EUR', payable: 8292 }, { partner: 'business' }).detail, 'Invoice us for it: we pay it against your invoice');
  assert.equal(line({ status: 'earned', commission: 41625, payable: 30000, held: 11625 }).detail, '€300.00 to be paid now · €116.25 waits above your yearly cap');
  assert.deepEqual([line({ status: 'held', held: 8292 }).label, line({ status: 'held', held: 8292 }).detail], ['Waiting', 'Above your yearly cap as an individual: paid once you invoice us as a business, or from 1 January']);
  assert.equal(line({ status: 'paid', paidOn: '2026-11-03', paidAmount: 8292 }).detail, 'Paid on 3 Nov 2026');
  assert.equal(line({ status: 'held', paidAmount: 30000, paidOn: '2026-11-03' }).detail.startsWith('€300.00 paid on 3 Nov 2026 · '), true);
  assert.deepEqual([line({ status: 'refunded' }).label, line({ status: 'refunded' }).off, line({ status: 'disputed' }).detail], ['Refunded', true, 'A disputed payment earns nothing']);
  assert.equal(line({ status: 'earned', exact: false, payable: 8292 }).amount, 'At most €82.92');
  const statement = { partner: 'individual', generatedAt: iso(NOW), program: PARTNER_PROGRAM, cap: { year: 2026, lines: [{ currency: 'EUR', limit: 30000, paid: 30000, left: 0, held: 19917 }] } };
  assert.deepEqual(model.capLines(statement, ['EUR', 'USD']).map(row => [row.currency, row.share, row.text, row.heldText]), [
    ['EUR', 100, '€300.00 of €300.00 paid in 2026', '€199.17 waits above the cap: invoice us as a business and we pay it against your invoice, or it is paid from 1 January 2027.'],
    ['USD', 0, '$0.00 of $300.00 paid in 2026', '']
  ]);
  assert.deepEqual(model.capLines({ ...statement, partner: 'business' }, ['EUR']), []);
  assert.equal(model.capWords(), '€300 / $300');
  assert.match(model.payWords(statement, { email: 'support@example.com' }), /send us the name on your bank account and its IBAN or account number once \(email support@example\.com, or use the question form\)\..*up to €300 \/ \$300 a calendar year\.$/);
  assert.match(model.payWords({ partner: 'business' }), /^You invoice us as a business, with no yearly cap\. Once a commission is earned, send us your invoice \(use the question form\)/);
  assert.deepEqual(model.creemRows({ creem: [{ label: 'Plus', count: 2, refunded: 1 }, { label: 'Give Plus', count: 0, refunded: 0 }] }), [{ label: 'Plus', count: 2, note: '1 refunded or disputed: it earns nothing' }]);
  const page = readFileSync(new URL('../partners/statement/index.html', import.meta.url), 'utf8');
  assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(page, /<meta name="referrer" content="no-referrer">/, 'the address carries the key');
  assert.match(page, /href="\.\.\/\.\.\/contact\/\?topic=partners"/);
  assert.match(page, /href="\.\.\/#rules"/);
  assert.match(page, /Paid by Creem, <span data-rate>25%<\/span> of each purchase: see your Creem dashboard for the amounts and your payouts\./);
  const script = readFileSync(new URL('../partners/statement/statement.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /localStorage|sessionStorage|trackEvent|console\./, 'the key is never stored, nothing is counted or logged');
});

// ---- The API (memory and D1) ------------------------------------------------------

const ALL = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql', '0005_refunds.sql', '0006_partners.sql', '0007_partner_commissions.sql', '0008_partner_profiles.sql'];
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }

function d1(migrations = ALL) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let params = [];
      const api = {
        bind(...values) { params = values; return api; },
        async run() { return { meta: { changes: Number(statement.run(...params).changes) } }; },
        async all() { return { results: statement.all(...params) }; }
      };
      return api;
    }
  };
}

async function bothStores(t, body) {
  await body('memory', createMemoryStore());
  if (!DatabaseSync) { t.diagnostic('node:sqlite is not available: D1 skipped'); return; }
  await body('D1', createD1Store(d1()));
}

const request = (method, path, body, token) => new Request(`https://planner.test/api/${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const asJson = async response => ({ status: response.status, body: response.status === 204 ? null : await response.json() });
const apiFor = (store, { at = NOW, adminToken = 'secret', limits } = {}) => createPlannerApi({ store, adminToken, now: () => new Date(at), authFailureDelayMs: 0, partnerLimits: limits || createPartnerLimits({ limits: { statement: { limit: 1000, windowMs: 60000 }, visit: { limit: 100000, windowMs: 60000 } } }) });

test('the owner records a partner’s status (owner only), and a business is paid without a cap (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    await store.addPartnerSale(team('ch_big', ...BIG, 60));
    const api = apiFor(store);
    const profile = (body, token = 'secret') => api(request('POST', 'admin/partners/profiles', body, token));
    assert.equal((await profile({ code: 'CAMILLE', status: 'business' }, '')).status, 401, label);
    assert.equal((await profile({ code: 'CAMILLE', status: 'business' }, 'wrong')).status, 401, label);
    assert.equal((await api(request('GET', 'admin/partners/profiles', undefined, 'secret'))).status, 405, label);
    assert.equal((await profile({ code: 'not a code!', status: 'business' })).status, 400, label);
    assert.equal((await profile({ code: 'CAMILLE', status: 'company' })).status, 400, label);
    assert.equal((await profile({ code: 'CAMILLE', status: 'business', iban: 'FR76 0000', name: 'Camille' })).status, 200, label);
    const rows = await store.listPartnerProfiles();
    assert.deepEqual(rows, [{ code: 'CAMILLE', status: 'business', updatedAt: iso(NOW) }], `${label}: the code and the status, nothing else`);
    const summary = (await asJson(await api(request('GET', 'admin/summary', undefined, 'secret')))).body;
    assert.deepEqual([summary.partnerProfilesUnavailable, summary.partners.codes[0].partner, summary.partners.toPay[0].payable], [false, 'business', 41625], label);
    assert.deepEqual(summary.partnerProgram.individualYearlyCap, { EUR: 300, USD: 300 }, label);
    const paid = await asJson(await api(request('POST', 'admin/partners/payouts', { checkout: 'ch_big', confirmed: true }, 'secret')));
    assert.deepEqual([paid.status, paid.body.payout.checkoutId, paid.body.payout.amount, paid.body.final], [201, 'ch_big', 41625, true], label);
    // Back to an individual: the cap counts what was paid this year, so nothing more fits.
    assert.equal((await profile({ code: 'CAMILLE', status: 'individual' })).status, 200, label);
    assert.deepEqual((await store.listPartnerProfiles({ code: 'CAMILLE' })).map(row => row.status), ['individual'], label);
    const after = (await asJson(await api(request('GET', 'admin/summary', undefined, 'secret')))).body.partners;
    assert.deepEqual(after.codes[0].cap.lines[0], { currency: 'EUR', limit: 30000, paid: 41625, left: 0, held: 0 }, label);
  });
});

test('an individual is paid up to the cap, the rest in parts; Undo takes back the latest payment (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    await store.addPartnerSale(team('ch_big', ...BIG, 60));
    await store.addPartnerSale(plus('ch_plus', 40));
    const api = apiFor(store);
    const pay = async body => asJson(await api(request('POST', 'admin/partners/payouts', { checkout: 'ch_big', ...body }, 'secret')));
    const refused = await pay({});
    assert.deepEqual([refused.status, refused.body.cap], [409, true], label);
    assert.match(refused.body.error, /Mark 300\.00 EUR as paid now/, label);
    const part = await pay({ amount: 30000, note: 'SEPA 1' });
    assert.deepEqual([part.status, part.body.payout.checkoutId, part.body.final, part.body.left], [201, 'ch_big.1', false, 11625], label);
    const held = await pay({ amount: 11625 });
    assert.deepEqual([held.status, held.body.cap], [409, true], `${label}: the rest waits above the cap`);
    // Undo: the part paid goes; once more: nothing left to undo.
    const undo = () => api(request('DELETE', 'admin/partners/payouts/ch_big', undefined, 'secret'));
    assert.equal((await undo()).status, 200, label);
    assert.deepEqual(await store.listPartnerPayouts(), [], label);
    assert.equal((await undo()).status, 404, label);
    // Paid again, then in the new year the rest settles it under the checkout itself.
    assert.equal((await pay({ amount: 30000 })).status, 201, label);
    const january = apiFor(store, { at: NEW_YEAR });
    const rest = await asJson(await january(request('POST', 'admin/partners/payouts', { checkout: 'ch_big' }, 'secret')));
    assert.deepEqual([rest.status, rest.body.payout.checkoutId, rest.body.payout.amount, rest.body.final], [201, 'ch_big', 11625, true], label);
    const settled = (await asJson(await january(request('GET', 'admin/summary', undefined, 'secret')))).body.partners;
    assert.deepEqual([settled.team[0].status, settled.team[0].paidAmount, settled.team[0].parts], ['paid', 41625, 2], label);
    // Undo takes back the payment that settled it first.
    assert.equal((await january(request('DELETE', 'admin/partners/payouts/ch_big', undefined, 'secret'))).status, 200, label);
    assert.deepEqual((await store.listPartnerPayouts()).map(row => row.checkoutId), ['ch_big.1'], label);
  });
});

test('the statement route: the signed link answers that code’s statement; any other key is 404, the same as no code (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    await store.addPartnerSale(team('ch_big', ...BIG, 60));
    await store.addPartnerSale(plus('ch_anna', 10, { code: 'ANNA' }));
    const api = apiFor(store);
    const link = await asJson(await api(request('POST', 'admin/partners/links', { code: 'CAMILLE' }, 'secret')));
    assert.equal(link.status, 200, label);
    assert.equal((await api(request('POST', 'admin/partners/links', { code: 'CAMILLE' }, ''))).status, 401, `${label}: owner only`);
    assert.equal((await api(request('POST', 'admin/partners/links', { code: '' }, 'secret'))).status, 400, label);
    const url = new URL(link.body.url);
    assert.equal(url.pathname, '/partners/statement/', label);
    const key = url.searchParams.get('key');
    const statement = async path => asJson(await api(request('GET', path)));
    const ok = await statement(`partners/statement?code=CAMILLE&key=${key}`);
    assert.deepEqual([ok.status, ok.body.statement.code, ok.body.statement.team.length, ok.body.statement.visits], [200, 'CAMILLE', 1, { last30: 0, last90: 0, year: 0, yearOf: 2026 }], label);
    assert.ok(!JSON.stringify(ok.body).includes('ANNA') && !JSON.stringify(ok.body).includes('ch_'), `${label}: that code only, no checkout`);
    const wrong = await statement(`partners/statement?code=ANNA&key=${key}`);
    const nobody = await statement(`partners/statement?code=NOBODY&key=${key}`);
    const malformed = await statement('partners/statement?code=CAMILLE&key=nope');
    assert.deepEqual([wrong.status, nobody.status, malformed.status], [404, 404, 404], label);
    assert.deepEqual(wrong.body, nobody.body, `${label}: never says whether a code exists`);
    assert.equal((await api(request('POST', `partners/statement?code=CAMILLE&key=${key}`, {}))).status, 405, label);
    // A rotated ADMIN_TOKEN: every link given out stops working.
    assert.equal((await asJson(await apiFor(store, { adminToken: 'rotated' })(request('GET', `partners/statement?code=CAMILLE&key=${key}`)))).status, 404, label);
    assert.equal((await asJson(await apiFor(store, { adminToken: '' })(request('GET', `partners/statement?code=CAMILLE&key=${key}`)))).status, 404, label);
    // Rate-limited per worker isolate.
    const limited = apiFor(store, { limits: createPartnerLimits({ limits: { statement: { limit: 2, windowMs: 60000 }, visit: { limit: 2, windowMs: 60000 } } }) });
    const codes = [];
    for (let index = 0; index < 3; index += 1) codes.push((await limited(request('GET', `partners/statement?code=CAMILLE&key=${key}`))).status);
    assert.deepEqual(codes, [200, 200, 429], label);
  });
});

test('visits through partner links: one per call, per code and UTC day; malformed codes ignored; new codes bounded per day (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    await store.addPartnerSale(plus('ch_known', 10, { code: 'KNOWN' }));
    const api = apiFor(store);
    const visit = ref => api(request('POST', 'partners/visit', { ref }));
    for (const ref of ['CAMILLE', 'CAMILLE', ' CAMILLE ', 'x', 'not a code!', 42, null]) assert.equal((await visit(ref)).status, 204, `${label}: ${ref}`);
    assert.deepEqual(await store.listPartnerVisits({ code: 'CAMILLE', fromDay: '2026-01-01' }), [{ day: '2026-12-20', count: 3 }], label);
    assert.deepEqual(await store.partnerVisitTotals({ fromDay: '2026-12-01' }), [{ code: 'CAMILLE', count: 3 }], `${label}: nothing for malformed codes`);
    assert.equal((await api(request('GET', 'partners/visit'))).status, 405, label);
    // Made-up codes fill a day up to the bound; then only codes already counted, with a sale or a status count.
    for (let index = 1; index < PARTNER_VISIT_CODES_PER_DAY; index += 1) await visit(`SPAM${index}`);
    await visit('ONEMORE');
    await visit('KNOWN');
    await visit('CAMILLE');
    await store.setPartnerProfile({ code: 'PROFILED', status: 'individual', updatedAt: iso(NOW) });
    await visit('PROFILED');
    const totals = new Map((await store.partnerVisitTotals({ fromDay: '2026-12-20' })).map(row => [row.code, row.count]));
    assert.equal(totals.has('ONEMORE'), false, `${label}: past the bound`);
    assert.deepEqual([totals.get('KNOWN'), totals.get('CAMILLE'), totals.get('PROFILED'), totals.size], [1, 4, 1, PARTNER_VISIT_CODES_PER_DAY + 2], label);
    // The admin summary: visits per code over 30 days, and codes with visits and no sale.
    const summary = (await asJson(await api(request('GET', 'admin/summary', undefined, 'secret')))).body.partners;
    assert.equal(summary.codes.find(row => row.code === 'KNOWN').visits, 1, label);
    assert.deepEqual(summary.visitsOnly.slice(0, 2), [{ code: 'CAMILLE', count: 4 }, { code: 'PROFILED', count: 1 }], label);
    // The next day starts again.
    assert.equal((await apiFor(store, { at: NOW + DAY })(request('POST', 'partners/visit', { ref: 'ONEMORE' }))).status, 204, label);
    assert.deepEqual(await store.listPartnerVisits({ code: 'ONEMORE', fromDay: '2026-12-01' }), [{ day: '2026-12-21', count: 1 }], label);
  });
});

test('before migration 0008: everyone is an individual, the status switch is refused, visits are not counted, statements still open', { skip: DatabaseSync ? false : 'node:sqlite is not available' }, async () => {
  const store = createD1Store(d1(ALL.filter(file => file !== '0008_partner_profiles.sql')));
  await store.addPartnerSale(team('ch_big', ...BIG, 60));
  const api = apiFor(store);
  const summary = (await asJson(await api(request('GET', 'admin/summary', undefined, 'secret')))).body;
  assert.deepEqual([summary.partnerProfilesUnavailable, summary.partners.codes[0].partner, summary.partners.toPay[0].payable, summary.partners.codes[0].visits], [true, 'individual', 30000, 0]);
  const switched = await asJson(await api(request('POST', 'admin/partners/profiles', { code: 'CAMILLE', status: 'business' }, 'secret')));
  assert.equal(switched.status, 503);
  assert.match(switched.body.error, /^Run migrations\/0008_partner_profiles\.sql/);
  assert.equal((await api(request('POST', 'partners/visit', { ref: 'CAMILLE' }))).status, 204, 'quietly not counted');
  const key = await statementKey('secret', 'CAMILLE');
  const statement = await asJson(await api(request('GET', `partners/statement?code=CAMILLE&key=${key}`)));
  assert.deepEqual([statement.status, statement.body.statement.visits, statement.body.statement.partner, statement.body.statement.team[0].payable], [200, null, 'individual', 30000]);
  // The card: one setup line, no switch; Setup and the attention list name the file.
  const html = view.partnersCardHtml(summary);
  assert.match(html, /<p class="owner-partner-setup" role="note">Run <code>migrations\/0008_partner_profiles\.sql<\/code> on the D1 database to mark a partner as a business and to count the visits their link brings\. Until then every partner counts as an individual, with team commissions capped at €300 \/ \$300 a calendar year\.<\/p>/);
  assert.doesNotMatch(html, /data-owner-partner-status/);
  assert.match(html, /data-owner-statement-link="CAMILLE"/, 'the private link works without it');
  assert.ok(buildAttention(summary, { now: NOW }).some(item => item.text === 'Database: run migrations/0008_partner_profiles.sql to mark partners as businesses and count their visits'));
});

test('migration 0008 runs twice without harm, as the D1 console runs it, and keeps its rows', { skip: DatabaseSync ? false : 'node:sqlite is not available' }, () => {
  const sql = readFileSync(new URL('../migrations/0008_partner_profiles.sql', import.meta.url), 'utf8');
  assert.ok(!sql.includes('--'), 'block comments only');
  assert.doesNotMatch(sql.replace(/\/\*[\s\S]*?\*\//g, ''), /iban|bank|name/i, 'never a bank detail or a name');
  const db = new DatabaseSync(':memory:');
  db.exec(sql.replace(/\n/g, ' '));
  db.prepare('INSERT INTO partner_profiles (code, status, updated_at) VALUES (?, ?, ?)').run('CAMILLE', 'business', iso(NOW));
  db.prepare('INSERT INTO partner_visits (code, day, count) VALUES (?, ?, ?)').run('CAMILLE', '2026-12-20', 3);
  db.exec(sql.replace(/\n/g, ' '));
  db.exec(sql);
  assert.deepEqual(db.prepare('SELECT code, status FROM partner_profiles').all().map(row => ({ ...row })), [{ code: 'CAMILLE', status: 'business' }]);
  assert.deepEqual(db.prepare('SELECT count FROM partner_visits').all().map(row => row.count), [3]);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'partner_visits_day'").all().length, 1);
  assert.throws(() => db.prepare('INSERT INTO partner_visits (code, day, count) VALUES (?, ?, ?)').run('CAMILLE', '2026-12-20', 1), /UNIQUE|PRIMARY KEY/, 'one row per code and day');
});

// ---- The dashboard ---------------------------------------------------------------

test('the Partners card: status switch, the cap paid this year, what is held above it, and Mark as paid for what fits', () => {
  const rows = [team('ch_big', ...BIG, 60), team('ch_mid', ...MID, 30), team('ch_anna', ...MID, 30, { code: 'ANNA' })];
  const partnersSummary = partnerSummary(rows, [], [], { now: NOW, payouts: [payout('ch_old.1', 5000, iso(NOW - 40 * DAY))], profiles: [{ code: 'ANNA', status: 'business' }] });
  partnersSummary.codes.forEach(row => { row.visits = row.code === 'CAMILLE' ? 12 : 0; });
  partnersSummary.visitDays = 30;
  const money = (cents, currency) => `${(cents / 100).toFixed(2)} ${currency}`;
  const fmt = { money, exact: money, number: String, day: value => String(value).slice(0, 10) };
  const summary = { partners: partnersSummary, partnerProgram: { ...PARTNER_PROGRAM } };
  const html = view.partnersCardHtml(summary, fmt);
  const words = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(html, /<span class="owner-partner-status" role="group" aria-label="CAMILLE’s status"><button type="button" aria-pressed="true" data-owner-partner-status="individual" data-owner-partner-code="CAMILLE" class="is-active">Individual<\/button><button type="button" aria-pressed="false" data-owner-partner-status="business" data-owner-partner-code="CAMILLE">Business<\/button><\/span>/);
  assert.match(html, /aria-pressed="true" data-owner-partner-status="business" data-owner-partner-code="ANNA"/);
  assert.match(words, /Paid in 2026: 50\.00 EUR of 300\.00 EUR/);
  assert.match(words, /Above the yearly cap for an individual: 249\.17 EUR — payable once they invoice as a business/);
  assert.match(words, /Business · against their invoice, no yearly cap/);
  assert.match(html, /<th class="num">Visits · 30 days<\/th>/);
  assert.match(html, /data-owner-statement-link="CAMILLE" aria-label="Copy CAMILLE’s private statement link">Copy private link<\/button>/);
  assert.match(html, /<form class="owner-partner-linkform" data-owner-statement-form novalidate>/);
  // The big one: what fits under the cap now; the next one held; ANNA (a business) in full.
  const row = id => new RegExp(`<tr data-owner-attn="partner:${id}"[\\s\\S]*?</tr>`).exec(html)[0];
  assert.match(row('ch_big'), /data-owner-payout-amount="250\.00 EUR" data-owner-payout-cents="25000" data-owner-payout-currency="EUR" data-owner-payout-exact="1" data-owner-payout-checks="" data-owner-payout-rest="41625" data-owner-payout-partner="individual">Mark as paid/);
  assert.match(row('ch_big'), /250\.00 EUR now · 166\.25 EUR above the yearly cap/);
  assert.match(row('ch_mid'), /owner-pill--wait">Held</);
  assert.doesNotMatch(row('ch_mid'), /data-owner-payout=/, 'nothing to pay now');
  assert.match(row('ch_anna'), /Against their invoice|data-owner-payout-partner="business"/);
  assert.match(words, /by bank transfer · 249\.17 EUR above the yearly cap/, 'the figure to pay says what waits');
  // The attention list: pay what fits; one quiet line for what waits.
  const items = buildAttention(summary, { now: NOW, money });
  assert.deepEqual(items.filter(item => item.kind === 'partner-pay').map(item => item.text), ['Pay CAMILLE 250.00 EUR (10% of a team gift)', 'Pay ANNA 82.92 EUR (10% of a team gift)'], 'the longest-waiting first');
  assert.match(items.find(item => item.text.startsWith('Pay CAMILLE')).detail, /166\.25 EUR more waits above the yearly cap for an individual · by bank transfer, then Mark as paid$/);
  assert.match(items.find(item => item.text.startsWith('Pay ANNA')).detail, /against their invoice, then Mark as paid$/);
  const held = items.find(item => item.kind === 'partner-held');
  assert.deepEqual([held.text, held.tone, held.rows], ['CAMILLE: 249.17 EUR above the yearly cap for an individual', 'info', ['partner:ch_mid', 'partner:ch_big']]);
  assert.match(held.detail, /^Paid in 2026: 50\.00 EUR of 300\.00 EUR · payable once CAMILLE invoices you as a business/);
});

test('the dashboard wires the status switch, the private link and capped payments through the API', () => {
  const admin = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(admin, /sendJson\('admin\/partners\/profiles', 'POST', \{ code, status \}\)/);
  assert.match(admin, /sendJson\('admin\/partners\/links', 'POST', \{ code \}\)/);
  assert.match(admin, /\.\.\.\(part \? \{ part: true \} : \{\}\)/);
  assert.match(admin, /summary\.partnerProfilesUnavailable && '0008_partner_profiles\.sql'/);
  assert.doesNotMatch(admin, /console\.log\([^)]*url/, 'the link is never logged');
});

// ---- The visit count on the visitor's browser -----------------------------------------

test('a partner link counts one visit per code and local day on this browser, never with the counts off', () => {
  stored.clear();
  sent.length = 0;
  const day = Date.parse('2026-12-20T10:00:00');
  const visits = () => sent.filter(entry => entry.url === '/api/partners/visit').map(entry => entry.body.ref);
  assert.equal(client.rememberReferral('?ref=CAMILLE', { storage, now: day }), 'CAMILLE');
  client.rememberReferral('?ref=CAMILLE', { storage, now: day + 3600000 });
  assert.deepEqual(visits(), ['CAMILLE'], 'once a day');
  assert.deepEqual(JSON.parse(stored.get(client.REFERRAL_KEY)), { code: 'CAMILLE', at: day + 3600000, counted: { day: '2026-12-20', codes: ['CAMILLE'] } }, 'the same key as the code: no new storage');
  client.rememberReferral('?ref=ANNA', { storage, now: day + 7200000 });
  client.rememberReferral('?ref=CAMILLE', { storage, now: day + 9000000 });
  assert.deepEqual(visits(), ['CAMILLE', 'ANNA'], 'another code counts; back to the first: already counted today');
  assert.equal(client.referralCode({ storage, now: day + 9000000 }), 'CAMILLE', 'the latest link still wins for a purchase');
  client.rememberReferral('?ref=CAMILLE', { storage, now: day + DAY });
  assert.deepEqual(visits(), ['CAMILLE', 'ANNA', 'CAMILLE'], 'the next day');
  assert.deepEqual(JSON.parse(stored.get(client.REFERRAL_KEY)).counted, { day: '2026-12-21', codes: ['CAMILLE'] }, 'only today’s codes are kept');
  client.rememberReferral('?ref=x', { storage, now: day + 2 * DAY });
  client.rememberReferral('?nothing=1', { storage, now: day + 2 * DAY });
  assert.equal(visits().length, 3, 'malformed codes: nothing');
  // Counts switched off: the code is kept for a purchase, no visit is sent.
  client.setUsageCountsEnabled(false, storage);
  assert.equal(client.rememberReferral('?ref=COACH', { storage, now: day + 3 * DAY }), 'COACH');
  assert.equal(client.referralCode({ storage, now: day + 3 * DAY }), 'COACH');
  assert.equal(visits().length, 3);
  assert.deepEqual(JSON.parse(stored.get(client.REFERRAL_KEY)), { code: 'COACH', at: day + 3 * DAY });
  client.setUsageCountsEnabled(true, storage);
  // Only the code goes: no version, no page, nothing else.
  assert.deepEqual(sent.find(entry => entry.url === '/api/partners/visit').body, { ref: 'CAMILLE' });
  const cookies = readFileSync(new URL('../legal/cookies/index.html', import.meta.url), 'utf8');
  assert.match(cookies, /the day a visit through it was last counted, so a visit is counted at most once a day/);
  const privacy = readFileSync(new URL('../legal/privacy/index.html', import.meta.url), 'utf8').replace(/<[^>]+>/g, '');
  assert.match(privacy, /at most once a day for each code: it sends only the code, and we add one to that code’s count for the day\. We keep these daily totals per partner code, with nothing about you/);
  assert.match(privacy, /Nothing is sent when you have switched the anonymous counts off\./);
});

test('the terms and the partners page say the yearly cap, from PARTNER_PROGRAM', () => {
  const terms = readFileSync(new URL('../legal/terms/index.html', import.meta.url), 'utf8');
  const section = /<section id="partners"[\s\S]*?<\/section>/.exec(terms)[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  const { EUR, USD } = PARTNER_PROGRAM.individualYearlyCap;
  assert.ok(section.includes(`As an individual, up to €${EUR} or $${USD} a year.`));
  assert.ok(section.includes(`capped at €${EUR} per calendar year, or $${USD} for commissions in US dollars, counted by the date we pay them`));
  assert.match(section, /invoice us as a business — a micro-entreprise or a company, in any country — and we pay each commission against your invoice, with no cap/);
  assert.match(section, /They are Creem’s, under its affiliate terms: the yearly cap below doesn’t apply to them\./);
  assert.match(section, /we pay it once you invoice us as a business, or from 1 January, within the new year’s cap/);
  assert.match(section, /a private link to their statement/);
  const page = readFileSync(new URL('../partners/index.html', import.meta.url), 'utf8');
  assert.match(page, /As an individual, up to <span data-individual-cap>€300<\/span> a calendar year; above that, invoice us as a business — a micro-entreprise or a company, in any country — with no cap\./);
  assert.match(page, /<summary>Do I need a business to be paid\?<\/summary>/);
  assert.match(page, /We also send you a private link to your statement/);
  assert.match(readFileSync(new URL('../partners/partners.js', import.meta.url), 'utf8'), /setText\('\[data-individual-cap\]', figures\.individualCap\);/);
});
