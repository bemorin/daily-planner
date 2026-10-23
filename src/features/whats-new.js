/**
 * What this feature release changes for the people who use the planner —
 * shown once per release with the feedback prompt, and whenever feedback is
 * opened from Help or the menu. Keep it to 3–5 short, concrete lines, and
 * update `version` (major.minor) with each feature release; small fixes
 * (1.22.1, 1.22.2…) keep the same note and are never asked about again.
 */
export const WHATS_NEW = Object.freeze({
  version: '1.34',
  items: Object.freeze([
    'While our payment provider reviews the store, payments run in test mode: a line under the buy buttons says so, and no real card is charged.',
    'On a phone, More lists only what the header doesn’t show, in groups, and Export’s options are full size.',
    'A free order made with a 100% code now unlocks Plus like any other purchase.'
  ])
});
