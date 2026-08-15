# Changelog

## v55 — mobile scroller boundary cleanup

- Stop the Plan and Schedule scroll containers above the fixed mobile dock so their native scrollbar tracks no longer run underneath persistent navigation.
- Remove the compensating Schedule spacer that previously reserved dock clearance inside the scroll content.
- Keep the final content position unchanged while making the scroll viewport match the visible workspace boundary.

## v54 — mobile day navigation and viewport cleanup

- Added touch swipe navigation between configured planning days in Day view on mobile.
- Consolidated the Close day carry-date disclosure so its chevron is centered by one canonical style block.
- Removed viewport-height subtraction hacks from mobile Plan and Schedule panes; the panes now use their actual workspace height and a single dock-clearance spacer.
- Increased mobile planning guidance copy for better readability.
- Added regression coverage for swipe navigation, modal disclosure alignment, and mobile pane geometry.

Notable public changes to Daily Planner are recorded here. The project favors short release notes that explain user-visible changes and important engineering decisions without pretending every internal edit is noteworthy.

## v53 — mobile layering and planning-day navigation

- Keep every modal above persistent mobile chrome and hide the Plan / Schedule dock plus quick-add action while a modal is open.
- Show the compact mobile Today calendar only when Day is away from today or Week is away from the current calendar week.
- Make Day previous/next navigation follow configured planning days, including skipping weekends or any excluded weekdays.
- Remove the generic mobile workspace bottom reserve and consolidate four competing Schedule scroll overrides into one rule.
- Keep the Enterprise workspace boundary unchanged; this release does not add Team Calendar or mentions UI.

## v52 — mobile navigation polish and workspace boundary

- Move the Day / Week control directly beside the date and keep it icon-only at every breakpoint.
- Replace the crowded mobile Previous / Next / Now cluster with one calendar-day button that returns to the current moment.
- Increase the contrast, label size, and touch targets of the mobile Plan / Schedule dock.
- Add a focused mobile schedule action that opens the existing block editor without duplicating scheduling logic.
- Add the public-client workspace boundary: Personal remains the default private planner, while organization workspaces only appear when an optional cloud profile exposes them.
- Keep Enterprise workspace selection isolated from Personal data; organization selection currently opens an explicit shared-workspace shell rather than reusing or leaking the personal planner.
- Add workspace model tests and mobile Chromium smoke coverage for the revised navigation.

## v51 — planning-day handoff and unresolved clarity

- Seed the first onboarding block on the next configured planning day when the user arrives outside active days or visible hours.
- Keep the first seeded block at the next full hour when the current planning day still has visible time available.
- Make the Close day date disclosure chevron readable without changing the shared 20×20 icon size.
- Show the exact unresolved total in the weekly review.
- Give the Still unresolved review surface a clearer bordered treatment and a discoverable Review all interaction.
- Show exact Needs attention and Later counts directly in the Unresolved tabs.

## v50 — close-day flow continuity

- Keep the final planning day on a single guided flow: prepare the next planning day first, then review the week.
- Preserve next-day prep in the same Close day modal instead of forcing navigation away.
- Move unresolved review into the weekly-review section as a lightweight inline action.
- Return to the weekly review after reviewing unresolved work instead of losing the close-day context.

## v49 — safer coordinator cleanup and engineering visibility

- Extract planning-calendar rules from `app.js` into a pure domain module with tests.
- Extract schedule-time formatting and cross-midnight range helpers into a pure domain module with tests.
- Extract lightweight note/checklist parsing and rendering helpers into a pure domain module with tests.
- Add `npm run lint` and `npm run format:check` as conventional static-analysis entry points without adding runtime or development package dependencies.
- Run the complete verification pipeline in GitHub Actions for pushes to `main` and pull requests.
- Document why production releases are verified with domain tests plus real Chromium interactions.
- Document the proposed public local-client / private cloud-service boundary.
- No intentional product or visual changes.

## v48 — close-day review polish

- Keep the second close-day screen focused by removing the Reopen day action there.
- Separate weekly review from next-day planning on the last planning day of the week.
- Improve the “Where your scheduled time went” summary with clearer hierarchy and proportional category bars.

## v47 — safe code-quality baseline

- Re-establish the validated runtime as the refactoring baseline.
- Reduce screen CSS override debt without changing the rendered application.
- Add architecture documentation, release checks, domain tests, and production Chromium smoke coverage.
