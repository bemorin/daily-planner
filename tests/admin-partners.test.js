import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commissionBasis, commissionState, partnerFootnote, partnersCardHtml, partnerWhat, perCurrency } from '../admin/partners-view.js';
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
  assert.equal(commissionState({ status: 'refunded' }).label, 'Refunded');
  assert.equal(commissionState({ status: 'disputed', paidAt: '2026-10-19T10:00:00Z' }, { day }).detail, 'After you paid it (2026-10-19)');
  assert.deepEqual(commissionState({ status: 'revoked' }), { label: 'Switched off', detail: 'Earns nothing', tone: 'off' });
  assert.equal(commissionBasis({ rate: 10, base: 49583, basis: 'before-tax', currency: 'EUR' }, fmt.money), '10% of 495.83 EUR before tax');
  assert.equal(commissionBasis({ rate: 25, base: 2900, basis: 'paid', currency: 'USD' }, fmt.money), '25% of 29.00 USD paid (tax unknown)');
  assert.equal(commissionBasis({ rate: 25, base: null }, fmt.money), '');
  assert.equal(perCurrency({ EUR: 100, USD: 0 }, fmt.money), '1.00 EUR', 'nothing shown for a currency with nothing');
  assert.equal(perCurrency({}, fmt.money), '—');
});

test('the card: what you owe first (with Mark as paid), Creem’s commissions for information, then each partner and the latest sales', () => {
  const rows = [
    sale('ch_due', 20, { code: 'COACH_ANNA', kind: 'gift', plan: 'up-to-10', amount: 19500, tax: 3250 }),
    sale('ch_paid', 40, { code: 'COACH_ANNA', kind: 'gift', plan: 'up-to-50', amount: 59500, tax: 9917 }),
    sale('ch_wait', 2, { kind: 'gift', plan: 'up-to-10', amount: 19500, tax: 3250 }),
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
  // The team commissions, one row each, the attention panel's target on each.
  const team = /<table class="owner-table owner-partner-team">[\s\S]*?<\/table>/.exec(html)[0];
  assert.deepEqual([...team.matchAll(/data-owner-attn="partner:([^"]+)"/g)].map(match => match[1]), ['ch_wait', 'ch_due', 'ch_paid']);
  assert.match(team, /<button class="secondary-button owner-pay" type="button" data-owner-payout="ch_due" data-owner-payout-code="COACH_ANNA" data-owner-payout-amount="16\.25 EUR">Mark as paid<\/button>/);
  assert.match(team, /data-owner-payout-undo="ch_paid"[^>]*>Undo<\/button>/);
  assert.equal((team.match(/data-owner-payout="/g) || []).length, 1, 'only the earned one can be marked');
  assert.match(text(team), /16\.25 EUR 10% of 162\.50 EUR before tax/);
  assert.match(text(team), /Paid 2026-10-10 · SEPA &lt;42&gt;/);
  assert.match(text(team), /Pending Earned on 2026-11-01 if not refunded/);
  // Every value is escaped.
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // By partner, then the latest sales with their state.
  assert.match(html, /<th class="num">Creem · 25%<\/th><th class="num">To pay · 10%<\/th>/);
  assert.match(words, /Disputed Earns nothing/);
  assert.match(words, /Test · not counted/);
  assert.match(html, /data-owner-payout-result role="status"/);
});

test('the card stays clear when there is nothing, and says what is missing', () => {
  assert.match(partnersCardHtml({ partnersUnavailable: true }, fmt), /Apply <code>migrations\/0006_partners\.sql<\/code> and <code>migrations\/0007_partner_commissions\.sql<\/code>/);
  const empty = partnersCardHtml({ partners: partnerSummary([], [], [], { now: NOW }) }, fmt);
  assert.match(empty, /^<p class="owner-empty">No sales through a partner’s link yet\./);
  assert.match(text(empty), /Plus, Give Plus and Plus Family earn them 25% \(Creem pays\); a team gift earns them 10% \(you pay, by bank transfer\)\./);
  const missing = partnersCardHtml({ partners: partnerSummary([], [], [], { now: NOW }), partnerCommissionsUnavailable: true }, fmt);
  assert.match(missing, /Apply migrations\/0007_partner_commissions\.sql to mark team commissions as paid/);
  // Nothing to pay: a calm zero, not an alert.
  const calm = partnersCardHtml({ partners: partnerSummary([sale('ch_plus', 20)], [], [], { now: NOW }) }, fmt);
  assert.doesNotMatch(calm, /owner-stat--due|owner-partner-team/);
  assert.match(text(calm), /Nothing to pay · 10% of team gifts/);
  assert.equal(partnerFootnote({ partners: { totals: { capped: true, listed: 2000 } } }, fmt), 'The figures cover the latest 2000 sales.');
});

test('the dashboard renders the card from the view and marks commissions as paid through the API', () => {
  const admin = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(admin, /\$\('\[data-owner-partners\]'\)\.innerHTML = partnersCardHtml\(summary, \{ money, exact: exactMoney, number, day \}\);/);
  assert.match(admin, /sendJson\('admin\/partners\/payouts', 'POST', \{ checkout: button\.dataset\.ownerPayout, note \}\)/);
  assert.match(admin, /call\(`admin\/partners\/payouts\/\$\{encodeURIComponent\(button\.dataset\.ownerPayoutUndo\)\}`, \{ method: 'DELETE' \}\)/);
  assert.match(admin, /<span class="owner-partner-ref">Partner: <code>\$\{esc\(row\.ref\)\}<\/code> — \$\{esc\(TEAM_RATE\)\}% if this becomes an order<\/span>/, 'the request list shows the partner code');
  assert.doesNotMatch(admin, /AFFILIATE_COMMISSION/);
  // Setup says what to set in Creem, and that the variable is the sign-up link.
  const setup = /function partnersItem\(summary[\s\S]*?\n\}/.exec(admin)[0];
  for (const words of ['commission <b>${esc(program.rate)}%</b>', 'attribution window <b>${esc(program.cookieDays)} days</b>', 'a <b>public</b> program', 'DAILY_PLANNER_AFFILIATE_URL', 'the link behind “Become a partner”']) assert.ok(setup.includes(words), words);
  const index = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
  assert.match(index, /data-owner-partners-caption>[^\n]*Creem pays partners 25%[^\n]*You pay 10% of team gifts/);
});
