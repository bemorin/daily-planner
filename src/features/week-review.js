import { esc } from '../lib/text.js';
import { durationLabel } from '../domain/schedule-time.js';

export function createWeekReviewFeature({
  getDate,
  getState,
  getSettings,
  planningWeekDates,
  isPlanningDay,
  ymd,
  loadStateForDate,
  categoryFor,
  categoryFallback,
  getUnresolvedCounts = () => ({ needs: 0, later: (getSettings().openWork || []).length })
}) {
  function isLastPlanningDay(inputDate) {
    const days = planningWeekDates(inputDate);
    return isPlanningDay(inputDate) && !!days.length && ymd(days[days.length - 1]) === ymd(inputDate);
  }

  function weekReviewData(inputDate) {
    const days = planningWeekDates(inputDate);
    const currentDate = getDate();
    const currentState = getState();
    const settings = getSettings();
    let mainDone = 0, mainTotal = 0, carried = 0, dropped = 0;
    const postponed = [];
    const lessons = [];
    const moved = [];
    const categoryMinutes = new Map();

    days.forEach(dayDate => {
      const dayKey = ymd(dayDate);
      const dayState = dayKey === ymd(currentDate) ? currentState : loadStateForDate(dayDate);
      const main = dayState.priorities[0];
      if (main?.text?.trim()) { mainTotal += 1; if (main.done) mainDone += 1; }
      dayState.priorities.filter(item => item.text?.trim() && item.done).forEach(item => moved.push(item.text.trim()));
      (dayState.triaged || []).forEach(value => { if (value.includes('@')) carried += 1; if (value.endsWith(':drop')) dropped += 1; });
      [...dayState.priorities, ...dayState.tasks]
        .filter(item => item.text?.trim() && Number(item.carriedCount) >= 2)
        .forEach(item => postponed.push({ text: item.text, count: Number(item.carriedCount) }));
      dayState.blocks.forEach(block => {
        const cat = categoryFor(block.categoryId) || categoryFallback();
        categoryMinutes.set(cat.id, { cat, minutes: (categoryMinutes.get(cat.id)?.minutes || 0) + block.duration });
      });
      if (dayState.lesson?.trim()) lessons.push(dayState.lesson.trim());
    });

    (settings.openWork || [])
      .filter(item => Number(item.carriedCount) >= 2)
      .forEach(item => postponed.push({ text: item.text, count: Number(item.carriedCount) }));

    const uniquePostponed = [...new Map(postponed.sort((a, b) => b.count - a.count).map(item => [item.text.toLocaleLowerCase(), item])).values()].slice(0, 4);
    const uniqueMoved = [...new Map(moved.map(text => [text.toLocaleLowerCase(), text])).values()].slice(0, 5);
    const allCategories = [...categoryMinutes.values()].sort((a, b) => b.minutes - a.minutes);
    const scheduledMinutes = allCategories.reduce((total, item) => total + item.minutes, 0);

    return {
      mainDone,
      mainTotal,
      carried,
      dropped,
      moved: uniqueMoved,
      postponed: uniquePostponed,
      categories: allCategories.slice(0, 5),
      scheduledMinutes,
      lessons: lessons.slice(-5)
    };
  }

  function renderWeekReviewSummary(review) {
    const total = Math.max(0, Number(review.scheduledMinutes) || 0);
    const timeRows = review.categories.map(item => {
      const share = total ? Math.max(2, Math.round((item.minutes / total) * 100)) : 0;
      return `<div class="week-review-time-row">
        <div class="week-review-time-row__meta"><span><i style="background:${item.cat.color}"></i>${esc(item.cat.name)}</span><strong>${durationLabel(item.minutes)}</strong></div>
        <div class="week-review-time-track" aria-hidden="true"><i style="--week-review-share:${share}%;--week-review-color:${item.cat.color}"></i></div>
      </div>`;
    }).join('');
    const metrics = `<div class="week-review-metrics">
      <div><span>Main outcomes</span><strong>${review.mainDone}<small> / ${review.mainTotal || 0}</small></strong><em>completed</em></div>
      <div><span>Carried forward</span><strong>${review.carried}</strong><em>items</em></div>
      <div><span>Dropped</span><strong>${review.dropped}</strong><em>items</em></div>
    </div>`;
    const time = review.categories.length ? `<section class="week-review-section week-review-time">
      <div class="week-review-section__head"><span>Where your scheduled time went</span><strong>${durationLabel(total)}</strong></div>
      <div class="week-review-time-rows">${timeRows}</div>
    </section>` : '';
    const unresolvedCounts = getUnresolvedCounts() || {};
    const unresolvedCount = Math.max(0, Number(unresolvedCounts.needs) || 0) + Math.max(0, Number(unresolvedCounts.later) || 0);
    const unresolvedCopy = unresolvedCount === 1
      ? '1 unresolved item is still waiting for a decision.'
      : `${unresolvedCount} unresolved items are still waiting for a decision.`;
    const unresolved = unresolvedCount ? `<section class="week-review-section week-review-section--unresolved"><div class="week-review-section__head"><span class="week-review-section__title">Still unresolved <em>${unresolvedCount}</em></span><button class="week-review-inline-action" type="button" data-review-open-work><span>Review all</span><span aria-hidden="true">→</span></button></div>${review.postponed.length ? `<div class="week-review-list">${review.postponed.map(item => `<p><span>${esc(item.text)}</span><em>carried ${item.count}×</em></p>`).join('')}</div>` : `<p class="week-review-empty-note">${unresolvedCopy}</p>`}</section>` : '';
    const completed = review.moved.length ? `<section class="week-review-section"><div class="week-review-section__head"><span>Completed outcomes</span></div><div class="week-review-list">${review.moved.map(item => `<p><span>${esc(item)}</span></p>`).join('')}</div></section>` : '';
    const lessons = review.lessons.length ? `<section class="week-review-section"><div class="week-review-section__head"><span>Lessons worth keeping</span></div><div class="week-review-list">${review.lessons.map(item => `<p><span>${esc(item)}</span></p>`).join('')}</div></section>` : '';
    return `${metrics}${time}${unresolved}${completed}${lessons}`;
  }

  return { isLastPlanningDay, weekReviewData, renderWeekReviewSummary };
}
