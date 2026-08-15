# Architecture

Daily Planner is intentionally a small-runtime, local-first web application. The production app uses native HTML, CSS, JavaScript modules, browser storage, and PWA APIs. There is no runtime framework and no server-side planner database.

The main engineering constraint is stronger than “keep it simple”: **a code-quality change must not silently change planner behavior**. The application has a dense interaction surface—dragging, resizing, cross-day moves, linked tasks/outcomes, close-day transfers, Horizon date ranges, responsive layouts, and local persistence—so refactors are deliberately incremental.

## Runtime map

```text
index.html
  ↓
runtime-config.js        optional owner links; blank in public source
  ↓
app.js                   application coordinator and shared interaction shell
  ├─ src/config.js
  ├─ src/domain/
  │   ├─ note-lines.js
  │   ├─ planning-calendar.js
  │   └─ schedule-time.js
  ├─ src/lib/
  │   ├─ dates.js
  │   ├─ dom.js
  │   ├─ text.js
  │   └─ utils.js
  ├─ src/state/
  │   └─ local-store.js
  ├─ src/ui/
  │   └─ calendar-popover.js
  └─ src/features/
      ├─ fit.js
      ├─ horizon-model.js
      ├─ pip-styles.js
      ├─ print.js
      ├─ search.js
      ├─ stats.js
      ├─ week-review.js
      ├─ week.js
      └─ workspace.js
```

`app.js` is still the coordinator for cross-feature state and lifecycle. It is intentionally divided into named sections so a reader can navigate it without relying on incidental line numbers:

1. runtime state and date helpers;
2. day state and settings persistence;
3. primary Day rendering;
4. schedule rendering and block interaction;
5. notes editors and checklist syntax;
6. block editor;
7. categories, settings, install prompt, and onboarding;
8. stats, modal primitives, popovers, and live-time behavior;
9. navigation, responsive layout, search, and storage utilities;
10. close-day workflow and carry-forward logic;
11. Horizon / Year map;
12. Journal and Unresolved work;
13. export, Picture-in-Picture, mobile shell, help, and bootstrap bindings.

Large feature extractions are only accepted one domain at a time. A refactor is not considered successful merely because it parses or builds; `npm run verify` must continue to pass before the next extraction.

## CSS ownership

`styles.css` is only a coordinator. Source styles live in domain files:

```text
styles/
├─ core.css        shell, typography, common controls, modals
├─ schedule.css    Day schedule and time blocks
├─ week.css        Week schedule
├─ stats.css       Time statistics
├─ pip.css         Picture-in-Picture trigger/support UI
├─ settings.css    settings-specific UI
├─ horizon.css     Horizon / Year map
├─ workspace.css   optional Personal / Enterprise workspace shell
└─ print.css       print-only output
```

The production build concatenates them in the order declared by `styles.css`. That order is part of the current cascade contract and should not be changed casually.

The screen cascade intentionally uses a single `!important`: `[hidden] { display: none !important; }`, which protects the semantic `hidden` contract from component rules. The remaining `!important` declarations live in `print.css`, where they isolate deterministic print output from the interactive screen cascade. New screen styles should not introduce additional `!important` declarations.

## Data model

Planner data is stored in `localStorage`.

- `daily-planner:settings` stores categories, visible hours, planning days, onboarding state, Unresolved work, and Horizon data.
- `daily-planner:YYYY-MM-DD` stores one day.

A day contains, in broad terms:

```text
focus
priorities[3]
tasks[]
notes
blocks[]
endedAt
carriedForward[]
memory
lesson
triaged[]
closeTransfers[]
```

Normalization happens when data is loaded so older local records can continue to work as fields evolve.

## Schedule invariants

Day and Week are two views over the same schedule data. They must not maintain independent copies of blocks.

Important invariants:

- block times are stored in minutes from midnight;
- movement and resizing snap to the planner interval;
- blocks can cross midnight through `startDate` / `endDate`;
- linked tasks/outcomes stay synchronized with their scheduled block;
- moving a Week block to another day persists it into the destination day state;
- current-time visuals are presentation state, not persisted state.

## Horizon invariants

Horizon separates **calendar scope** from **tracking scope**.

A Winning Habit belongs to an entire quarter visually, even when tracking starts after the first day of that quarter. The quarter bounds therefore remain fixed while statistics use `habitStartedAt` as the tracking start.

Misogi, Mini-adventures, and Key dates use date or date-range data but remain distinct domain objects.

## Close-day invariants

Close day is a transition, not a destructive cleanup operation.

For each unresolved candidate, the user can:

- schedule it on a date;
- keep it in Unresolved without a date;
- drop it from active work.

Transfers created by a close are recorded so reopening the day can reverse that close before another close is performed.

## Rendering and persistence

The app currently uses direct DOM rendering rather than a virtual DOM. This keeps runtime weight extremely low but makes ordering important:

1. normalize/load state;
2. render the affected view;
3. bind or refresh view-local interactions;
4. persist only user state, never transient UI state.

Feature modules receive explicit callbacks/context from `app.js` rather than importing mutable application state directly. New modules should follow the same rule.

## Safety boundaries

User-authored text inserted into HTML templates must pass through the existing escaping helpers. URLs are normalized before being exposed as links.

The public runtime configuration deliberately contains no owner-specific social or repository URLs. Production builds may inject them through environment variables without changing source files. An optional `CLOUD_API_URL` may also be injected; when it is absent, the workspace feature performs no cloud request and the planner remains purely local.

## Build and release verification

```bash
npm run verify
```

runs, in order:

1. static lint guards and JavaScript parsing;
2. repository formatting checks;
3. repository/module/license checks;
4. unit tests for pure/domain logic;
5. a no-regression quality gate against the validated runtime baseline;
6. the production build;
7. a Chromium smoke test that boots the actual application modules in a browser engine and exercises Day, Week, the core modals, Fit mode, Export, Week drag/resize, and the post-close weekly review.

The smoke test is dependency-free but requires Chrome or Chromium. Set `CHROME_BIN` when the browser is not in a standard location.

## Refactoring policy

A code-quality PR should obey three rules:

1. **one extraction at a time**;
2. **no mixed UX changes** unless the PR is explicitly a product change;
3. **behavioral equivalence is a deliverable**, not an assumption.

The current cleanup strategy is to shrink the coordinator only through small pure/domain extractions with explicit inputs and tests. Event binding, modal lifecycle, and cross-feature orchestration stay in `app.js` until a feature boundary can be extracted without changing initialization order.

Current examples are planning-calendar rules, schedule-time formatting, and note-line parsing. Each was moved independently and covered by unit tests before the next extraction.

## Cloud service boundary

Cloud functionality is intentionally outside the local planner runtime. A separate private service owns the server-side organization model and will later own authentication, synchronization, backups, billing, and third-party server integrations. The public client depends only on an API contract. The first client boundary is deliberately small: if `/v1/me` exposes organizations, the UI can reveal a workspace selector; Personal remains the default private planner and organization selection never reuses Personal data as team data.

The proposed boundary is described in [`docs/CLOUD_BOUNDARY.md`](./docs/CLOUD_BOUNDARY.md).
