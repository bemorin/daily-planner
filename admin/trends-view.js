// Trends on the owner dashboard: KPI tiles for the week, month or year to
// date against the same days of the period before, a larger chart for the
// selected tile, conversion funnels and usage by section. All counting lives
// in ./trends.js; this file only turns it into markup (every value escaped).

import {
  TREND_METRICS, FUNNELS, metricById, metricTrend, change, comparisonRanges, funnelSteps, funnelOverall,
  sectionUsage, installUsage, saleCurrencies, yearsToShow, PERIODS
} from './trends.js';
import { columnChart, sparklineHtml } from './charts.js';
import { slideIndicator } from '../src/ui/motion.js';

const PERIOD_KEY = 'daily-planner-owner-trends-period';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = value => new Intl.NumberFormat().format(Number(value) || 0);
const utcDate = day => new Date(`${day}T00:00:00Z`);
const dateFormat = options => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options });

function rangeText(from, to, options) {
  const format = dateFormat(options);
  if (from === to) return format.format(utcDate(from));
  try { return format.formatRange(utcDate(from), utcDate(to)); } catch (_) { return `${format.format(utcDate(from))} – ${format.format(utcDate(to))}`; }
}

function money(cents, currency, { compact = false } = {}) {
  const value = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, compact
      ? { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }
      : { style: 'currency', currency, maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
  } catch (_) {
    return `${number(value)} ${currency}`;
  }
}

/** 0.214 → "21%", 0.034 → "3.4%"; null → "—". */
function share(value) {
  if (value == null) return '—';
  const pct = value * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct >= 10 || pct === 0 ? number(Math.round(pct)) : (Math.round(pct * 10) / 10).toLocaleString()}%`;
}

const PERIOD_COPY = {
  week: { label: 'Week', now: 'This week', so: 'This week so far', before: 'last week', yearAgo: 'a year ago', history: 'last 12 weeks', count: 12, bar: 'Each bar is one ISO week, Monday to Sunday.' },
  month: { label: 'Month', now: 'This month', so: 'This month so far', before: 'last month', yearAgo: 'a year ago', history: 'last 12 months', count: 12, bar: 'Each bar is one calendar month.' },
  year: { label: 'Year', now: 'This year', so: 'This year so far', before: 'last year', yearAgo: '', history: 'all years', count: 0, bar: 'Each bar is one calendar year.' }
};

const METRIC_COPY = {
  landing: { label: () => 'Landing visits', about: () => 'Visits to the welcome page.' },
  devices: {
    label: period => (period === 'year' ? 'Active device-months' : 'Active devices'),
    about: period => (period === 'week' ? 'Devices that opened the planner during the week, each counted once.'
      : period === 'month' ? 'Devices that opened the planner during the month, each counted once.'
        : 'Each device counts once in every month it opened the planner, so a year adds up device-months, not people.')
  },
  'active-days': { label: () => 'Active days', about: () => 'Days on which a device opened the planner, one per device per day.' },
  'installed-days': { label: () => 'Installed-app days', about: () => 'Days on which a device opened the planner as the installed app.' },
  'days-closed': { label: () => 'Days closed', about: () => 'Days closed in the planner.' },
  plus: { label: () => 'Plus unlocked', about: () => 'Plus unlocked on a planner, whichever way: purchase, gift or licence.' },
  'gifts-activated': { label: () => 'Gifts activated', about: () => 'Team gift links activated on a planner.' },
  'gifts-sold': { label: () => 'Team gifts sold', about: () => 'Team gifts paid online, plus invoiced ones that have an amount.' },
  revenue: { label: () => 'Revenue', about: () => 'Plus and team gifts, paid online or invoiced with an amount. Each currency on its own: they are never added together.' }
};

const FUNNEL_COPY = {
  planner: { title: 'Landing → planner', steps: ['Landing visits', 'Clicked “Open the planner”', 'Finished onboarding', 'Closed a day (all planners)'], outcome: 'finished onboarding per landing visit' },
  'team-gift': { title: 'Team gift', steps: ['Landing visits', 'Visited the Teams page', 'Went to buy a team gift', 'Bought a team gift online'], outcome: 'gifts bought per landing visit' },
  plus: { title: 'Plus', steps: ['Saw Plus (landing or app)', 'Went to buy Plus', 'Unlocked Plus (any way)'], outcome: 'unlocks per Plus view' }
};

const SECTION_LABELS = {
  week_view_opened: 'Week view',
  horizon_opened: 'Horizon',
  progress_opened: 'Progress',
  journal_opened: 'Journal',
  unresolved_opened: 'Unresolved',
  stats_opened: 'Statistics',
  search_opened: 'Search',
  pip_opened: 'Floating window',
  print_used: 'Print'
};

/**
 * The Week · Month · Year radio group from the keyboard: the button a key
 * moves to from button `at` of `count` (the arrows wrap round; Home and End
 * go to the ends), or -1 for any other key.
 */
export function periodKeyTarget(key, at, count) {
  if (!(count > 0)) return -1;
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[key];
  if (step) return (((at + step) % count) + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

function readPeriod(storage) {
  try {
    const saved = storage?.getItem(PERIOD_KEY);
    if (PERIODS.includes(saved)) return saved;
  } catch (_) {}
  return 'week';
}

function savePeriod(storage, period) {
  try { storage?.setItem(PERIOD_KEY, period); } catch (_) {}
}

function deltaHtml(current, previous, against) {
  const result = change(current, previous);
  if (result.kind === 'new') return `<span class="trend-delta is-new" title="Nothing ${esc(against)}">New</span>`;
  if (result.kind === 'flat') return `<span class="trend-delta">${previous ? 'No change' : '—'}</span>`;
  const pct = Math.abs(result.pct);
  const text = pct < 1 ? '<1%' : `${number(Math.round(pct))}%`;
  const word = result.kind === 'up' ? 'Up' : 'Down';
  return `<span class="trend-delta"><span aria-hidden="true">${result.kind === 'up' ? '↑' : '↓'}</span><span class="sr-only">${word}</span> ${esc(text)}</span>`;
}

function pointsHtml(now, before) {
  if (now == null) return '<span class="trend-points">—</span>';
  if (before == null) return '<span class="trend-points">new</span>';
  const points = (now - before) * 100;
  if (Math.abs(points) < 0.5) return '<span class="trend-points">±0 pts</span>';
  return `<span class="trend-points">${points > 0 ? '+' : '−'}${esc(number(Math.round(Math.abs(points))))} pts</span>`;
}

/** Labels for one period of the history: the chart's x label, the tooltip title, the table's row. */
function periodLabels(period, row, today) {
  if (period === 'year') return { axis: row.key, title: row.key, table: row.key };
  if (period === 'month') {
    const date = utcDate(row.from);
    const january = row.from.slice(5, 7) === '01';
    return {
      axis: dateFormat(january ? { month: 'short', year: 'numeric' } : { month: 'short' }).format(date),
      title: dateFormat({ month: 'long', year: 'numeric' }).format(date),
      table: dateFormat({ month: 'long', year: 'numeric' }).format(date)
    };
  }
  const week = Number(row.key.slice(-2));
  const span = rangeText(row.from, row.current ? today : row.to, { day: 'numeric', month: 'short' });
  return { axis: dateFormat({ day: 'numeric', month: 'short' }).format(utcDate(row.from)), title: `Week ${week} · ${span}`, table: `Week ${week} · ${span}` };
}

export function createTrendsView(root, { storage = globalThis.localStorage } = {}) {
  const caption = root.querySelector('[data-trends-caption]');
  const body = root.querySelector('[data-trends-body]');
  const switches = [...root.querySelectorAll('[data-trends-period]')];
  const group = switches[0]?.closest('[role="radiogroup"]') || null;
  const indicator = root.querySelector('[data-trends-indicator]');
  let period = readPeriod(storage);
  let metricId = 'landing';
  let tableView = false;
  let series = null;
  let charts = [];

  const destroyCharts = () => { charts.forEach(chart => chart.destroy()); charts = []; };

  // Week · Month · Year: a radio group whose raised pill slides to the period
  // chosen, like the planner's Day · Week · Horizon (src/ui/motion.js: it
  // simply moves with reduced motion). Before the pill has measured itself
  // (the dashboard starts hidden), the chosen button carries the look.
  function placeIndicator(animate) {
    const active = switches.find(button => button.dataset.trendsPeriod === period);
    if (indicator && active?.offsetWidth) slideIndicator(indicator, active, { animateMove: animate });
  }

  function syncSwitch({ animate = false } = {}) {
    switches.forEach(button => {
      const on = button.dataset.trendsPeriod === period;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
    });
    placeIndicator(animate);
  }

  function choosePeriod(next) {
    if (!PERIODS.includes(next) || next === period) return;
    period = next;
    savePeriod(storage, period);
    syncSwitch({ animate: true });
    render();
  }

  function currencies() { return saleCurrencies(series.sales); }

  function trendOf(metric) {
    const count = period === 'year' ? yearsToShow(series, series.to) : PERIOD_COPY[period].count;
    return metricTrend(series, metric, period, series.to, { count, currencies: currencies() });
  }

  function captionText(ranges) {
    const copy = PERIOD_COPY[period];
    const withYear = period === 'year' || ranges.previous.from.slice(0, 4) !== series.to.slice(0, 4);
    const options = period === 'week' ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) };
    const now = rangeText(ranges.current.from, ranges.current.to, options);
    const before = rangeText(ranges.previous.from, ranges.previous.to, { ...options, ...(withYear ? { year: 'numeric' } : {}) });
    const yearAgo = ranges.lastYear ? ` Where counts exist, also the same days ${copy.yearAgo} (${rangeText(ranges.lastYear.from, ranges.lastYear.to, { ...options, year: 'numeric' })}).` : '';
    return `${copy.so} (${now}), compared with the same days ${copy.before} (${before}).${yearAgo} Anonymous counts per UTC day.`;
  }

  const shortDate = day => dateFormat({ day: 'numeric', month: 'short', ...(day.slice(0, 4) !== series.to.slice(0, 4) ? { year: 'numeric' } : {}) }).format(utcDate(day));

  function tileHtml(metric) {
    const copy = PERIOD_COPY[period];
    const trend = trendOf(metric);
    // Counting began part-way through the period compared with: say so beside it.
    const partly = trend.previousPartial ? ` · counted from ${shortDate(trend.firstDay)}` : '';
    const label = METRIC_COPY[metric.id].label(period);
    const selected = metric.id === metricId;
    const head = `<span class="trend-tile__label">${esc(label)}</span>`;
    const open = `<button type="button" class="trend-tile${selected ? ' is-selected' : ''}" data-trend-metric="${esc(metric.id)}" aria-pressed="${selected}" aria-controls="owner-trend-detail">`;
    if (metric.revenue || metric.sales) {
      if (series.salesUnavailable && !series.sales.length) return `${open}${head}<span class="trend-tile__figure"><strong>—</strong></span><span class="trend-tile__note">Run migration 0004 to see sales.</span></button>`;
    }
    if (metric.revenue) {
      const codes = currencies();
      if (!codes.length) return `${open}${head}<span class="trend-tile__figure"><strong>—</strong></span><span class="trend-tile__note">No sales with an amount yet.</span></button>`;
      const rows = codes.map(code => `<span class="trend-tile__money"><strong>${esc(money(trend.current[code], code))}</strong>${deltaHtml(trend.current[code], trend.previous[code], copy.before)}<span class="trend-tile__note">vs ${esc(money(trend.previous[code], code))}${esc(partly)}${trend.lastYear ? ` · ${esc(money(trend.lastYear[code], code))} ${esc(copy.yearAgo)}` : ''}</span></span>`).join('');
      const spark = codes.length === 1 ? sparklineHtml(trend.history.map(row => row.value[codes[0]] || 0)) : '';
      return `${open}${head}<span class="trend-tile__monies">${rows}</span>${spark}</button>`;
    }
    const yearAgo = trend.lastYear != null ? `<span class="trend-tile__note">${esc(number(trend.lastYear))} ${esc(copy.yearAgo)}</span>` : '';
    return `${open}${head}<span class="trend-tile__figure"><strong>${esc(number(trend.current))}</strong>${deltaHtml(trend.current, trend.previous, copy.before)}</span>
      <span class="trend-tile__note">vs ${esc(number(trend.previous))} ${esc(copy.before)}${esc(partly)}</span>${yearAgo}${sparklineHtml(trend.history.map(row => row.value))}</button>`;
  }

  function detailTable(metric, trend, labels) {
    const codes = metric.revenue ? currencies() : [];
    const head = metric.revenue ? codes.map(code => `<th class="num">${esc(code)}</th>`).join('') : `<th class="num">${esc(METRIC_COPY[metric.id].label(period))}</th>`;
    const cells = row => (metric.revenue ? codes.map(code => `<td class="num">${esc(money(row.value[code], code))}</td>`).join('') : `<td class="num">${esc(number(row.value))}</td>`);
    const rows = [...trend.history].reverse().map((row, index) => {
      const label = labels[trend.history.length - 1 - index].table;
      return `<tr><td>${esc(label)}${row.current ? ' <span class="owner-small trend-inline">so far</span>' : ''}</td>${cells(row)}</tr>`;
    }).join('');
    return `<div class="owner-scroll"><table class="owner-table trend-table"><thead><tr><th>${esc(PERIOD_COPY[period].label)}</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderDetail(host) {
    destroyCharts();
    const metric = metricById(metricId) || TREND_METRICS[0];
    const trend = trendOf(metric);
    const copy = PERIOD_COPY[period];
    const label = METRIC_COPY[metric.id].label(period);
    const labels = trend.history.map(row => periodLabels(period, row, series.to));
    const shown = trend.history[0];
    const started = trend.firstDay && trend.firstDay > shown.from
      ? `<p class="owner-hint">First counted on ${esc(dateFormat({ day: 'numeric', month: 'short', year: 'numeric' }).format(utcDate(trend.firstDay)))}, so earlier ${esc(period === 'week' ? 'weeks' : period === 'month' ? 'months' : 'years')} are partial or empty.</p>`
      : '';
    const codes = metric.revenue ? currencies() : [];
    const empty = metric.revenue && !codes.length;
    host.innerHTML = `<header class="owner-card__head"><div><h2 id="owner-trend-detail-title">${esc(label)} <span class="trend-detail__span">· ${esc(copy.history)}</span></h2>
        <p>${esc(METRIC_COPY[metric.id].about(period))} ${esc(copy.bar)} The last one, ${esc(copy.now.toLowerCase())} so far, is shown in a softer shade.</p></div>
        <div class="owner-card__tools"><button class="secondary-button trend-table-toggle" type="button" data-trend-table aria-pressed="${tableView}"${empty ? ' disabled' : ''}>${tableView ? 'Chart view' : 'Table view'}</button></div></header>
      <div class="trend-detail__body" data-trend-detail-body></div>${started}`;
    const target = host.querySelector('[data-trend-detail-body]');
    if (empty) { target.innerHTML = '<p class="owner-empty">No sales with an amount yet.</p>'; return; }
    if (tableView) { target.innerHTML = detailTable(metric, trend, labels); return; }
    const rowsFor = pick => trend.history.map((row, index) => ({
      label: labels[index].axis,
      value: pick(row),
      partial: row.current,
      tipTitle: labels[index].title,
      tipLines: row.current ? ['So far'] : []
    }));
    if (metric.revenue) {
      target.innerHTML = codes.map(code => `<div class="trend-multiple"><h3>${esc(code)}</h3><div data-trend-chart="${esc(code)}"></div></div>`).join('');
      codes.forEach(code => {
        charts.push(columnChart(target.querySelector(`[data-trend-chart="${code}"]`), {
          rows: rowsFor(row => row.value[code] || 0),
          format: value => money(value, code),
          formatAxis: value => money(value, code, { compact: true }),
          label: `${label} in ${code}, ${copy.history}`
        }));
      });
      return;
    }
    target.innerHTML = '<div data-trend-chart></div>';
    charts.push(columnChart(target.querySelector('[data-trend-chart]'), {
      rows: rowsFor(row => row.value),
      format: value => number(value),
      formatAxis: value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value),
      label: `${label}, ${copy.history}`
    }));
  }

  function funnelHtml(funnel, ranges) {
    const copy = FUNNEL_COPY[funnel.id];
    const steps = funnelSteps(series, funnel, ranges.current);
    const overall = funnelOverall(series, funnel, ranges);
    const max = Math.max(1, ...steps.map(step => step.value));
    // Stages up to the outcome take the ordinal ramp; a step after it is context, in grey.
    const outcome = funnel.outcome ?? steps.length - 1;
    const tones = steps.map((_, index) => (index > outcome ? 'trend-funnel__bar--context' : `trend-tone-${outcome ? Math.round(index * 4 / outcome) + 1 : 5}`));
    const rows = steps.map((step, index) => `<li class="trend-funnel__row">
        <span class="trend-funnel__label">${esc(copy.steps[index])}</span>
        <span class="trend-funnel__value">${esc(number(step.value))}${index ? `<small>${esc(share(step.fromPrevious))}<span class="sr-only"> of the step before</span></small>` : ''}</span>
        <span class="trend-funnel__track" aria-hidden="true"><span class="trend-funnel__bar ${tones[index]}" style="width:${step.value ? Math.max(1, Math.min(100, Math.round(step.value / max * 100))) : 0}%"></span></span>
      </li>`).join('');
    const before = overall.previous == null ? `nothing ${PERIOD_COPY[period].before}` : `${share(overall.previous)} ${PERIOD_COPY[period].before}`;
    return `<div class="trend-funnel"><h3>${esc(copy.title)}</h3>
      <p class="trend-funnel__overall"><strong>${esc(share(overall.current))}</strong> ${esc(copy.outcome)} · ${esc(before)}</p>
      <ol class="trend-funnel__steps">${rows}</ol></div>`;
  }

  function usageHtml(ranges) {
    const copy = PERIOD_COPY[period];
    const rows = sectionUsage(series, ranges);
    const installs = installUsage(series, ranges);
    const hasDays = rows.some(row => row.share != null);
    // An absolute 0–100% track: a share reads as a share, not against the busiest section.
    const scale = value => Math.min(100, Math.round((value || 0) * 1000) / 10);
    const list = hasDays
      ? `<ul class="trend-usage__list">${rows.map(row => `<li class="trend-usage__row">
          <span class="trend-usage__label">${esc(SECTION_LABELS[row.name] || row.name)}</span>
          <span class="trend-usage__track" aria-hidden="true"><span class="trend-usage__bar" style="width:${scale(row.share)}%"></span>${row.previousShare != null ? `<span class="trend-usage__tick" style="left:${scale(row.previousShare)}%"></span>` : ''}</span>
          <span class="trend-usage__share">${esc(share(row.share))}<span class="sr-only"> of active days, ${esc(number(row.count))} days; ${esc(copy.before)} ${esc(share(row.previousShare))}</span></span>
          ${pointsHtml(row.share, row.previousShare)}
        </li>`).join('')}</ul>
        <p class="trend-legend" aria-hidden="true"><span class="trend-legend__bar"></span>${esc(copy.so)}<span class="trend-legend__tick"></span>Same days ${esc(copy.before)}</p>`
      : `<p class="owner-empty">No active days were counted ${esc(copy.now.toLowerCase())} yet. Section usage appears once planners report it (version 1.21 and later).</p>`;
    const installed = installs.installedShare;
    return `<div class="trend-usage">
      <div class="trend-usage__main">${list}</div>
      <div class="trend-usage__side">
        <div class="owner-stat"><span>Installs from the prompt</span><strong>${esc(number(installs.accepted.current))}</strong><small>${deltaHtml(installs.accepted.current, installs.accepted.previous, copy.before)} vs ${esc(number(installs.accepted.previous))} ${esc(copy.before)}</small></div>
        <div class="owner-stat"><span>Days in the installed app</span><strong>${esc(share(installed.current))}</strong><small>of active days · ${pointsHtml(installed.current, installed.previous)} vs ${esc(share(installed.previous))} ${esc(copy.before)}</small></div>
      </div>
    </div>`;
  }

  function render() {
    syncSwitch();
    destroyCharts();
    if (!series) return;
    const ranges = comparisonRanges(period, series.to);
    const copy = PERIOD_COPY[period];
    caption.textContent = captionText(ranges);
    body.innerHTML = `<div class="trend-tiles">${TREND_METRICS.map(tileHtml).join('')}</div>
      <section class="owner-card trend-detail" id="owner-trend-detail" aria-labelledby="owner-trend-detail-title" data-trend-detail></section>
      <section class="owner-card" aria-labelledby="owner-funnels-title">
        <header><h2 id="owner-funnels-title">Conversion <span class="trend-detail__span">· ${esc(copy.so.toLowerCase())}</span></h2><p>Each step is an anonymous count taken on its own, not people followed from step to step, so the rates are indicative and can pass 100%. The small figure beside a count is its share of the step before.</p></header>
        <div class="trend-funnels">${FUNNELS.map(funnel => funnelHtml(funnel, ranges)).join('')}</div>
      </section>
      <section class="owner-card" aria-labelledby="owner-usage-title">
        <header><h2 id="owner-usage-title">Usage by section <span class="trend-detail__span">· ${esc(copy.so.toLowerCase())}</span></h2><p>Share of active days (a device opening the planner on a day) on which each part was used, counted once per device per day. Changes are in percentage points.</p></header>
        ${usageHtml(ranges)}
      </section>`;
    renderDetail(body.querySelector('[data-trend-detail]'));
  }

  switches.forEach(button => button.addEventListener('click', () => choosePeriod(button.dataset.trendsPeriod)));
  // The arrows (and Home, End) move the choice, and the focus with it; Tab leaves the group.
  group?.addEventListener('keydown', event => {
    const at = Math.max(0, switches.indexOf(event.target.closest('[data-trends-period]')));
    const target = periodKeyTarget(event.key, at, switches.length);
    if (target < 0) return;
    event.preventDefault();
    switches[target].focus();
    choosePeriod(switches[target].dataset.trendsPeriod);
  });
  // The pill measures itself once the dashboard is shown, and again whenever the group changes width.
  if (group && typeof ResizeObserver === 'function') new ResizeObserver(() => placeIndicator(false)).observe(group);

  body.addEventListener('click', event => {
    const tile = event.target.closest('[data-trend-metric]');
    if (tile) {
      metricId = tile.dataset.trendMetric;
      body.querySelectorAll('[data-trend-metric]').forEach(item => {
        const selected = item === tile;
        item.classList.toggle('is-selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      renderDetail(body.querySelector('[data-trend-detail]'));
      return;
    }
    const toggle = event.target.closest('[data-trend-table]');
    if (toggle) {
      tableView = !tableView;
      renderDetail(body.querySelector('[data-trend-detail]'));
      body.querySelector('[data-trend-table]')?.focus();
    }
  });

  syncSwitch();
  return {
    /** Show the series (normalized by trends.js) */
    show(next) {
      series = next;
      root.classList.remove('is-refreshing');
      root.removeAttribute('aria-busy');
      render();
    },
    /** Hold the current render, dimmed, while a refresh is on its way. */
    refreshing() {
      if (!series) return;
      root.classList.add('is-refreshing');
      root.setAttribute('aria-busy', 'true');
    },
    unavailable(message) {
      series = null;
      destroyCharts();
      root.classList.remove('is-refreshing');
      root.removeAttribute('aria-busy');
      caption.textContent = '';
      body.innerHTML = `<p class="owner-empty">${esc(message)}</p>`;
    },
    clear() {
      series = null;
      destroyCharts();
      root.classList.remove('is-refreshing');
      root.removeAttribute('aria-busy');
      caption.textContent = '';
      body.innerHTML = '<p class="owner-checking">Loading trends…</p>';
    }
  };
}
