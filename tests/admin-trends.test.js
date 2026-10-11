import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, isDay, isoWeek, isoWeekStart, weekday, periodStart, shiftPeriod, periodEnd, periodKey, sameOffset,
  comparisonRanges, periodHistory, sumEvents, firstEventDay, countSales, saleCurrencies, revenueByCurrency,
  TREND_METRICS, metricById, metricValue, metricTrend, metricFirstDay, dataStart, change, ratio, yearsToShow,
  FUNNELS, funnelSteps, funnelOverall, SECTION_EVENTS, sectionUsage, installUsage, seriesWindow, normalizeSeries
} from '../admin/trends.js';

const daily = (from, to, count) => {
  const days = {};
  for (let day = from; day <= to; day = addDays(day, 1)) days[day] = typeof count === 'function' ? count(day) : count;
  return days;
};

test('days are UTC calendar days', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(isDay('2026-02-29'), false);
  assert.equal(isDay('2028-02-29'), true);
  assert.equal(isDay('2026-13-01'), false);
  assert.equal(isDay(''), false);
  assert.equal(weekday('2026-10-05'), 0, 'Monday');
  assert.equal(weekday('2026-10-11'), 6, 'Sunday');
});

test('ISO weeks run Monday to Sunday and belong to the year of their Thursday', () => {
  assert.deepEqual(isoWeek('2026-01-01'), { year: 2026, week: 1 });
  assert.deepEqual(isoWeek('2025-12-29'), { year: 2026, week: 1 }, 'a Monday in December can open week 1');
  assert.deepEqual(isoWeek('2027-01-01'), { year: 2026, week: 53 }, '2026 has 53 weeks');
  assert.deepEqual(isoWeek('2021-01-03'), { year: 2020, week: 53 });
  assert.deepEqual(isoWeek('2026-10-11'), { year: 2026, week: 41 });
  assert.equal(isoWeekStart('2026-10-11'), '2026-10-05');
  assert.equal(isoWeekStart('2026-10-05'), '2026-10-05');
  assert.equal(periodKey('week', '2027-01-03'), '2026-W53');
  assert.equal(periodKey('month', '2026-10-11'), '2026-10');
  assert.equal(periodKey('year', '2026-10-11'), '2026');
});

test('periods start, shift and end on calendar boundaries', () => {
  assert.equal(periodStart('week', '2026-10-08'), '2026-10-05');
  assert.equal(periodStart('month', '2026-10-08'), '2026-10-01');
  assert.equal(periodStart('year', '2026-10-08'), '2026-01-01');
  assert.equal(shiftPeriod('month', '2026-01-01', -1), '2025-12-01');
  assert.equal(shiftPeriod('month', '2026-11-01', 2), '2027-01-01');
  assert.equal(shiftPeriod('month', '2026-10-01', -12), '2025-10-01');
  assert.equal(shiftPeriod('week', '2026-10-05', -1), '2026-09-28');
  assert.equal(shiftPeriod('year', '2026-01-01', -1), '2025-01-01');
  assert.equal(periodEnd('month', '2028-02-01'), '2028-02-29');
  assert.equal(periodEnd('month', '2026-02-01'), '2026-02-28');
  assert.equal(periodEnd('week', '2026-12-28'), '2027-01-03');
  assert.equal(periodEnd('year', '2026-01-01'), '2026-12-31');
});

test('to-date comparisons use the same days of the previous period', () => {
  const week = comparisonRanges('week', '2026-10-08');
  assert.deepEqual(week.current, { from: '2026-10-05', to: '2026-10-08' });
  assert.deepEqual(week.previous, { from: '2026-09-28', to: '2026-10-01' }, 'Monday to the same weekday');
  assert.deepEqual(week.lastYear, { from: '2025-10-06', to: '2025-10-09' }, '52 weeks earlier keeps the weekdays');
  assert.equal(weekday(week.lastYear.from), 0);

  const month = comparisonRanges('month', '2026-03-31');
  assert.deepEqual(month.current, { from: '2026-03-01', to: '2026-03-31' });
  assert.deepEqual(month.previous, { from: '2026-02-01', to: '2026-02-28' }, 'cut at the end of a shorter month');
  assert.deepEqual(month.lastYear, { from: '2025-03-01', to: '2025-03-31' });

  const leap = comparisonRanges('year', '2028-02-29');
  assert.deepEqual(leap.current, { from: '2028-01-01', to: '2028-02-29' });
  assert.deepEqual(leap.previous, { from: '2027-01-01', to: '2027-02-28' });
  assert.equal(leap.lastYear, null, 'a year’s previous period already is last year');

  assert.equal(sameOffset('month', '2026-02-01', '2026-01-30'), '2026-02-28');
  assert.equal(sameOffset('week', '2026-09-28', '2026-10-11'), '2026-10-04');
});

test('history lists whole periods, oldest first, the last one to date', () => {
  const weeks = periodHistory('week', '2026-10-08', 12);
  assert.equal(weeks.length, 12);
  assert.deepEqual(weeks.at(-1), { key: '2026-W41', from: '2026-10-05', to: '2026-10-08', current: true });
  assert.deepEqual(weeks[0], { key: '2026-W30', from: '2026-07-20', to: '2026-07-26', current: false });
  const months = periodHistory('month', '2026-10-08', 12);
  assert.equal(months[0].from, '2025-11-01');
  assert.equal(months[0].to, '2025-11-30');
  assert.equal(months.at(-1).to, '2026-10-08');
  assert.deepEqual(periodHistory('year', '2026-10-08', 2).map(row => [row.key, row.from, row.to]), [['2025', '2025-01-01', '2025-12-31'], ['2026', '2026-01-01', '2026-10-08']]);
});

const series = {
  from: '2025-01-01',
  to: '2026-10-08',
  events: {
    landing_viewed: daily('2025-09-01', '2026-10-08', 10),
    app_active_day: daily('2026-01-01', '2026-10-08', 20),
    app_active_week: daily('2026-01-01', '2026-10-08', day => (weekday(day) === 0 ? 7 : 1)),
    app_active_month: daily('2026-01-01', '2026-10-08', day => (day.endsWith('-01') ? 30 : 0)),
    app_installed_day: daily('2026-01-01', '2026-10-08', 5),
    week_view_opened: daily('2026-01-01', '2026-10-08', 10),
    search_opened: daily('2026-01-01', '2026-10-08', day => (day >= '2026-10-05' ? 4 : 2)),
    print_used: { '2026-10-06': 1 },
    install_accepted: { '2026-10-06': 2, '2026-09-29': 1 },
    teams_viewed: daily('2026-09-01', '2026-10-08', 4),
    pricing_viewed: daily('2026-09-01', '2026-10-08', 2),
    pack_checkout_clicked: { '2026-10-06': 3 },
    plus_viewed: { '2026-10-06': 6 },
    plus_modal_opened: { '2026-10-07': 4 },
    plus_checkout_clicked: { '2026-10-07': 2 },
    plus_unlocked: { '2026-10-07': 5 }
  },
  sales: [
    { day: '2025-10-07', kind: 'gift', source: 'manual', plan: 'up-to-50', seats: 50, amount: 59500, currency: 'EUR' },
    { day: '2026-09-30', kind: 'plus', source: 'creem', plan: '', seats: null, amount: 2900, currency: 'USD' },
    { day: '2026-10-06', kind: 'gift', source: 'creem', plan: 'up-to-10', seats: 10, amount: 14900, currency: 'EUR' },
    { day: '2026-10-07', kind: 'plus', source: 'creem', plan: '', seats: null, amount: 2900, currency: 'EUR' },
    { day: '2026-10-07', kind: 'plus', source: 'creem', plan: '', seats: null, amount: null, currency: '' }
  ]
};

test('sums count only the days inside the range', () => {
  assert.equal(sumEvents(series.events, ['landing_viewed'], { from: '2026-10-05', to: '2026-10-08' }), 40);
  assert.equal(sumEvents(series.events, ['plus_viewed', 'plus_modal_opened'], { from: '2026-10-05', to: '2026-10-08' }), 10);
  assert.equal(sumEvents(series.events, ['missing'], { from: '2026-10-05', to: '2026-10-08' }), 0);
  assert.equal(firstEventDay(series.events, ['app_active_day', 'landing_viewed']), '2025-09-01');
  assert.equal(firstEventDay(series.events, ['nothing']), '');
  assert.equal(countSales(series.sales, { from: '2026-10-01', to: '2026-10-08' }, { kind: 'gift' }), 1);
  assert.equal(countSales(series.sales, { from: '2025-01-01', to: '2026-10-08' }, { kind: 'gift', source: 'creem' }), 1);
});

test('revenue stays per currency and is never added across currencies', () => {
  assert.deepEqual(saleCurrencies(series.sales), ['EUR', 'USD']);
  assert.deepEqual(saleCurrencies([{ day: '2026-01-01', amount: 100, currency: 'GBP' }, { day: '2026-01-01', amount: 100, currency: 'USD' }]), ['USD', 'GBP']);
  assert.deepEqual(revenueByCurrency(series.sales, { from: '2026-09-28', to: '2026-10-08' }), { EUR: 17800, USD: 2900 });
  assert.deepEqual(revenueByCurrency(series.sales, { from: '2026-10-08', to: '2026-10-08' }), { EUR: 0, USD: 0 }, 'known currencies show 0');
  assert.deepEqual(revenueByCurrency([], { from: '2026-10-01', to: '2026-10-08' }), {});
});

test('active devices read weeks, months, then device-months for a year', () => {
  const devices = metricById('devices');
  const ranges = { week: comparisonRanges('week', '2026-10-08'), month: comparisonRanges('month', '2026-10-08'), year: comparisonRanges('year', '2026-10-08') };
  assert.equal(metricValue(series, devices, 'week', ranges.week.current), 10, 'app_active_week Monday → Thursday');
  assert.equal(metricValue(series, devices, 'month', ranges.month.current), 30, 'app_active_month this month');
  assert.equal(metricValue(series, devices, 'year', ranges.year.current), 300, 'ten months of app_active_month');
  assert.equal(TREND_METRICS.length, 9);
  assert.equal(metricById('nope'), null);
});

test('changes are signed percentages, "new" when nothing came before', () => {
  assert.deepEqual(change(5, 0), { kind: 'new', pct: null });
  assert.deepEqual(change(0, 0), { kind: 'flat', pct: 0 });
  assert.deepEqual(change(15, 10), { kind: 'up', pct: 50 });
  assert.deepEqual(change(5, 10), { kind: 'down', pct: -50 });
  assert.deepEqual(change(10, 10), { kind: 'flat', pct: 0 });
  assert.equal(ratio(1, 0), null);
  assert.equal(ratio(1, 4), 0.25);
});

test('a tile compares with the previous period and, when counts exist, a year earlier', () => {
  const landing = metricTrend(series, metricById('landing'), 'week', '2026-10-08');
  assert.equal(landing.current, 40);
  assert.equal(landing.previous, 40);
  assert.equal(landing.lastYear, 40, 'counted since September 2025');
  assert.equal(landing.history.length, 12);
  assert.equal(landing.history.at(-1).value, 40, 'current week to date');
  assert.equal(landing.history.at(-2).value, 70, 'last full week');

  assert.equal(landing.previousPartial, false);

  const active = metricTrend(series, metricById('active-days'), 'month', '2026-10-08');
  assert.equal(active.lastYear, null, 'nothing was counted a year ago');
  assert.equal(active.firstDay, '2026-01-01');

  const yearly = metricTrend(series, metricById('landing'), 'year', '2026-10-08', { count: 2 });
  assert.equal(yearly.lastYear, null);
  assert.deepEqual(yearly.history.map(row => row.value), [1220, 2810]);
  assert.equal(yearly.previousPartial, true, 'counting began in September 2025, part-way through last year’s same days');

  const lateStart = { ...series, events: { landing_viewed: daily('2025-09-05', '2026-10-08', 10) } };
  assert.equal(metricTrend(lateStart, metricById('landing'), 'month', '2026-09-20').lastYear, null, 'September 2025 was only partly counted');
  assert.equal(metricTrend(lateStart, metricById('landing'), 'month', '2026-10-08').lastYear, 80);
  assert.equal(metricTrend(series, metricById('landing'), 'month', '2026-10-08').lastYear, 80);

  const revenue = metricTrend(series, metricById('revenue'), 'week', '2026-10-08', { currencies: ['EUR', 'USD'] });
  assert.deepEqual(revenue.current, { EUR: 17800, USD: 0 });
  assert.deepEqual(revenue.previous, { EUR: 0, USD: 2900 });
  assert.deepEqual(revenue.lastYear, { EUR: 59500, USD: 0 }, 'the manual sale on the same weekday a year earlier');

  const sold = metricTrend(series, metricById('gifts-sold'), 'month', '2026-10-08');
  assert.equal(sold.current, 1);
  assert.equal(sold.lastYear, 1);
});

test('sales count from the start of the data, events from their own first count', () => {
  assert.equal(dataStart(series), '2025-09-01');
  assert.equal(dataStart({ events: {}, sales: [] }), '');
  assert.equal(metricFirstDay(series, metricById('revenue'), 'week'), '2025-09-01');
  assert.equal(metricFirstDay(series, metricById('plus'), 'week'), '2026-10-07');
  assert.equal(metricFirstDay(series, metricById('devices'), 'year'), '2026-01-01');
});

test('all years start at the first year with data', () => {
  assert.equal(yearsToShow(series, '2026-10-08'), 2);
  assert.equal(yearsToShow({ from: '2025-01-01', to: '2026-10-08', events: { landing_viewed: { '2026-03-01': 1 } }, sales: [] }, '2026-10-08'), 1);
  assert.equal(yearsToShow({ events: {}, sales: [] }, '2026-10-08'), 1);
});

test('funnels give step and overall rates from independent counts', () => {
  const ranges = comparisonRanges('week', '2026-10-08');
  const teamGift = FUNNELS.find(funnel => funnel.id === 'team-gift');
  assert.deepEqual(funnelSteps(series, teamGift, ranges.current).map(step => step.value), [40, 16, 8, 3, 1]);
  const steps = funnelSteps(series, teamGift, ranges.current);
  assert.equal(steps[0].fromPrevious, null);
  assert.equal(steps[1].fromPrevious, 0.4);
  assert.equal(steps[4].fromFirst, 1 / 40);
  const plus = FUNNELS.find(funnel => funnel.id === 'plus');
  const plusSteps = funnelSteps(series, plus, ranges.current);
  assert.deepEqual(plusSteps.map(step => step.value), [10, 2, 5]);
  assert.equal(plusSteps[2].fromPrevious, 2.5, 'can pass 100%: Plus also unlocks from gifts and licences');
  const overall = funnelOverall(series, teamGift, ranges);
  assert.equal(overall.current, 1 / 40);
  const planner = FUNNELS.find(funnel => funnel.id === 'planner');
  assert.equal(planner.steps[planner.outcome].events[0], 'onboarding_completed', 'closed days come from every planner, not only new ones');
  assert.equal(funnelOverall(series, planner, ranges).current, 0, 'no onboarding counted in the test data');
  assert.equal(overall.previous, 0, 'visits but no sale the week before');
  assert.deepEqual(funnelOverall({ events: {}, sales: [] }, plus, ranges), { current: null, previous: null });
});

test('section usage is a share of active days, most used first', () => {
  const ranges = comparisonRanges('week', '2026-10-08');
  const rows = sectionUsage(series, ranges);
  assert.equal(rows.length, SECTION_EVENTS.length);
  assert.deepEqual(rows.slice(0, 3).map(row => row.name), ['week_view_opened', 'search_opened', 'print_used']);
  const search = rows.find(row => row.name === 'search_opened');
  assert.equal(search.share, 16 / 80);
  assert.equal(search.previousShare, 8 / 80);
  assert.ok(Math.abs(search.changePts - 10) < 1e-9);
  const horizon = rows.find(row => row.name === 'horizon_opened');
  assert.equal(horizon.share, 0);
  const empty = sectionUsage({ events: {} }, ranges);
  assert.ok(empty.every(row => row.share === null && row.changePts === null));
  assert.deepEqual(empty.map(row => row.name), [...SECTION_EVENTS], 'stable order without data');

  const installs = installUsage(series, ranges);
  assert.deepEqual(installs.accepted, { current: 2, previous: 1 });
  assert.equal(installs.installedShare.current, 0.25);
});

test('the series window and answer are checked before use', () => {
  assert.deepEqual(seriesWindow('2026-10-11'), { from: '2025-01-01', to: '2026-10-11' });
  assert.equal(normalizeSeries(null), null);
  assert.equal(normalizeSeries({ error: 'Not found' }), null);
  assert.equal(normalizeSeries({ events: {}, to: 'soon' }), null);
  const clean = normalizeSeries({ from: '2025-01-01', to: '2026-10-11', events: {}, sales: [{ day: '2026-10-01' }, { day: 'bad' }, null], salesUnavailable: true });
  assert.deepEqual(clean, { from: '2025-01-01', to: '2026-10-11', events: {}, sales: [{ day: '2026-10-01' }], salesUnavailable: true });
});
