# Contributing

Daily Planner has a deliberately small runtime and a large interaction surface. Contributions are welcome when they preserve that character.

## Before changing code

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md). In particular, do not treat a large refactor as “cleanup” simply because the UI is supposed to stay the same.

## Development principles

- Prefer native browser APIs and existing project primitives over new dependencies.
- Keep user data local unless a feature explicitly requires otherwise.
- Preserve existing storage compatibility.
- Keep Day and Week as views over the same schedule data.
- Escape user-authored content before inserting it into HTML templates.
- Do not add `!important` as a routine specificity fix.
- Do not add owner-specific URLs or deployment credentials to source files.
- Keep code-quality changes separate from UX/product changes whenever possible.

## Feature ownership

Put logic in the narrowest existing domain that owns it:

- generic date logic → `src/lib/dates.js`;
- persistence wrapper → `src/state/`;
- feature-specific pure/domain logic → `src/features/`;
- reusable UI primitive → `src/ui/`;
- Day schedule styles → `styles/schedule.css`;
- Week styles → `styles/week.css`;
- Horizon styles → `styles/horizon.css`.

`app.js` should coordinate shared state and cross-feature lifecycle. New isolated behavior should not automatically be added there.

## Required verification

Before opening a change:

```bash
npm run verify
```

The command must finish with all checks, tests, build steps, and browser smoke tests passing.

For interaction-heavy changes, also manually verify the affected flow at desktop and narrow/mobile widths. Drag/drop, resize, modal focus, and responsive behavior are difficult to prove from unit tests alone.

## Refactors

Refactor incrementally. Extract one coherent domain, verify it, then stop. Do not move multiple independent features in one PR simply to reduce a line-count metric.

A refactor that produces a smaller file but changes initialization order, event binding, CSS cascade, or persistence semantics is a regression.

## License

The project is source-available under the PolyForm Perimeter License 1.0.1. Contributions are accepted under the same project license.

## Public feedback loop

Issues and pull requests should make failures reproducible. A useful report explains what happened, what was expected, the viewport/browser when relevant, and the smallest sequence that reproduces the problem.

For fixes, prefer the same loop used by the release pipeline:

1. reproduce the behavior;
2. add or strengthen a test when the behavior can be expressed reliably;
3. make the smallest change that fixes it;
4. run `npm run verify`;
5. explain the change and any remaining limitation in the pull request.

Large “cleanup” pull requests that mix architecture changes with product changes are intentionally discouraged.
