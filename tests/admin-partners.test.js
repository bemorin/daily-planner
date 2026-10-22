import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commissionBasis, commissionFigure, commissionsSetupHtml, commissionState, partnerFootnote, partnersCardHtml, partnerWhat, payoutCheckWords, perCurrency, requestPartnerHtml } from '../admin/partners-view.js';
import { partnerSummary } from '../server/partners.js';

// The dashboard's Partners card (admin/partners-view.js), from the summary the API sends.
const NOW = Date.parse('2026-10-20T12:00:00Z');
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const sale = (checkoutId, daysAgo, fields = {}) => ({ checkoutId, code: 'CAMILLE', kind: 'plus', plan: '', amount: 2900, tax: 483, currency: 'EUR', member: false, mode: 'prod', createdAt: iso(NOW - daysAgo * DAY), ...fields });
const money = (cents, currency) => (cents == null ? '' : `${(cents / 100).toFixed(2)} ${currency}`);
const fmt = { money, exact: money, number: String, day: value => String(value).slice(0, 10) };
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('what a sale bought and where its commission stands, in plain words', () => {
  assert.equal(partnerWhat({ kind: 'plus' }), 'Plus');
  assert.equal(partnerWhat({ kind: 'gift', plan: 'family-5' }), 'Plus Family');
  assert.equal(partnerWhat({ kind: 'gift', plan: 'up-to-1000' }), 'Team gift · up to 1,000 people');
  assert.equal(partnerWhat({ kind: 'gift', plan: 'nope' }), 'Gift');
  const day = value => value.slice(0, 10);
  assert.deepEqual(commissionState({ status: 'pending', earnedAt: '2026-11-03T10:00:00Z' }, { day }), { label: 'Pending', detail: 'Earned on 2026-11-03 if not refunded', tone: 'wait' });
  assert.deepEqual(commissionState({ status: 'earned', program: 'team' }), { label: 'To pay', detail: 'By bank transfer', tone: 'due' });
  assert.deepEqual(commissionState({ status: 'earned', program: 'creem' }), { label: 'Earned', detail: 'Creem pays it', tone: 'ok' });
  assert.deepEqual(commissionState({ status: 'paid', paidAt: '2026-10-19T10:00:00Z', paidNote: 'SEPA 42' }, { day }), { label: 'Paid', detail: '2026-10-19 · SEPA 42', tone: 'ok' });
  // Paid, then disputed: still paid, and the row says what happened.
  assert.deepEqual(commissionState({ status: 'paid', state: 'disputed', paidAt: '2026-10-19T10:00:00Z', paidNote: 'SEPA 42' }, { day }), { label: 'Paid', detail: '2026-10-19 · SEPA 42 · Disputed after you paid it', tone: 'ok' });
  assert.equal(commissionState({ status: 'paid', state: 'refunded', paidAt: '2026-10-19T10:00:00Z' }, { day }).detail, '2026-10-19 · Refunded after you paid it');
  assert.equal(commissionState({ status: 'refunded' }).label, 'Refunded');
  assert.deepEqual(commissionState({ status: 'disputed' }), { label: 'Disputed', detail: 'Earns nothing', tone: 'off' });
  assert.deepEqual(commissionState({ status: 'revoked' }), { label: 'Switched off', detail: 'Earns nothing', tone: 'off' });
  assert.deepEqual(commissionState({ status: 'not-partner' }), { label: 'Not a partner', detail: 'You checked Creem · earns nothing', tone: 'off' });
  assert.equal(commissionBasis({ rate: 10, base: 49583, basis: 'before-tax', currency: 'EUR' }, fmt.money), '10% of 495.83 EUR before tax');
  // Tax not recorded, or a refund of unknown amount: what it is worked out on, honestly.
  assert.equal(commissionBasis({ rate: 25, base: 2900, basis: 'paid', currency: 'USD' }, fmt.money), '25% of 29.00 USD paid, tax included');
  assert.equal(commissionBasis({ rate: 10, base: 82917, basis: 'before-tax', currency: 'EUR', refundUnknown: true }, fmt.money), '10% of 829.17 EUR before tax, before the refund');
  assert.equal(commissionBasis({ rate: 25, base: null }, fmt.money), '');
  assert.equal(commissionFigure({ commission: 1950, currency: 'USD', exact: false, status: 'earned' }, fmt.exact), 'At most 19.50 USD');
  assert.equal(commissionFigure({ commission: 1625, currency: 'EUR', exact: true }, fmt.exact), '16.25 EUR');
  assert.equal(commissionFigure({ commission: null, currency: 'EUR' }, fmt.exact), '');
  assert.equal(perCurrency({ EUR: 100, USD: 0 }, fmt.money), '1.00 EUR', 'nothing shown for a currency with nothing');
  assert.equal(perCurrency({}, fmt.money), '—');
  // What to check before paying, one sentence each.
  assert.deepEqual(payoutCheckWords({ code: 'BADCODE', checks: ['code', 'refund', 'tax'] }, 10), [
    'Check that BADCODE is a partner in Creem → Affiliate Hub before paying',
    'Part refunded, amount unknown: check the refund in Creem before paying',
    'Tax not recorded: check it in Creem, and pay 10% of the price before tax'
  ]);
  assert.deepEqual(payoutCheckWords({ code: 'X' }), []);
});

test('a team request’s partner code says whether it is confirmed, and every value is escaped', () => {
  assert.equal(requestPartnerHtml('', ''), '');
  assert.equal(requestPartnerHtml('COACH_1', 'creem', 10), '<span class="owner-partner-ref">Partner: <code>COACH_1</code> — 10% if this becomes an order</span>');
  assert.equal(requestPartnerHtml('COACH_1', 'paid', 10), '<span class="owner-partner-ref">Partner: <code>COACH_1</code> — 10% if this becomes an order</span>');
  assert.equal(requestPartnerHtml('NEWONE', '', 10), '<span class="owner-partner-ref">Partner: <code>NEWONE</code> — 10% if this becomes an order<small>Not confirmed: check that NEWONE is a partner in Creem → Affiliate Hub before paying.</small></span>');
  assert.equal(requestPartnerHtml('BADCODE', 'rejected', 10), '<span class="owner-partner-ref is-off">Partner: <code>BADCODE</code> — not a partner (you checked Creem)</span>');
  assert.doesNotMatch(requestPartnerHtml('<b>', ''), /<b>/);
});

test('the card: what you owe first (with Mark as paid), Creem’s commissions for information, then each partner and the latest sales', () => {
  const team = { kind: 'gift', plan: 'up-to-10', payer: 'owner', amount: 19500, tax: 3250 };
  const rows = [
    sale('ch_due', 20, { ...team, code: 'COACH_ANNA' }),
    sale('ch_paid', 40, { ...team, code: 'COACH_ANNA', plan: 'up-to-50', amount: 59500, tax: 9917 }),
    sale('ch_wait', 2, team),
    sale('ch_plus', 20),
    sale('ch_back', 30, { code: '<img src=x onerror=alert(1)>' }),
    sale('ch_try', 1, { mode: 'test' })
  ];
  const partners = partnerSummary(rows, [{ checkoutId: 'ch_back', reason: 'dispute' }], [], { now: NOW, payouts: [{ checkoutId: 'ch_paid', code: 'COACH_ANNA', amount: 4958, currency: 'EUR', note: 'SEPA <42>', paidAt: iso(NOW - 10 * DAY) }] });
  const html = partnersCardHtml({ partners, partnerProgram: { rate: 25, teamRate: 10, refundDays: 14 } }, fmt);
  const words = text(html);
  // The figures: what to pay (highlighted), Creem's, the sales.
  assert.match(html, /<div class="owner-stat owner-stat--due"><span>Team commissions to pay<\/span><strong>16\.25 EUR<\/strong><small>1 earned, not paid yet · by bank transfer<\/small><\/div>/);
  assert.match(words, /Creem commissions \(25%\) 6\.04 EUR Earned · Creem pays these, shown for information/);
  assert.match(words, /1 sale in test mode \(29\.00 EUR\) is not counted\./);
  assert.doesNotMatch(html, /owner-partner-setup/, 'migration 0007 is there');
  // The team commissions, one row each, the attention panel's target on each.
  const table = /<table class="owner-table owner-partner-team">[\s\S]*?<\/table>/.exec(html)[0];
  assert.deepEqual([...table.matchAll(/data-owner-attn="partner:([^"]+)"/g)].map(match => match[1]), ['ch_wait', 'ch_due', 'ch_paid']);
  // COACH_ANNA was paid once, so checked: nothing to check before paying again.
  assert.match(table, /<button class="secondary-button owner-pay" type="button" data-owner-payout="ch_due" data-owner-payout-code="COACH_ANNA" data-owner-payout-amount="16\.25 EUR" data-owner-payout-cents="1625" data-owner-payout-currency="EUR" data-owner-payout-exact="1" data-owner-payout-checks="" data-owner-payout-rest="1625" data-owner-payout-partner="individual" data-owner-payout-earned="\d{4}-\d{2}-\d{2}">Mark as paid<\/button><\/div>/);
  assert.match(table, /data-owner-payout-undo="ch_paid"[^>]*>Undo<\/button>/);
  assert.equal((table.match(/data-owner-payout="/g) || []).length, 1, 'only the earned one can be marked');
  assert.match(text(table), /16\.25 EUR 10% of 162\.50 EUR before tax/);
  assert.match(text(table), /Paid 2026-10-10 · SEPA &lt;42&gt;/);
  assert.match(text(table), /Pending Earned on 2026-11-01 if not refunded/);
  // Every value is escaped.
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // By partner, then the latest sales with their state.
  assert.match(html, /<th class="num">Creem · 25%<\/th><th class="num">To pay · 10%<\/th>/);
  assert.match(words, /Disputed Earns nothing/);
  assert.match(words, /Test · not counted/);
  assert.match(html, /data-owner-payout-result role="status" aria-live="polite" tabindex="-1"/);
});

test('a team commission to check says so on its row: an invented code, a refund of unknown amount, a tax not recorded', () => {
  const team = { kind: 'gift', plan: 'up-to-10', payer: 'owner', amount: 19500, tax: 3250 };
  const rows = [
    sale('ch_bad', 20, { ...team, code: 'BADCODE' }),
    sale('ch_soon', 3, { ...team, code: 'BADCODE' }),
    sale('ch_refund', 25, { ...team, plan: 'up-to-100', amount: 99500, tax: 16583 }),
    sale('ch_usd', 22, { ...team, currency: 'USD', tax: null }),
    sale('ch_plus', 30)
  ];
  const refunds = [{ checkoutId: 'ch_refund', amount: null, currency: 'EUR', fullRefund: false }];
  const partners = partnerSummary(rows, [], refunds, { now: NOW });
  const html = partnersCardHtml({ partners, partnerProgram: { rate: 25, teamRate: 10, refundDays: 14 } }, fmt);
  const row = id => text(new RegExp(`<tr data-owner-attn="partner:${id}"[\\s\\S]*?</tr>`).exec(html)[0]);
  const markup = id => new RegExp(`<tr data-owner-attn="partner:${id}"[\\s\\S]*?</tr>`).exec(html)[0];
  // BADCODE: nothing confirmed it — said under the code and in the state, with Not a partner next to Mark as paid.
  assert.match(row('ch_bad'), /BADCODE Not confirmed .* To pay Check that BADCODE is a partner in Creem → Affiliate Hub before paying/);
  assert.match(markup('ch_bad'), /data-owner-payout-checks="code" data-owner-payout-rest="1625" data-owner-payout-partner="individual" data-owner-payout-earned="\d{4}-\d{2}-\d{2}">Mark as paid<\/button><button class="text-button" type="button" data-owner-code-reject="BADCODE" data-owner-row="ch_bad" aria-label="Mark BADCODE as not a partner">Not a partner<\/button>/);
  // Still pending: when it is earned, then the check; Not a partner already offered.
  assert.match(row('ch_soon'), /Pending Earned on 2026-10-31 if not refunded · Check that BADCODE is a partner/);
  assert.match(markup('ch_soon'), /data-owner-code-reject="BADCODE"/);
  assert.doesNotMatch(markup('ch_soon'), /data-owner-payout=/);
  // Part refunded, amount unknown: on the row, the figure an upper bound, and Mark as paid asks for the amount.
  assert.match(row('ch_refund'), /995\.00 EUR paid · part refunded, amount unknown/);
  assert.match(row('ch_refund'), /At most 82\.92 EUR 10% of 829\.17 EUR before tax, before the refund/);
  assert.match(row('ch_refund'), /Part refunded, amount unknown: check the refund in Creem before paying/);
  assert.match(markup('ch_refund'), /data-owner-payout-exact="0" data-owner-payout-checks="refund"/);
  // Tax not recorded: an upper bound, said so.
  assert.match(row('ch_usd'), /At most 19\.50 USD 10% of 195\.00 USD paid, tax included/);
  assert.match(row('ch_usd'), /Tax not recorded: check it in Creem, and pay 10% of the price before tax/);
  // The figures say how many to check first; codes are flagged per partner too; the footnote explains “at most”.
  assert.match(text(html), /3 earned, not paid yet · 3 to check first · by bank transfer/);
  assert.match(text(html), /2 commissions are shown “at most”: the tax or a refund’s amount isn’t recorded\./);
  assert.match(html, /<td><code>BADCODE<\/code><small class="owner-small owner-small--warn">Not confirmed<\/small><span class="owner-partner-tools">[\s\S]*?<\/span><\/td>\s*<td class="num"><b>2<\/b>/);
  // Several currencies and nothing earned yet: no “€0.00” — the figures that have nothing read “—”.
  const both = partnersCardHtml({ partners: partnerSummary([sale('ch_a', 2), sale('ch_b', 2, { currency: 'USD' })], [], [], { now: NOW }) }, fmt);
  assert.match(both, /<span>Team commissions to pay<\/span><strong>—<\/strong>/);
  assert.match(both, /<span>Creem commissions \(25%\)<\/span><strong>—<\/strong>/);
  // Found to be no partner: earns nothing, with Undo.
  const rejected = partnersCardHtml({ partners: partnerSummary(rows, [], refunds, { now: NOW, rejections: [{ code: 'BADCODE' }] }), partnerProgram: { teamRate: 10 } }, fmt);
  const bad = new RegExp('<tr data-owner-attn="partner:ch_bad"[\\s\\S]*?</tr>').exec(rejected)[0];
  assert.match(bad, /class="is-off"/);
  assert.match(text(bad), /BADCODE Not a partner .* Not a partner You checked Creem · earns nothing/);
  assert.match(bad, /data-owner-code-undo="BADCODE" data-owner-row="ch_bad" aria-label="Undo: BADCODE is not a partner">Undo<\/button>/);
});

test('the card stays clear when there is nothing, and says what is missing', () => {
  assert.match(partnersCardHtml({ partnersUnavailable: true }, fmt), /Apply <code>migrations\/0006_partners\.sql<\/code> and <code>migrations\/0007_partner_commissions\.sql<\/code>/);
  const empty = partnersCardHtml({ partners: partnerSummary([], [], [], { now: NOW }) }, fmt);
  assert.match(empty, /^<p class="owner-empty">No sales through a partner’s link yet\./);
  assert.match(text(empty), /Plus, Give Plus and Plus Family earn them 25% \(Creem pays\); a team gift earns them 10% \(you pay, by bank transfer\)\./);
  // Without migration 0007: one setup line, and nothing to click that would fail.
  const team = { kind: 'gift', plan: 'up-to-10', payer: 'owner', amount: 19500, tax: 3250 };
  const before = partnersCardHtml({ partners: partnerSummary([sale('ch_due', 20, team), sale('ch_soon', 2, { ...team, code: 'NEW' })], [], [], { now: NOW }), partnerCommissionsUnavailable: true }, fmt);
  assert.match(before, /<p class="owner-partner-setup" role="note">Run <code>migrations\/0007_partner_commissions\.sql<\/code> on the D1 database to track team commissions\. Until then they can’t be marked as paid, and new sales are recorded without their tax\.<\/p>/);
  assert.doesNotMatch(before, /data-owner-payout=|data-owner-code-reject|data-owner-payout-undo/);
  assert.match(text(before), /To pay By bank transfer/, 'the commission is still shown');
  assert.equal(commissionsSetupHtml({}), '');
  const missing = partnersCardHtml({ partners: partnerSummary([], [], [], { now: NOW }), partnerCommissionsUnavailable: true }, fmt);
  assert.match(missing, /Run <code>migrations\/0007_partner_commissions\.sql<\/code>/);
  // Nothing to pay: a calm zero in the one currency used, not an alert.
  const calm = partnersCardHtml({ partners: partnerSummary([sale('ch_plus', 20)], [], [], { now: NOW }) }, fmt);
  assert.doesNotMatch(calm, /owner-stat--due|owner-partner-team/);
  assert.match(text(calm), /Team commissions to pay 0\.00 EUR Nothing to pay · 10% of team gifts/);
  const dollars = partnersCardHtml({ partners: partnerSummary([sale('ch_plus', 20, { currency: 'USD' })], [], [], { now: NOW }) }, fmt);
  assert.match(text(dollars), /Team commissions to pay 0\.00 USD/, 'never euros when everything is in dollars');
  assert.equal(partnerFootnote({ partners: { totals: { capped: true, listed: 2000 } } }, fmt), 'The figures cover the latest 2000 sales.');
});

test('the dashboard renders the card from the view and marks commissions as paid through the API', () => {
  const admin = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(admin, /\$\('\[data-owner-partners\]'\)\.innerHTML = partnersCardHtml\(summary, \{ money, exact: exactMoney, number, day \}\);/);
  assert.match(admin, /sendJson\('admin\/partners\/payouts', 'POST', asked\.body\)/);
  // Mark as paid: one dialog (./payout-dialog.js) asks the checks, the amount of an upper bound, the day paid and a reference.
  assert.match(admin, /const asked = await openPayoutDialog\(dataset, \{ money: exactMoney, rate: TEAM_RATE \}\);/);
  const dialog = readFileSync(new URL('../admin/payout-dialog.js', import.meta.url), 'utf8');
  assert.match(dialog, /body: \{ checkout: details\.checkout, note: String\(values\.note \|\| ''\)\.trim\(\)\.slice\(0, NOTE_MAX\), paidOn, \.\.\.\(details\.checks\.length \? \{ confirmed: true \} : \{\}\), \.\.\.\(amount == null \? \{\} : \{ amount \}\)/, 'the owner confirms the checks, and gives the amount paid for an upper bound');
  // Undo names the payment it takes back, and the API is told which one.
  assert.match(admin, /const path = `admin\/partners\/payouts\/\$\{encodeURIComponent\(dataset\.ownerPayoutUndo\)\}`;/);
  assert.match(admin, /await call\(`\$\{path\}\$\{payment\}`, \{ method: 'DELETE' \}\);/);
  assert.match(admin, /sendJson\('admin\/partners\/rejections', 'POST', \{ code \}\)/);
  assert.match(admin, /call\(`admin\/partners\/rejections\/\$\{encodeURIComponent\(code\)\}`, \{ method: 'DELETE' \}\)/);
  // After Mark as paid, Undo or Not a partner, focus stays on the row (its new first button), never on the page.
  assert.match(admin, /await load\(\);\n {2}showResult\('\[data-owner-payout-result\]', done, isError\);\n {2}focusPartnerRow\(row, focusCode\);/);
  // The request list (admin/requests-view.js) shows the partner code and whether it is confirmed.
  assert.match(admin, /teamRequestsTableHtml\(rows, \{ codeChecks, teamRate: TEAM_RATE, when, number \}\)/, 'the request list gets the checks and the team rate');
  const requests = readFileSync(new URL('../admin/requests-view.js', import.meta.url), 'utf8');
  assert.match(requests, /requestPartnerHtml\(row\.ref, codeChecks\[row\.ref\] \|\| '', teamRate\)/, 'the request list shows the partner code and whether it is confirmed');
  assert.doesNotMatch(admin, /AFFILIATE_COMMISSION/);
  // Setup says what to set in Creem, and that the variable is the sign-up link.
  const setup = /function partnersItem\(summary[\s\S]*?\n\}/.exec(admin)[0];
  for (const words of ['commission <b>${esc(program.rate)}%</b>', 'attribution window <b>${esc(program.cookieDays)} days</b>', 'a <b>public</b> program', 'DAILY_PLANNER_AFFILIATE_URL', 'the link behind “Become a partner”']) assert.ok(setup.includes(words), words);
  const index = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
  assert.match(index, /data-owner-partners-caption>[^\n]*Creem pays partners 25%[^\n]*You pay 10% of team gifts/);
  assert.doesNotMatch(index, /clicks/i, 'Creem never sees a click: partners share our own ?ref= link');
});
