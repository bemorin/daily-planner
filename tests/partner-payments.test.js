import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 1.33: paying team commissions — a commission settled once its payments
// cover it (a partial refund after a part was paid), the payment date and its
// cap year (Europe/Paris), Mark as paid's dialog, the exact payment an Undo
// takes back, codes that differ only by case, and the statement's figures.

const { createMemoryStore, createPlannerApi } = await import('../server/planner-api.js');
const { createD1Store } = await import('../server/d1-store.js');
const partners = await import('../server/partners.js');
const { moneyText } = await import('../server/refunds.js');
const { PARTNER_PROGRAM } = await import('../src/lib/pricing.js');
const view = await import('../admin/partners-view.js');
const dialog = await import('../admin/payout-dialog.js');
const { buildAttention } = await import('../admin/attention.js');
const model = await import('../partners/statement-model.js');

const { partnerSummary, partnerStatement, createPartnerLimits } = partners;
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const NOW = Date.parse('2026-12-20T10:00:00Z');
const team = (checkoutId, plan, amount, tax, daysAgo, fields = {}, at = NOW) => ({ checkoutId, code: 'CAMILLE', kind: 'gift', plan, payer: 'owner', amount, tax, currency: 'EUR', member: false, mode: 'prod', createdAt: iso(at - daysAgo * DAY), ...fields });
const BIG = ['up-to-1000', 499500, 83250];
const MID = ['up-to-100', 99500, 16583];
const payout = (checkoutId, amount, paidAt, fields = {}) => ({ checkoutId, code: 'CAMILLE', amount, currency: 'EUR', note: '', paidAt, ...fields });
const money = (cents, currency) => moneyText(cents, currency);
const fmt = { money, exact: money, number: String, day: value => String(value).slice(0, 10) };

const ALL = ['0001_planner_api.sql', '0002_team_requests.sql', '0003_plus.sql', '0004_creem_reviews.sql', '0005_refunds.sql', '0006_partners.sql', '0007_partner_commissions.sql', '0008_partner_profiles.sql'];
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
function d1(migrations = ALL) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let params = [];
      const api = { bind(...values) { params = values; return api; }, async run() { return { meta: { changes: Number(statement.run(...params).changes) } }; }, async all() { return { results: statement.all(...params) }; } };
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
const apiFor = (store, at = NOW) => createPlannerApi({ store, adminToken: 'secret', now: () => new Date(at), authFailureDelayMs: 0, partnerLimits: createPartnerLimits({ limits: { statement: { limit: 1000, windowMs: 60000 }, visit: { limit: 1000, windowMs: 60000 } } }) });

// ---- Money in words ---------------------------------------------------------------

test('amounts read as people write them, to the cent: €300.00, $5.00', () => {
  assert.deepEqual([moneyText(30000, 'EUR'), moneyText(500, 'USD'), moneyText(2900, ''), moneyText(null, 'EUR')], ['€300.00', '$5.00', '29.00', '']);
  assert.match(partners.capRefusalText({ code: 'CAMILLE', currency: 'EUR', payable: 0, rest: 8292, cap: { year: 2026, limit: 30000, paid: 30000 } }), /€300\.00 of team commissions in 2026, €300\.00 paid so far/);
});

// ---- Paid in part, then partly refunded ------------------------------------------------

test('parts paid that cover what a partial refund left: settled (paid), with what was paid past it; the statement says Paid', () => {
  const rows = [team('ch_big', ...BIG, 60)];
  const payouts = [payout('ch_big.1', 30000, iso(NOW - 20 * DAY))];
  // €4,000 of the €4,995 refunded: the commission falls to €82.92, below the €300 paid.
  const refunds = [{ checkoutId: 'ch_big', amount: 400000, currency: 'EUR', fullRefund: false }];
  for (const profiles of [[], [{ code: 'CAMILLE', status: 'business' }]]) {
    const summary = partnerSummary(rows, [], refunds, { now: NOW, payouts, profiles });
    const sale = summary.team[0];
    assert.deepEqual([sale.status, sale.commission, sale.paidAmount, sale.rest, sale.payable, sale.overpaid, sale.paidAt], ['paid', 8292, 30000, 0, 0, 21708, iso(NOW - 20 * DAY)]);
    assert.deepEqual([summary.toPay, summary.totals.team.toPay, summary.totals.team.paid], [[], {}, { EUR: 30000 }]);
    const state = view.commissionState(sale, { money, day: value => value.slice(0, 10) });
    assert.equal(state.label, 'Paid');
    assert.match(state.detail, /Paid €217\.08 more than earned/);
    const html = view.partnersCardHtml({ partners: summary, partnerProgram: PARTNER_PROGRAM }, fmt);
    assert.doesNotMatch(html, /data-owner-payout="ch_big"/, 'no Mark as paid: nothing is left to pay');
    assert.match(html, /data-owner-payout-undo="ch_big"/, 'it can still be undone');
    const line = partnerStatement('CAMILLE', { rows, refunds, payouts, profiles, now: NOW }).team[0];
    assert.deepEqual([line.status, line.paidAmount], ['paid', 30000]);
    assert.equal(model.teamLineView(line).label, 'Paid');
  }
  // Paid exactly what is left: settled, nothing paid past it.
  const exact = partnerSummary(rows, [], refunds, { now: NOW, payouts: [payout('ch_big.1', 8292, iso(NOW - DAY))] }).team[0];
  assert.deepEqual([exact.status, exact.overpaid], ['paid', 0]);
  // Less than what is left: still open, the rest to pay.
  const open = partnerSummary(rows, [], refunds, { now: NOW, payouts: [payout('ch_big.1', 5000, iso(NOW - DAY))] }).team[0];
  assert.deepEqual([open.status, open.rest, open.overpaid], ['earned', 3292, 0]);
});

// ---- Mark as paid: the dialog -----------------------------------------------------------

const button = fields => ({ ownerPayout: 'ch_big', ownerPayoutCode: 'CAMILLE', ownerPayoutAmount: '€300.00', ownerPayoutCents: '30000', ownerPayoutCurrency: 'EUR', ownerPayoutExact: '1', ownerPayoutChecks: '', ownerPayoutRest: '41625', ownerPayoutPartner: 'individual', ownerPayoutEarned: '2026-11-04', ...fields });

test('Mark as paid: when the cap cuts the amount, a part is recorded and the rest stays open — no question to get wrong', () => {
  const today = '2026-12-20';
  const exact = dialog.payoutDetails(button(), { today });
  assert.deepEqual([exact.capped, exact.exact, exact.earned], [true, true, '2026-11-04']);
  const html = dialog.payoutFormHtml(exact, { money, rate: 10 });
  assert.match(html, /Only €300\.00 fits under CAMILLE’s yearly cap for an individual\. The rest \(€116\.25\) stays open: it waits until CAMILLE invoices you as a business, or until 1 January\./);
  assert.match(html, /<input name="paidOn" type="date" value="2026-12-20" min="2026-11-04" max="2026-12-20" required>/, 'today by default, never later, never before it was earned');
  assert.doesNotMatch(html, /name="more"|confirm/, 'no “whole commission?” question');
  assert.deepEqual(dialog.payoutRequest(exact, { paidOn: today, note: ' SEPA 1 ' }, { money }), { body: { checkout: 'ch_big', note: 'SEPA 1', paidOn: today, amount: 30000 }, done: 'Marked as paid: CAMILLE, €300.00, on 20 Dec 2026. The rest stays open: it waits above the yearly cap.' });
  // An upper bound the cap cuts: typed at the cap's figure, a part; no question either.
  const bound = dialog.payoutDetails(button({ ownerPayoutExact: '0', ownerPayoutRest: '49950' }), { today });
  const form = dialog.payoutFormHtml(bound, { money, rate: 10 });
  assert.match(form, /<fieldset class="owner-pay__more" data-owner-pay-more hidden><legend>Is that all of this commission\?<\/legend>/, 'hidden until it applies');
  assert.match(form, /<input type="radio" name="more" value="open" checked> No, more may be owed: keep the rest open/, 'the safe answer is the one already chosen');
  assert.equal(dialog.asksIfWhole(bound, 30000), false);
  assert.deepEqual(dialog.payoutRequest(bound, { amount: '300', paidOn: today, more: 'settle' }, { money }).body, { checkout: 'ch_big', note: '', paidOn: today, amount: 30000, part: true }, 'the cap cut it: a part, whatever the radio said');
  // Below what the cap allows: the question, and the safe answer keeps the rest open.
  assert.equal(dialog.asksIfWhole(bound, 25000), true);
  assert.equal(dialog.payoutRequest(bound, { amount: '250', paidOn: today }, { money }).body.part, true);
  assert.equal(dialog.payoutRequest(bound, { amount: '250', paidOn: today, more: 'settle' }, { money }).body.part, false, 'only “it was all of it” settles it');
  // Not capped: an upper bound settles with what was paid; an exact one sends no amount.
  const business = dialog.payoutDetails(button({ ownerPayoutExact: '0', ownerPayoutCents: '49950', ownerPayoutRest: '49950', ownerPayoutAmount: '€499.50', ownerPayoutPartner: 'business' }), { today });
  assert.equal(dialog.asksIfWhole(business, 25000), false);
  assert.deepEqual(dialog.payoutRequest(business, { amount: '416,25', paidOn: '2026-12-01' }, { money }).body, { checkout: 'ch_big', note: '', paidOn: '2026-12-01', amount: 41625 });
  assert.deepEqual(dialog.payoutRequest(dialog.payoutDetails(button({ ownerPayoutCents: '1625', ownerPayoutRest: '1625', ownerPayoutAmount: '€16.25' }), { today }), { paidOn: today }, { money }).body, { checkout: 'ch_big', note: '', paidOn: today });
  // What it refuses, and which field to fix.
  assert.deepEqual(dialog.payoutRequest(bound, { amount: '301', paidOn: today }, { money }).field, 'amount');
  assert.deepEqual(dialog.payoutRequest(bound, { amount: 'abc', paidOn: today }, { money }).error, 'Write the amount like 595 or 595.50.');
  assert.deepEqual(dialog.payoutRequest(exact, { paidOn: '2026-12-21' }, { money }), { error: 'The day paid can’t be in the future.', field: 'paidOn' });
  assert.deepEqual(dialog.payoutRequest(exact, { paidOn: '2026-11-03' }, { money }), { error: 'This commission was earned on 4 Nov 2026: the day paid can’t be before it.', field: 'paidOn' });
  assert.deepEqual(dialog.payoutRequest(exact, { paidOn: '' }, { money }).field, 'paidOn');
  const checked = dialog.payoutDetails(button({ ownerPayoutChecks: 'code tax' }), { today });
  assert.match(dialog.payoutFormHtml(checked, { money, rate: 10 }), /<legend>Before paying<\/legend><ul><li>Check that CAMILLE is a partner in Creem → Affiliate Hub before paying\.<\/li><li>Tax not recorded: check it in Creem, and pay 10% of the price before tax\.<\/li><\/ul><label class="owner-pay__tick"><input type="checkbox" name="verified" required> I checked them<\/label>/);
  assert.equal(dialog.payoutRequest(checked, { paidOn: today }, { money }).field, 'verified');
  assert.equal(dialog.payoutRequest(checked, { paidOn: today, checked: true }, { money }).body.confirmed, true);
  // Every value is escaped.
  assert.doesNotMatch(dialog.payoutFormHtml(dialog.payoutDetails(button({ ownerPayoutCode: '<b>x</b>' }), { today }), { money }), /<b>x<\/b>/);
});

test('the dialog is a native <dialog> with the page’s light and dark, and the dashboard loads it', () => {
  const source = readFileSync(new URL('../admin/payout-dialog.js', import.meta.url), 'utf8');
  assert.match(source, /document\.createElement\('dialog'\)/);
  assert.match(source, /dialog\.showModal\(\);/);
  const css = readFileSync(new URL('../admin/admin.css', import.meta.url), 'utf8');
  assert.match(css, /\.owner-dialog \{[^}]*background: var\(--surface-strong\); color: var\(--ink\);/);
  assert.match(css, /\.owner-dialog::backdrop \{ background: var\(--modal-scrim, rgba\(32, 29, 25, \.3\)\); \}/);
  assert.doesNotMatch(css.slice(css.indexOf('.owner-dialog')), /!important|transition|animation/);
  const admin = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.doesNotMatch(admin, /window\.prompt/, 'no more prompts for a payment');
  assert.doesNotMatch(admin, /Was \$\{shown\} the whole commission\?/);
});

// ---- The payment date and its cap year ----------------------------------------------------

test('the payment date: today in Paris by default, a chosen day otherwise; never in the future or before it was earned; the cap year is that day’s (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    // Earned on 6 December 2026; on 2 January 2027 (Paris) the owner records what they paid on 31 December.
    const at = Date.parse('2027-01-02T09:00:00Z');
    await store.addPartnerSale(team('ch_big', ...BIG, 0, {}, Date.parse('2026-11-22T10:00:00Z')));
    await store.addPartnerSale(team('ch_mid', ...MID, 0, {}, Date.parse('2026-11-23T10:00:00Z')));
    const api = apiFor(store, at);
    const pay = async body => asJson(await api(request('POST', 'admin/partners/payouts', { confirmed: true, ...body }, 'secret')));
    assert.match((await pay({ checkout: 'ch_big', amount: 30000, paidOn: '2027-01-03' })).body.error, /can’t be in the future/, label);
    assert.match((await pay({ checkout: 'ch_big', amount: 30000, paidOn: '2026-12-05' })).body.error, /earned on 2026-12-06: the day paid can’t be before it/, label);
    assert.equal((await pay({ checkout: 'ch_big', amount: 30000, paidOn: '31/12/2026' })).status, 400, label);
    const dated = await pay({ checkout: 'ch_big', amount: 30000, paidOn: '2026-12-31', note: 'SEPA 31 Dec' });
    assert.deepEqual([dated.status, dated.body.payout.checkoutId, dated.body.payout.paidAt, dated.body.final], [201, 'ch_big.1', '2026-12-31T10:00:00.000Z', false], label);
    // That €300 counts for 2026's cap, so 2027's is whole: the rest of ch_big and ch_mid fit today.
    const summary = (await asJson(await api(request('GET', 'admin/summary', undefined, 'secret')))).body.partners;
    assert.deepEqual([summary.codes[0].cap.year, summary.codes[0].cap.lines[0].paid, summary.toPay.map(row => [row.checkoutId, row.payable])], [2027, 0, [['ch_big', 11625], ['ch_mid', 8292]]], label);
    // Dated in 2026, the next payment meets 2026's cap, already reached: refused.
    const late = await pay({ checkout: 'ch_mid', paidOn: '2026-12-31' });
    assert.deepEqual([late.status, late.body.cap], [409, true], label);
    assert.match(late.body.error, /in 2026, €300\.00 paid so far/, label);
    // Today (no day given): 2027's cap, the moment itself.
    const today = await pay({ checkout: 'ch_mid' });
    assert.deepEqual([today.status, today.body.payout.paidAt, today.body.final], [201, iso(at), true], label);
  });
});

// ---- Undo names the payment it takes back -------------------------------------------------------

test('Undo names the exact payment it takes back, the API is told which, and an earlier cap year needs a second yes (memory and D1)', async t => {
  await bothStores(t, async (label, store) => {
    const at = Date.parse('2027-01-05T10:00:00Z');
    await store.addPartnerSale(team('ch_big', ...BIG, 0, {}, Date.parse('2026-10-01T09:00:00Z')));
    await store.addPartnerPayout(payout('ch_big.1', 30000, '2026-11-01T10:00:00Z'));
    await store.addPartnerPayout(payout('ch_big', 11625, '2027-01-03T10:00:00Z'));
    const api = apiFor(store, at);
    const summary = (await asJson(await api(request('GET', 'admin/summary', undefined, 'secret')))).body;
    const sale = summary.partners.team[0];
    assert.deepEqual([sale.status, sale.undoPayment, sale.paidBefore], ['paid', { id: 'ch_big', amount: 11625, paidAt: '2027-01-03T10:00:00Z' }, 30000], label);
    const words = view.undoWords(sale, { money, day: value => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }), year: 2027 });
    assert.deepEqual(words, { question: 'Undo the €116.25 paid on 3 Jan 2027? The €300.00 paid before stays paid.', done: 'Undone: the €116.25 paid on 3 Jan 2027. The €300.00 paid before stays paid.' }, label);
    const html = view.partnersCardHtml(summary, fmt);
    assert.match(html, /data-owner-payout-undo="ch_big" data-owner-payout-code="CAMILLE" data-owner-payout-payment="ch_big" data-owner-payout-question="Undo the €116\.25 paid on 2027-01-03\? The €300\.00 paid before stays paid\."/, label);
    // The API undoes only the payment the owner was shown.
    const undo = async query => asJson(await api(request('DELETE', `admin/partners/payouts/ch_big${query}`, undefined, 'secret')));
    const stale = await undo('?payment=ch_big.1');
    assert.deepEqual([stale.status, stale.body.removed], [409, false], `${label}: another payment than the one shown`);
    const first = await undo('?payment=ch_big');
    assert.deepEqual([first.status, first.body.payout.checkoutId, first.body.payout.amount], [200, 'ch_big', 11625], label);
    // The part left was paid in 2026, an earlier cap year: it says so, and is undone only once confirmed.
    const part = (await asJson(await api(request('GET', 'admin/summary', undefined, 'secret')))).body.partners.team[0];
    assert.deepEqual([part.status, part.undoPayment.id, part.paidBefore], ['earned', 'ch_big.1', 0], label);
    assert.equal(view.undoWords(part, { money, day: value => value.slice(0, 10), year: 2027 }).question, 'Undo the €300.00 paid on 2026-11-01? CAMILLE’s commission counts as not paid again. It was paid in 2026: undoing it changes 2026’s figures, the yearly cap included.', label);
    const refused = await undo('?payment=ch_big.1');
    assert.deepEqual([refused.status, refused.body.pastYear], [409, 2026], label);
    assert.match(refused.body.error, /^This payment was made in 2026: undoing it changes 2026’s figures, the yearly cap included\. Confirm to undo it anyway\.$/, label);
    assert.equal((await store.listPartnerPayouts()).length, 1, label);
    const confirmed = await undo('?payment=ch_big.1&confirm=1');
    assert.deepEqual([confirmed.status, confirmed.body.payout.checkoutId], [200, 'ch_big.1'], label);
    assert.deepEqual([(await undo('')).status, await store.listPartnerPayouts()], [404, []], `${label}: nothing left`);
  });
  const admin = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(admin, /window\.confirm\(dataset\.ownerPayoutQuestion/);
  assert.match(admin, /This payment was made in \$\{year\}: undoing it changes \$\{year\}’s figures, the yearly cap included\. Undo it anyway\?/);
  assert.match(admin, /confirm=1/);
});

// ---- Codes that differ only by case ----------------------------------------------------

test('CAMILLE and Camille are one partner: one cap, one status, and the dashboard says so', () => {
  const rows = [team('ch_1', ...BIG, 60), team('ch_2', ...BIG, 50, { code: 'Camille' }), team('ch_3', ...MID, 40, { code: 'camille' })];
  const summary = partnerSummary(rows, [], [], { now: NOW });
  assert.deepEqual(summary.totals.team.toPay, { EUR: 30000 }, 'one €300 cap, not three');
  const byCode = new Map(summary.codes.map(row => [row.code, [row.key, row.sameAs]]));
  assert.deepEqual([byCode.get('CAMILLE'), byCode.get('Camille'), byCode.get('camille')], [['CAMILLE', ['Camille', 'camille']], ['CAMILLE', ['CAMILLE', 'camille']], ['CAMILLE', ['CAMILLE', 'Camille']]]);
  assert.ok(summary.codes.every(row => row.cap.lines[0].held === 41625 + 41625 + 8292 - 30000));
  // A payment recorded under one case counts for all of them.
  const paid = partnerSummary(rows, [], [], { now: NOW, payouts: [payout('ch_1.1', 30000, iso(NOW - DAY), { code: 'CAMILLE' })] });
  assert.deepEqual([paid.totals.team.toPay, paid.codes.find(row => row.code === 'camille').cap.lines[0].paid], [{}, 30000]);
  // The status, recorded once, holds for every case.
  const business = partnerSummary(rows, [], [], { now: NOW, profiles: [{ code: 'camille', status: 'business' }] });
  assert.deepEqual(business.codes.map(row => row.partner), ['business', 'business', 'business']);
  assert.deepEqual(business.totals.team.toPay, { EUR: 41625 + 41625 + 8292 });
  // The card flags it on each row; the attention list has one line for what waits.
  assert.equal(view.samePartnerNote(summary.codes.find(row => row.code === 'CAMILLE')), 'Same partner? CAMILLE, Camille and camille are counted together for the cap, the status, the private link and the visits');
  assert.equal(view.samePartnerNote({ code: 'ANNA', sameAs: [] }), '');
  const html = view.partnersCardHtml({ partners: summary, partnerProgram: PARTNER_PROGRAM }, fmt);
  assert.equal((html.match(/Same partner\? /g) || []).length, 3);
  const held = buildAttention({ partners: summary, partnerProgram: PARTNER_PROGRAM }, { now: NOW, money }).filter(item => item.kind === 'partner-held');
  assert.equal(held.length, 1, 'one partner, one line');
  assert.deepEqual(held[0].rows.sort(), ['partner:ch_1', 'partner:ch_2', 'partner:ch_3']);
  // The statement of any case shows the whole partner.
  const statement = partnerStatement('Camille', { rows, now: NOW });
  assert.deepEqual([statement.code, statement.team.length, statement.totals.toPay, statement.cap.lines[0].paid], ['Camille', 3, { EUR: 30000 }, 0]);
});

// ---- The statement's figures -------------------------------------------------------------

test('the statement’s headline: the partner’s own currency, what waits above the cap, and “At most” on upper bounds', () => {
  const usd = (id, plan, amount, tax, days, fields = {}) => team(id, plan, amount, tax, days, { code: 'US_PARTNER', currency: 'USD', ...fields });
  // Already paid $300 this year: the next one waits above the cap.
  const capped = partnerStatement('US_PARTNER', { rows: [usd('ch_1', ...MID, 40)], payouts: [payout('ch_0', 30000, iso(NOW - 100 * DAY), { code: 'US_PARTNER', currency: 'USD' })], now: NOW });
  assert.deepEqual(model.statementFigures(capped)[2], { id: 'team', figure: '$82.92', label: 'in team commissions waiting above your yearly cap' });
  // Nothing yet: zero in the currency of the partner's sales, never euros for a dollar partner.
  const creemOnly = partnerStatement('US_PARTNER', { rows: [usd('ch_p', '', 2900, 0, 10, { kind: 'plus', payer: 'creem' })], now: NOW });
  assert.equal(creemOnly.currency, 'USD');
  assert.deepEqual(model.statementFigures(creemOnly)[2], { id: 'team', figure: '$0.00', label: 'in team commissions so far' });
  assert.deepEqual(model.statementFigures(partnerStatement('NEWBIE', { now: NOW }))[2], { id: 'team', figure: '0', label: 'team commissions so far' });
  // Tax unknown: what is to be paid and what waits are upper bounds, in the headline, the totals and the cap.
  const unsure = partnerStatement('CAMILLE', { rows: [team('ch_a', 'up-to-1000', 499500, null, 60), team('ch_b', 'up-to-100', 99500, null, 50)], now: NOW });
  assert.deepEqual(model.statementFigures(unsure)[2], { id: 'team', figure: 'At most €300.00', label: 'in team commissions to be paid · at most €299.00 waits above your yearly cap' });
  assert.deepEqual(model.teamTotals(unsure), [['To be paid', 'At most €300.00'], ['Above your yearly cap', 'At most €299.00']]);
  assert.match(model.capLines(unsure, ['EUR'])[0].heldText, /^At most €299\.00 waits above the cap/);
  const views = model.teamLineViews(unsure);
  assert.deepEqual(views.map(row => [row.amount, row.label]), [['At most €99.50', 'Waiting'], ['At most €499.50', 'Earned']]);
  assert.match(views[1].detail, /€300\.00 to be paid now · at most €199\.50 waits above your yearly cap/);
  // The dashboard and the attention list say “at most” for what waits, the same way.
  const summary = partnerSummary([team('ch_a', 'up-to-1000', 499500, null, 60), team('ch_b', 'up-to-100', 99500, null, 50)], [], [], { now: NOW });
  assert.equal(summary.codes[0].cap.lines[0].heldAtMost, true);
  assert.match(view.partnerCapHtml(summary.codes[0], fmt), /Above the yearly cap for an individual: at most €299\.00/);
  const items = buildAttention({ partners: summary, partnerProgram: PARTNER_PROGRAM }, { now: NOW, money });
  assert.deepEqual(items.filter(item => String(item.kind).startsWith('partner')).map(item => item.text), ['Pay CAMILLE at most €300.00 (10% of a team gift)', 'CAMILLE: at most €299.00 above the yearly cap for an individual']);
  assert.match(items.find(item => item.kind === 'partner-pay').detail, /at most €199\.50 more waits above the yearly cap/);
});

test('a pending commission for a partner already at the cap says it will wait for 1 January or an invoice as a business', () => {
  const rows = [team('ch_new', ...MID, 3)];
  const atCap = partnerStatement('CAMILLE', { rows, payouts: [payout('ch_old', 30000, iso(NOW - 30 * DAY))], now: NOW });
  const [line] = model.teamLineViews(atCap);
  assert.equal(line.label, 'Pending');
  assert.equal(line.detail, 'Earned on 31 Dec 2026 if the gift isn’t refunded · Your cap for this year is used up: once earned, it waits until 1 January, or until you invoice us as a business');
  // Room for part of it.
  const near = partnerStatement('CAMILLE', { rows, payouts: [payout('ch_old', 25000, iso(NOW - 30 * DAY))], now: NOW });
  assert.match(model.teamLineViews(near)[0].detail, /Only €50\.00 fits under your yearly cap this year: once earned, the rest waits until 1 January, or until you invoice us as a business$/);
  // Room enough, earned next year, or a business: nothing to say.
  assert.equal(model.teamLineViews(partnerStatement('CAMILLE', { rows, now: NOW }))[0].detail, 'Earned on 31 Dec 2026 if the gift isn’t refunded');
  const nextYear = partnerStatement('CAMILLE', { rows: [team('ch_jan', ...MID, 1, {}, Date.parse('2026-12-30T10:00:00Z'))], payouts: [payout('ch_old', 30000, iso(NOW - 30 * DAY))], now: Date.parse('2026-12-30T10:00:00Z') });
  assert.equal(model.teamLineViews(nextYear)[0].detail, 'Earned on 12 Jan 2027 if the gift isn’t refunded');
  const business = partnerStatement('CAMILLE', { rows, payouts: [payout('ch_old', 30000, iso(NOW - 30 * DAY))], profiles: [{ code: 'CAMILLE', status: 'business' }], now: NOW });
  assert.equal(model.teamLineViews(business)[0].detail, 'Earned on 31 Dec 2026 if the gift isn’t refunded');
});

// ---- Migration 0008 ---------------------------------------------------------------

test('migration 0008 keeps a link version per partner, and setting a status keeps it', { skip: DatabaseSync ? false : 'node:sqlite is not available' }, async () => {
  const sql = readFileSync(new URL('../migrations/0008_partner_profiles.sql', import.meta.url), 'utf8');
  assert.match(sql, /link_version INTEGER NOT NULL DEFAULT 0,/);
  assert.ok(!sql.includes('--'), 'block comments only');
  const store = createD1Store(d1());
  assert.equal(await store.partnerLinkVersion({ code: 'Camille', updatedAt: iso(NOW) }), 0, 'made at version 0');
  assert.equal(await store.partnerLinkVersion({ code: 'CAMILLE', renew: true, updatedAt: iso(NOW) }), 1);
  await store.setPartnerProfile({ code: 'camille', status: 'business', updatedAt: iso(NOW) });
  assert.deepEqual(await store.listPartnerProfiles({ code: 'cAmIlLe' }), [{ code: 'CAMILLE', status: 'business', linkVersion: 1, updatedAt: iso(NOW) }]);
  assert.equal(await store.partnerLinkVersion({ code: 'camille', updatedAt: iso(NOW) }), 1, 'copying keeps the version');
});
