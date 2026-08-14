import { defaultCategories, palette } from '../config.js';
import { clamp, uid } from '../lib/utils.js';

function categoriesFrom(raw) {
  if (raw?.categories?.length) {
    return raw.categories.map((category, index) => ({
      id: category.id || uid('category'),
      name: category.name || 'Category',
      color: category.color || palette[index % palette.length].value,
      archived: !!category.archived,
      archivedAt: category.archivedAt || ''
    }));
  }
  return defaultCategories.map(category => ({ ...category, archived: false, archivedAt: '' }));
}

export function createDefaultSettings({ detectedWeekStart = 1, currentYear = new Date().getFullYear() } = {}) {
  return {
    categories: categoriesFrom(null),
    startHour: 8,
    endHour: 18,
    expandedView: false,
    fitDefaultV8: true,
    weekStartDay: 1,
    weekEndDay: 5,
    weekStartsOn: detectedWeekStart,
    planningDays: [1, 2, 3, 4, 5],
    onboardingComplete: false,
    closeDayCount: 0,
    installPromptShown: false,
    sponsorPromptShown: false,
    openWork: [],
    horizon: { years: {} },
    horizonStartYear: currentYear
  };
}

export function normalizePlannerSettings(raw, { detectedWeekStart = 1, currentYear = new Date().getFullYear() } = {}) {
  if (!raw || typeof raw !== 'object') return createDefaultSettings({ detectedWeekStart, currentYear });

  const startHour = clamp(Number(raw.startHour ?? 6), 0, 23);
  const endHour = clamp(Number(raw.endHour ?? 22), startHour + 1, 24);

  return {
    categories: categoriesFrom(raw),
    startHour,
    endHour,
    expandedView: raw.fitDefaultV8 ? raw.expandedView !== false : true,
    fitDefaultV8: true,
    weekStartDay: clamp(Number(raw.weekStartDay ?? 1), 0, 6),
    weekEndDay: clamp(Number(raw.weekEndDay ?? 5), 0, 6),
    weekStartsOn: clamp(Number(raw.weekStartsOn ?? raw.weekStartDay ?? detectedWeekStart), 0, 6),
    planningDays: Array.isArray(raw.planningDays) && raw.planningDays.length
      ? [...new Set(raw.planningDays.map(Number).filter(day => day >= 0 && day <= 6))]
      : null,
    onboardingComplete: raw.onboardingComplete !== false,
    closeDayCount: Math.max(0, Number(raw.closeDayCount) || 0),
    installPromptShown: !!raw.installPromptShown,
    sponsorPromptShown: !!raw.sponsorPromptShown,
    openWork: Array.isArray(raw.openWork)
      ? raw.openWork.map(item => ({
          id: item.id || uid('open'),
          text: String(item.text || ''),
          kind: item.kind || 'task',
          originDay: item.originDay || '',
          carriedCount: Math.max(0, Number(item.carriedCount) || 0),
          block: item.block && typeof item.block === 'object' ? item.block : null
        })).filter(item => item.text.trim())
      : [],
    horizon: raw.horizon && typeof raw.horizon === 'object' ? raw.horizon : { years: {} },
    horizonStartYear: Math.max(2000, Number(raw.horizonStartYear) || currentYear)
  };
}
