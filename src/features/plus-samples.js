import { addDaysKey, atNoon, ymdKey } from '../lib/dates.js';
import { defaultCategories } from '../config.js';
import { rangeLabel } from './horizon-model.js';
import { TROPHIES } from './progress-model.js';
import { buildYearPrintModel } from './year-print.js';
import { buildQuarterReview, defaultCheckInQuarter, previousQuarter } from './quarter-review.js';

/**
 * Sample years for the Daily Planner Plus dialog, shown when the person has
 * nothing of their own to preview yet: a planned year (the same one the
 * landing page shows: the Camino de Santiago, six mini-adventures, three
 * commitments, a habit per quarter, three key dates), a quarter check-in and
 * a year in review. Pure data, run through the real print renderers
 * (year-print.js, quarter-print.js, year-review.js) by the dialog; unit-tested.
 */

/** Below this many closed days this year, "Look back" shows the sample review. */
export const REVIEW_SAMPLE_BELOW = 20;
/** Below this many closed days in a quarter, "Check in" looks at an earlier quarter, then at the sample. */
export const QUARTER_SAMPLE_BELOW = 10;

/** The parts of a plan that appear on the printed year (the look back doesn't). */
const PRINTED_PARTS = ['misogi', 'milestones', 'adventures', 'commitments', 'habits', 'keydates'];

/** True when planSummary() has at least one part that prints: the person's own year map is worth showing. */
export function hasPrintablePlan(summary) {
  const steps = summary?.steps || {};
  return PRINTED_PARTS.some(id => !!steps[id]);
}

/** True when this year has enough closed days for the person's own review. */
export function hasOwnReview(progress, { below = REVIEW_SAMPLE_BELOW } = {}) {
  return (Number(progress?.closed) || 0) >= below;
}

const key = (year, month, day) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// [text, [month, day], [month, day]?] — months are 0-based.
const PLAN = {
  misogi: ['Walk the Camino de Santiago', [4, 3], [4, 31]],
  milestones: [['Book the flights', [1, 2]], ['Walk 100 km in one week', [2, 21]], ['Test the gear on a weekend', [3, 11]]],
  adventures: [['Sleep in a mountain hut', [6, 11], [6, 12]], ['Swim before 8am', [5, 6]], ['Cook for twelve people', [10, 28]], ['Learn to sail', [7, 8], [7, 9]], ['A night under the stars', [8, 18]], ['A day without a phone']],
  commitments: ['Home for dinner four nights a week', 'Read one book a month', 'Fewer projects, done better'],
  habits: ['Walk after lunch', 'No phone in the bedroom', 'Write three lines', 'Stretch before bed'],
  keyDates: [['Team offsite in Lisbon', [2, 9], [2, 11]], ['Sam’s wedding', [5, 20]], ['Summer break', [7, 2], [7, 20]]]
};

/** The sample plan as Horizon year data for `year` (the shape horizonYearData() returns). */
export function sampleYearData(year) {
  const [misogi, start, end] = PLAN.misogi;
  return {
    misogi,
    misogiWhy: '',
    misogiStartDate: key(year, ...start),
    misogiEndDate: key(year, ...end),
    misogiDone: false,
    misogiMilestones: PLAN.milestones.map(([text, [month, day]], index) => ({ id: `sample-milestone-${index + 1}`, text, date: key(year, month, day), done: false })),
    meaningful: [...PLAN.commitments],
    meaningfulMeta: [{}, {}, {}],
    miniAdventures: PLAN.adventures.map(([text, from, to], index) => ({ id: `sample-adventure-${index + 1}`, text, startDate: from ? key(year, ...from) : '', endDate: to ? key(year, ...to) : '', status: from ? 'planned' : 'idea', done: false })),
    habits: [...PLAN.habits],
    habitStartedAt: ['', '', '', ''],
    habitChecks: {},
    months: {}
  };
}

/** The sample key dates for `year`, as horizonYearKeyDates() lists them. */
export function sampleKeyDates(year) {
  return PLAN.keyDates.map(([text, [month, day], to], index) => ({ id: `sample-keydate-${index + 1}`, text, startDate: key(year, month, day), endDate: to ? key(year, ...to) : '', ownerMonth: month }));
}

/** The printed sample year: a plan just made, nothing done or painted yet. */
export function samplePrintModel(year, { weekStartsOn = 1 } = {}) {
  return buildYearPrintModel({ year, data: sampleYearData(year), keyDates: sampleKeyDates(year), weekStartsOn, progress: null, today: new Date(year - 1, 11, 31, 12) });
}

// ---------------------------------------------------------------------------
// A sample year in review: someone who started closing days in March
// ---------------------------------------------------------------------------

const SAMPLE_CLOSED = 190;
const SAMPLE_STREAK = 34;
const HOURS = { 'deep-work': 412, admin: 236, personal: 168, health: 121, learning: 64 };
// Horizon trophies carry no date, so they list last, as in a real review: the Misogi, accomplished, closes the year.
const SAMPLE_TROPHIES = ['close-1', 'close-10', 'close-50', 'close-100', 'streak-5', 'streak-20', 'mit-30', 'lessons-10', 'habit-30', 'misogi-named', 'adventure-1', 'commitments-3', 'misogi-milestones', 'misogi-done'];
const REVIEW_HORIZON = {
  misogi: ['Run a marathon', [9, 4]],
  milestones: ['Run 10 km without stopping', 'A half marathon in June', '30 km in training'],
  adventures: [['Sleep in a mountain hut', [2, 14], true], ['Swim in the sea in April', [3, 18], true], ['Learn to make bread', null, true], ['Kayak to the island', [6, 25], true], ['Cook for twelve people', [10, 21], true], ['See the northern lights', null, false]],
  commitments: ['Read at the start of each month', 'Home for dinner four nights a week', 'One project at a time'],
  habits: [['Walk after lunch', 81], ['No phone in the bedroom', 74], ['Write three lines', 66], ['Stretch before bed', 38]],
  memories: [['A night in the mountain hut', [2, 14]], ['Crossing the finish line with Sam', [8, 27]]],
  lessons: [['A rough draft beats a blank page', [4, 12]], ['Short runs still count', [9, 9]]]
};

const firstMonday = (year, month) => { const date = new Date(year, month, 1, 12); while (date.getDay() !== 1) date.setDate(date.getDate() + 1); return date; };

/** The painted sample year: weekdays from the first Monday of March, 190 of them closed, one run of 34 in the autumn. */
function samplePaint(year) {
  let seed = 4127;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const startKey = ymdKey(firstMonday(year, 2));
  const streakStart = ymdKey(firstMonday(year, 8));
  const weekdays = [];
  for (let day = atNoon(new Date(year, 0, 1)); day.getFullYear() === year; day.setDate(day.getDate() + 1)) {
    const weekday = day.getDay();
    if (weekday > 0 && weekday < 6 && ymdKey(day) >= startKey) weekdays.push(ymdKey(day));
  }
  const streakFrom = weekdays.indexOf(streakStart);
  const inStreak = index => index >= streakFrom && index < streakFrom + SAMPLE_STREAK;
  // The open days: the lowest draws outside the run; the first one or two of a month use a joker.
  const draws = weekdays.map((dayKey, index) => ({ dayKey, index, roll: index === 0 || inStreak(index) ? 2 : random() }));
  const open = new Set(draws.slice().sort((a, b) => a.roll - b.roll).slice(0, Math.max(0, weekdays.length - SAMPLE_CLOSED)).map(item => item.dayKey));
  const jokers = new Set();
  const perMonth = new Map();
  weekdays.forEach(dayKey => {
    if (!open.has(dayKey)) return;
    const month = dayKey.slice(0, 7);
    const used = perMonth.get(month) || 0;
    if (used < 2 && random() < 0.6) { jokers.add(dayKey); perMonth.set(month, used + 1); }
  });
  const months = Array.from({ length: 12 }, (_, month) => ({ month, days: [], closed: 0, planningElapsed: 0 }));
  const closedKeys = [];
  const mitKeys = [];
  for (let day = atNoon(new Date(year, 0, 1)); day.getFullYear() === year; day.setDate(day.getDate() + 1)) {
    const dayKey = ymdKey(day);
    const weekday = day.getDay();
    const planning = weekday > 0 && weekday < 6;
    const closed = planning && dayKey >= startKey && !open.has(dayKey);
    const mitDone = closed && random() < 0.72;
    const habitKept = mitDone && random() < 0.42;
    const cell = { key: dayKey, day: day.getDate(), weekday, planning, future: false, before: dayKey < startKey, today: false, closed, mitDone, habitKept, level: closed ? 1 + (mitDone ? 1 : 0) + (habitKept ? 1 : 0) : 0, joker: jokers.has(dayKey) };
    const month = months[day.getMonth()];
    month.days.push(cell);
    if (planning && !cell.before) month.planningElapsed += 1;
    if (closed) { month.closed += 1; closedKeys.push(dayKey); if (mitDone) mitKeys.push(dayKey); }
  }
  return { months, closedKeys, mitKeys, planningElapsed: weekdays.length };
}

/** When each sample trophy was reached ('' for Horizon trophies, which carry no date). */
function trophyDates(paint, year) {
  const nth = (list, count) => list[count - 1] || '';
  return {
    'close-1': nth(paint.closedKeys, 1),
    'close-10': nth(paint.closedKeys, 10),
    'close-50': nth(paint.closedKeys, 50),
    'close-100': nth(paint.closedKeys, 100),
    'streak-5': addDaysKey(ymdKey(firstMonday(year, 2)), 4),
    'streak-20': addDaysKey(ymdKey(firstMonday(year, 8)), 25),
    'mit-30': nth(paint.mitKeys, 30),
    'lessons-10': key(year, 5, 3),
    'habit-30': key(year, 2, 30)
  };
}

/**
 * "{year}, in review" for someone else: `{ review, progress }` in the shapes
 * buildYearReview() and buildProgressModel() return, for renderYearReviewPrint().
 */
export function sampleReview(year) {
  const paint = samplePaint(year);
  const closed = paint.closedKeys.length;
  const mitDone = paint.mitKeys.length;
  const dates = trophyDates(paint, year);
  const unlocked = SAMPLE_TROPHIES.map(id => TROPHIES.find(trophy => trophy.id === id))
    .map(trophy => ({ id: trophy.id, title: trophy.title, icon: trophy.icon, group: trophy.group, unlockedOn: dates[trophy.id] || '' }))
    .sort((a, b) => String(a.unlockedOn || '9999').localeCompare(String(b.unlockedOn || '9999')));
  const categories = defaultCategories.filter(category => HOURS[category.id]);
  const total = categories.reduce((sum, category) => sum + HOURS[category.id] * 60, 0);
  const rows = categories.map(category => ({ id: category.id, name: category.name, color: category.color, minutes: HOURS[category.id] * 60, share: HOURS[category.id] * 60 / total })).sort((a, b) => b.minutes - a.minutes);
  const [misogiText, [misogiMonth, misogiDay]] = REVIEW_HORIZON.misogi;
  const adventures = REVIEW_HORIZON.adventures.map(([text, when, done]) => ({ text, done, when: when ? rangeLabel(key(year, ...when)) : '' }));
  const habits = REVIEW_HORIZON.habits.map(([text, percent], index) => ({ quarter: index + 1, text, percent, done: Math.round(percent * 0.9), elapsed: 90 }));
  const entry = ([text, [month, day]]) => ({ key: key(year, month, day), text });
  const review = {
    year,
    isCurrentYear: false,
    isFutureYear: false,
    asOf: '',
    days: { closed, closeRate: Math.round(closed / paint.planningElapsed * 100), planningElapsed: paint.planningElapsed },
    bestStreak: SAMPLE_STREAK,
    trophies: { unlocked, total: TROPHIES.length },
    outcomes: { done: mitDone, share: Math.round(mitDone / closed * 100) },
    time: { total, days: closed - 4, rows },
    horizon: {
      misogi: { text: misogiText, why: '', when: rangeLabel(key(year, misogiMonth, misogiDay)), done: true, milestones: REVIEW_HORIZON.milestones.map(text => ({ text, done: true })), milestonesDone: REVIEW_HORIZON.milestones.length },
      adventures: { items: adventures, lived: adventures.filter(item => item.done).length },
      commitments: [...REVIEW_HORIZON.commitments],
      habits
    },
    journal: { memories: REVIEW_HORIZON.memories.map(entry).reverse(), lessons: REVIEW_HORIZON.lessons.map(entry).reverse() },
    isEmpty: false
  };
  const progress = { year, months: paint.months, closed, planningElapsed: paint.planningElapsed, closeRate: review.days.closeRate, streak: { yearBest: SAMPLE_STREAK }, metrics: { mitDone }, unlocked, trophies: TROPHIES };
  return { review, progress };
}

// ---------------------------------------------------------------------------
// A quarter check-in: the same person's third quarter, checked in on 2 October
// ---------------------------------------------------------------------------

/** Closed days in one quarter of a progress model (no day records read). */
export function quarterClosed(progress, quarter) {
  return [0, 1, 2].reduce((sum, offset) => sum + (Number(progress?.months?.[quarter * 3 + offset]?.closed) || 0), 0);
}

/**
 * The quarter "Check in" previews from the person's own planner: the one a
 * check-in opens on, else up to three before it, the first with enough closed
 * days; null when none has (the sample stands in).
 */
export function ownQuarter({ today = new Date(), minYear = today.getFullYear(), closedIn = () => 0, below = QUARTER_SAMPLE_BELOW, back = 4 } = {}) {
  let at = defaultCheckInQuarter(today);
  for (let step = 0; step < back && at.year >= (Number(minYear) || at.year); step += 1, at = previousQuarter(at)) {
    let closed = 0;
    try { closed = Number(closedIn(at)) || 0; } catch (_) { closed = 0; }
    if (closed >= below) return at;
  }
  return null;
}

const QUARTER_SAMPLE = {
  quarter: 2,
  habits: ['Walk after lunch', 'No phone in the bedroom', 'Write three lines', 'Stretch before bed'],
  milestones: [['Run 10 km without stopping', [2, 15], true], ['A half marathon in June', [5, 14], true], ['30 km in training', [7, 30], true], ['Book the race hotel', [8, 12], false]],
  adventures: [['Swim in the sea in April', [3, 18], true], ['Kayak to the island', [6, 25], true], ['Cook for twelve people', [10, 21], false]],
  memories: [['Kayak to the island at dawn', [6, 27]], ['Crossing the finish line with Sam', [8, 25]]],
  lessons: [['Two priorities are plenty', [6, 15]], ['Short runs still count', [7, 12]]],
  entry: {
    wentWell: 'The long runs on Sunday mornings. Writing three lines most evenings made the busy weeks easier to read.',
    change: 'No email before the first block. Book the taper weeks before the race.',
    focus: 'Run the marathon, then rest properly'
  },
  // Minutes per closed day: [category, chance, shortest, longest].
  blocks: [['deep-work', 0.92, 90, 180], ['admin', 0.8, 30, 90], ['health', 0.62, 30, 75], ['personal', 0.42, 30, 90], ['learning', 0.28, 30, 60]]
};

/**
 * Everything buildQuarterReview() reads, for the sample person's third quarter
 * of `year` (the year of the sample review): the painted days of that review,
 * the habit "Write three lines" checked on most days, a milestone and a
 * mini-adventure of the marathon year, a few journal lines, scheduled blocks
 * and the check-in's answers.
 */
export function sampleQuarterInput(year, { weekStartsOn = 1 } = {}) {
  const { quarter } = QUARTER_SAMPLE;
  const paint = samplePaint(year);
  let seed = 9311;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const habitChecks = {};
  const records = new Map();
  const closedKeys = [];
  for (let month = quarter * 3; month < quarter * 3 + 3; month += 1) {
    paint.months[month].days.forEach(cell => {
      const kept = cell.closed ? random() < 0.8 : !cell.planning && random() < 0.4;
      if (kept) habitChecks[cell.key] = [quarter];
      cell.habitKept = cell.closed && kept;
      cell.level = cell.closed ? 1 + (cell.mitDone ? 1 : 0) + (cell.habitKept ? 1 : 0) : 0;
      if (!cell.closed) return;
      closedKeys.push(cell.key);
      const blocks = QUARTER_SAMPLE.blocks.filter(([, chance]) => random() < chance).map(([categoryId, , low, high], index) => ({ id: `b${index}`, title: '', start: 540 + index * 120, duration: low + Math.round(random() * (high - low) / 15) * 15, categoryId }));
      records.set(cell.key, { blocks, endedAt: `${cell.key}T18:30:00`, memory: '', lesson: '' });
    });
  }
  // Each journal line goes on the first closed day from its date.
  const write = (field, [text, [month, day]]) => {
    const dayKey = closedKeys.find(item => item >= key(year, month, day));
    if (dayKey) records.get(dayKey)[field] = text;
  };
  QUARTER_SAMPLE.memories.forEach(item => write('memory', item));
  QUARTER_SAMPLE.lessons.forEach(item => write('lesson', item));
  const yearData = {
    misogi: REVIEW_HORIZON.misogi[0],
    misogiStartDate: key(year, ...REVIEW_HORIZON.misogi[1]),
    misogiEndDate: '',
    misogiDone: false,
    misogiMilestones: QUARTER_SAMPLE.milestones.map(([text, [month, day], done], index) => ({ id: `sample-q-milestone-${index + 1}`, text, date: key(year, month, day), done })),
    miniAdventures: QUARTER_SAMPLE.adventures.map(([text, [month, day], done], index) => ({ id: `sample-q-adventure-${index + 1}`, text, startDate: key(year, month, day), endDate: '', status: done ? 'done' : 'planned', done })),
    habits: [...QUARTER_SAMPLE.habits],
    habitStartedAt: ['', '', key(year, quarter * 3, 1), ''],
    habitChecks,
    months: {},
    quarterReviews: { [`Q${quarter + 1}`]: { done: true, ...QUARTER_SAMPLE.entry, completedAt: key(year, quarter * 3 + 3, 2) } }
  };
  return {
    year,
    quarter,
    progress: { year, months: paint.months },
    yearData,
    nextYearData: null,
    readDay: dayKey => records.get(dayKey) || null,
    categoryFor: id => defaultCategories.find(category => category.id === id) || null,
    weekStartsOn,
    today: new Date(year, quarter * 3 + 3, 2, 12)
  };
}

/** The sample quarter, as buildQuarterReview() returns it for renderQuarterPrint(). */
export function sampleQuarterReview(year, options) {
  return buildQuarterReview(sampleQuarterInput(year, options));
}
