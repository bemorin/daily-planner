# Changelog

Notable public changes to Daily Planner are recorded here. The project favors short release notes that explain user-visible changes and important engineering decisions without pretending every internal edit is noteworthy.

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
