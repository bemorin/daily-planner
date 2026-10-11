import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__DAILY_PLANNER_CONFIG__ = { PLANNER_API_URL: '' };
const { PLAN_PARTS, paintRows, planCaption, planPreview, recentWeeks, renderPaletteTry, renderPaintStrip, renderPlanRail, sampleRows } = await import('../src/features/plus-previews.js');
const { checkoutHref } = await import('../src/features/plus-dialog.js');

test('the plan preview reads which parts of the year are already set', () => {
  assert.deepEqual(PLAN_PARTS.map(part => part.id), ['lookback', 'misogi', 'milestones', 'adventures', 'commitments', 'habits', 'keydates']);
  const blank = planPreview(null);
  assert.equal(blank.set, 0);
  assert.equal(blank.total, 7);
  assert.match(planCaption(blank), /blank year/);
  const some = planPreview({ year: 2027, misogi: { text: 'Ride the Pyrenees' }, steps: { misogi: true, milestones: true, adventures: false } });
  assert.equal(some.set, 2);
  assert.equal(some.next, 'Look back');
  assert.equal(some.misogi, 'Ride the Pyrenees');
  assert.equal(planCaption(some), '2 of 7 parts of 2027 already set. Next: look back.');
  const all = planPreview({ year: 2027, steps: Object.fromEntries(PLAN_PARTS.map(part => [part.id, true])) });
  assert.match(planCaption(all), /Every part of 2027 is set/);
  assert.match(renderPlanRail(some), /Ride the Pyrenees/);
  assert.equal((renderPlanRail(some).match(/is-set/g) || []).length, 2);
});

function model(closedKeys, year = 2026) {
  const months = Array.from({ length: 12 }, (_, month) => ({ month, days: Array.from({ length: new Date(year, month + 1, 0).getDate() }, (__, index) => {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`;
    const closed = closedKeys.includes(key);
    const weekday = new Date(year, month, index + 1).getDay();
    return { key, closed, level: closed ? 2 : 0, planning: weekday > 0 && weekday < 6, future: key > `${year}-10-07`, before: key < `${year}-10-01`, today: key === `${year}-10-07`, joker: false };
  }) }));
  return { year, months, closed: closedKeys.length };
}

test('the painted year preview uses real days, or a sample when there are too few', () => {
  const few = paintRows(model(['2026-10-01']));
  assert.equal(few.sample, true);
  assert.equal(few.rows.length, 12);
  assert.ok(few.rows.flat().some(code => code === 1 || code === 2 || code === 3), 'the sample paints something');
  assert.deepEqual(sampleRows(2026), sampleRows(2026), 'the same sample every time');
  const real = paintRows(model(['2026-10-01', '2026-10-02', '2026-10-05']));
  assert.equal(real.sample, false);
  assert.equal(real.closed, 3);
  assert.equal(real.rows[9][0], 2, 'closed with the main outcome done');
  assert.equal(real.rows[9][5], 'x', 'a planning day left open');
  assert.equal(real.rows[9][3], '', 'a weekend');
  assert.equal(real.rows[9][20], '', 'the future');
  assert.match(renderPaintStrip(real, { year: 2026 }), /Your 2026/);
  assert.match(renderPaintStrip(few), /A sample year/);
});

test('the palette preview shows the latest weeks, one swatch per palette', () => {
  const weeks = recentWeeks(paintRows(model(['2026-10-01', '2026-10-02', '2026-10-05'])).rows, { weeks: 4, year: 2026, today: new Date(2026, 9, 7, 12) });
  assert.equal(weeks.length, 4);
  assert.deepEqual(weeks[3], [2, 'x', ''], 'the current week, Monday to today');
  assert.deepEqual(weeks[2].slice(3, 5), [2, 2], 'last Thursday and Friday');
  const html = renderPaletteTry(weeks, { current: 'ocean' });
  assert.equal((html.match(/data-plus-palette="/g) || []).length, 6);
  assert.match(html, /hz-palette--ocean" data-plus-palette-grid/);
});

test('Get Plus only sends the browser to a web checkout or a page of this site', () => {
  assert.equal(checkoutHref('https://checkout.creem.io/ch_123'), 'https://checkout.creem.io/ch_123');
  assert.equal(checkoutHref('http://localhost:8094/__fake-creem/pay?checkout=ch_fake_1'), 'http://localhost:8094/__fake-creem/pay?checkout=ch_fake_1');
  assert.equal(checkoutHref('/__fake-creem/pay?checkout=ch_fake_1'), '/__fake-creem/pay?checkout=ch_fake_1');
  assert.equal(checkoutHref('javascript:alert(1)'), '');
  assert.equal(checkoutHref('//evil.example/pay'), '');
  assert.equal(checkoutHref(''), '');
});
