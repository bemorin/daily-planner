import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__DAILY_PLANNER_CONFIG__ = { PLANNER_API_URL: '' };
const { PAGE_SIZE, PLAN_PARTS, paintRows, paperScale, planPreview, recentWeeks, renderPaletteTry, renderPaper, renderPlanSession, sampleRows } = await import('../src/features/plus-previews.js');
const { checkoutHref } = await import('../src/features/plus-dialog.js');

test('the plan preview reads which parts of the year are already set', () => {
  assert.deepEqual(PLAN_PARTS.map(part => part.id), ['lookback', 'misogi', 'milestones', 'adventures', 'commitments', 'habits', 'keydates']);
  const blank = planPreview(null);
  assert.equal(blank.set, 0);
  assert.equal(blank.total, 7);
  assert.equal(blank.misogi, '');
  const some = planPreview({ year: 2027, misogi: { text: ' Ride the Pyrenees ', when: '12–19 Jun' }, steps: { misogi: true, milestones: true, adventures: false } });
  assert.equal(some.set, 2);
  assert.equal(some.next, 'Look back');
  assert.equal(some.misogi, 'Ride the Pyrenees');
  assert.equal(some.when, '12–19 Jun');
});

test('the guided session preview asks the Misogi question and ticks the parts already set', () => {
  const blank = renderPlanSession(planPreview(null), { year: 2027 });
  assert.match(blank, /What one challenge would define 2027\?/);
  assert.match(blank, /plus-session__field is-placeholder/, 'an empty Misogi shows the placeholder');
  assert.match(blank, /Put it on the calendar/);
  assert.match(blank, /aria-hidden="true"/, 'decorative: the caption says the same');
  assert.equal((blank.match(/plus-session__part /g) || []).length, 8, 'seven parts and the summary');
  const some = renderPlanSession(planPreview({ year: 2027, misogi: { text: 'Ride <the> Pyrenees', when: '12–19 Jun' }, steps: { misogi: true, milestones: true } }), { year: 2027 });
  assert.match(renderPlanSession(planPreview({ misogi: { text: 'Ride', why: 'To see if I can' } }), { year: 2027 }), /plus-session__why"><span>To see if I can/);
  assert.match(some, /Ride &lt;the&gt; Pyrenees/, 'escaped');
  assert.doesNotMatch(some, /plus-session__field is-placeholder/, 'their Misogi, not the placeholder');
  assert.match(some, /plus-session__why is-placeholder/, 'no why yet');
  assert.match(some, /plus-session__chip has-value[^>]*>.*12–19 Jun/);
  assert.equal((some.match(/ is-set/g) || []).length, 2);
  assert.match(some, /2 of 7 parts set/);
});

test('a printed page sits on an A4 sheet scaled to fit its box', () => {
  assert.equal(Math.round(PAGE_SIZE.width), 1123);
  assert.equal(Math.round(PAGE_SIZE.height), 794);
  assert.equal(paperScale(PAGE_SIZE.width / 2, 10000), 0.5, 'limited by the width');
  assert.equal(paperScale(10000, PAGE_SIZE.height / 4), 0.25, 'limited by the height');
  assert.equal(paperScale(5000, 5000), 1, 'never above the printed size…');
  assert.equal(paperScale(5000, Infinity, { max: 1.35 }), 1.35, '…unless asked (the enlarged page)');
  assert.equal(paperScale(0, 300), 0, 'no box, no scale');
  const html = renderPaper('<header class="print-sheet-head">x</header>', { kind: 'year', palette: 'ocean' });
  assert.match(html, /data-plus-paper="year"/);
  assert.match(html, /plus-paper__page plus-paper--ocean" inert aria-hidden="true"/, 'the page is decoration: not focusable, not read');
  assert.match(html, /<section class="print-sheet print-sheet--year"><header class="print-sheet-head">x<\/header><\/section>/, 'the print sheet as printing builds it');
  assert.match(renderPaper('', { kind: 'review', zoom: true }), /plus-paper plus-paper--zoom/);
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

test('the painted weeks use real days, or a sample when there are too few', () => {
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
});

test('the palette preview shows the latest weeks, one swatch per palette', () => {
  const weeks = recentWeeks(paintRows(model(['2026-10-01', '2026-10-02', '2026-10-05'])).rows, { weeks: 4, year: 2026, today: new Date(2026, 9, 7, 12) });
  assert.equal(weeks.length, 4);
  assert.deepEqual(weeks[3], [2, 'x', ''], 'the current week, Monday to today');
  assert.deepEqual(weeks[2].slice(3, 5), [2, 2], 'last Thursday and Friday');
  const html = renderPaletteTry(weeks, { current: 'ocean' });
  assert.equal((html.match(/data-plus-palette="/g) || []).length, 6);
  assert.match(html, /hz-palette--ocean" data-plus-palette-grid/);
  assert.match(html, /data-plus-palette-name aria-hidden="true">Ocean</);
});

test('Get Plus only sends the browser to a web checkout or a page of this site', () => {
  assert.equal(checkoutHref('https://checkout.creem.io/ch_123'), 'https://checkout.creem.io/ch_123');
  assert.equal(checkoutHref('http://localhost:8094/__fake-creem/pay?checkout=ch_fake_1'), 'http://localhost:8094/__fake-creem/pay?checkout=ch_fake_1');
  assert.equal(checkoutHref('/__fake-creem/pay?checkout=ch_fake_1'), '/__fake-creem/pay?checkout=ch_fake_1');
  assert.equal(checkoutHref('javascript:alert(1)'), '');
  assert.equal(checkoutHref('//evil.example/pay'), '');
  assert.equal(checkoutHref(''), '');
});
