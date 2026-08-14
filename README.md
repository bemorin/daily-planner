# Daily Planner by Ben Morin

A local-first planner for choosing what matters, protecting time for it, and closing the day without losing unfinished work.

The planner runs in the browser, stores its data locally, works without an account, can be installed as a PWA, and can be exported or backed up at any time.

## The planning loop

**Plan → Do → Close → Decide → Prepare**

- **Day** keeps one intention, one main outcome, up to two other outcomes, supporting tasks, notes, and a time-blocked schedule in one place.
- **Week** shows the configured planning days side by side without the Day plan column.
- **Close day** decides what is done, what moves to a date, what stays unresolved, and what is dropped.
- **Unresolved** keeps unfinished work visible without turning it into a large backlog system.
- **Journal** keeps the day’s memory and lesson attached to the date they belong to.
- **Horizon** keeps longer-term direction visible through a Misogi, Mini-adventures, Winning Habits, annual commitments, and significant dates.

## First run

A new browser gets a three-step setup:

1. a short introduction to the planning method;
2. the days and visible hours to use in the planner;
3. a compact explanation of the Plan → Work → Journal → Close → Horizon loop.

The setup is intentionally short. Everything else is introduced when it becomes useful.

## Day view

- **Keep in mind** — an intention, principle, or trap to avoid.
- **Most important outcome** — the one result that would make the day count.
- **Other important outcomes** — up to two more outcomes worth moving forward.
- **Tasks** — concrete actions supporting those outcomes.
- **Notes** — free-form notes; start a line with `//` to create a lightweight checkbox line.
- **Schedule** — draggable and resizable time blocks with categories, links, notes, completion, overlap handling, and blocks that can cross midnight.

Tasks and outcomes can be placed on the schedule directly. Linked items stay synchronized with their scheduled blocks.

## Week view

Week view shows only the schedule across the days configured as planning days.

- today keeps the current-time indicator;
- past days are visually quieter;
- clicking empty space creates a block on that day and time;
- clicking a block edits it without leaving Week view;
- the same schedule data is shared with Day view.

Planning days are the days you **normally** want shown and used when finding the next planning day. They do not prevent you from opening or scheduling any other date manually.

## Close day

Close day reviews unfinished work and lets each item be:

- planned to a date;
- **Kept** without a date in Unresolved;
- **Dropped** from active work while remaining part of the historical day.

Moved work keeps its `Moved n×` history. A closed day can be reopened, which reverses the transfers created by that close before the day is closed again.

Close day can also store:

- what made the day worth remembering;
- what the day taught you;
- the active quarterly Winning Habit.

After closing a day, the next planning day can be given a little direction without forcing you to open it immediately.

## Unresolved

Unresolved deliberately stays small:

- **Needs attention** — unfinished work from past days that has not already been placed elsewhere;
- **Later** — work deliberately kept without a date.

Planning from Unresolved is staged and confirmed instead of moving items immediately.

## Horizon

Horizon is the strategic layer, not another task manager.

- **Misogi** — one year-defining challenge with an optional date or period, completion, and up to five milestones.
- **Mini-adventures** — up to six experiences with optional dates or periods.
- **Winning Habits** — one habit per quarter, with completion rate, streaks, and an expandable activity view.
- **Three annual commitments** — simple statements about what deserves a place in the year.
- **Year map** — significant dates and periods, without filling the year with daily tasks.

Replacing a Winning Habit starts a new tracking window. Earlier check-ins stay saved but are not counted in the statistics of the new habit.

## Journal

Closing days builds a minimal journal with:

| Date | Best memory | Lesson learned |
| --- | --- | --- |

Only one batch of entries is rendered at a time, so large histories do not continuously accumulate DOM nodes.

## Stats

- daily scheduled / elapsed distribution by category;
- weekly category graph with selectable series and point inspection;
- over-plan information when completion timing can be inferred from a scheduled block;
- Winning Habit activity, completion percentage, tracked days, and streaks.

## Categories

Categories classify scheduled time and power the statistics.

- three distinct color palettes;
- categories can be archived and restored;
- archived categories remain available for historical data but disappear from new-block pickers;
- Misogi and Mini-adventures do not automatically become categories.

## Floating mode

When Document Picture-in-Picture is supported, the planner can stay in a compact floating window with editable **Plan / Schedule** views.

## Install as an app

Daily Planner is a Progressive Web App on supported browsers.

- **Chrome / Edge / other Chromium browsers:** use the browser’s **Install app** action when it appears in the address bar or browser menu.
- **Safari on iPhone / iPad:** use **Share → Add to Home Screen**.
- **Other supported browsers:** use **Install app** or **Add to Home Screen** from the browser UI.

The installed app uses the same local data and does not require an account.

The production service worker caches the application shell so the planner can reopen offline after it has been loaded successfully.

## Storage and privacy

Planner data is stored in `localStorage` under `daily-planner:` keys.

There is no server-side planner database. Clearing site data, private browsing, or privacy tools that purge browser storage can remove local data. Use **Backup all data** for history you want to keep.

The app tests whether browser storage is writable and warns when local persistence is unavailable.

## Import, export, and print

- Markdown export for the current day;
- JSON export for the current day;
- complete JSON backup and restore;
- one-page landscape print layouts for Day and Week;
- filenames include the relevant day or week.

## Keyboard shortcuts

The in-app **How it works** modal contains the complete shortcut reference. Common shortcuts include:

- `←` / `→` — previous / next day or week;
- `N` — go to now;
- `V` — Day / Week;
- `F` — search;
- `Y` — Horizon;
- `U` — Unresolved;
- `J` — Journal;
- `S` — statistics;
- `P` — print;
- `E` — export;
- `G` — settings;
- `H` — How it works;
- `T` — add a schedule task;
- `D` — close / reopen day;
- `//` — checkbox line in Notes.

## Local development

No package installation or framework is required for normal development.

### Windows

```powershell
py -m http.server 8080
```

### macOS / Linux

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

On localhost, the service worker is automatically unregistered so cached production assets cannot make a refresh look stale while you are editing files.

## Production build

Node is only used for the build script; there are no runtime framework dependencies.

```bash
npm run build
```

This recreates `dist/`, combines the domain CSS files, copies the required modules/assets, and produces gzip and Brotli versions of compressible files.

You do **not** need to run the build command after every source edit while developing with the local HTTP server.

## Architecture

The runtime is deliberately vanilla HTML, CSS, and JavaScript modules. `app.js` coordinates shared application state while focused modules own Week rendering, stats, search, print, fit geometry, planning-calendar rules, schedule-time formatting, note-line parsing, Horizon domain calculations, storage, and reusable calendar popovers. Source CSS is split by domain and combined only for production.

The full runtime map, data invariants, persistence model, and refactoring policy live in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

### Engineering reliability

Daily Planner is a stateful local-first application with drag-and-drop, cross-day moves, resizing, linked schedule items, close-day transfers, responsive layouts, and persistence invariants. A refactor is therefore treated as a behavioral change until it has been disproved by tests.

Because of that interaction surface, the repository verifies releases in two layers: **domain tests for pure rules, then interaction tests against the actual production build in Chromium**. The browser smoke test exercises the rendered application rather than only checking that modules parse.

### Optional cloud boundary

The public planner is designed to remain useful without an account or network connection. If official cloud services are added later, the intended boundary is a separate private service for authentication, synchronization, backups, billing, and integrations. The browser client would talk to that service through an explicit API instead of hiding proprietary server logic in shipped frontend code. See [`docs/CLOUD_BOUNDARY.md`](./docs/CLOUD_BOUNDARY.md).

## Verification

The repository has no runtime framework dependencies. It exposes conventional static-analysis entry points while keeping the toolchain dependency-free:

```bash
npm run lint
npm run format:check
npm test
npm run build
npm run smoke:dist
```

Before a public release or a code-quality refactor, run the aggregate command:

```bash
npm run verify
```

That command runs lint/static guards, formatting checks, repository checks, unit tests, a no-regression quality gate, the production build, and a Chromium interaction smoke test. Chrome/Chromium is the only external requirement for the smoke step; set `CHROME_BIN` if it is installed in a non-standard location.

The release checklist is in [`docs/RELEASE_CHECKLIST.md`](./docs/RELEASE_CHECKLIST.md).

## Public development

The repository is public so people can inspect how the planner works, run it locally, report issues, and learn from the implementation. Product and engineering mistakes should be documented rather than hidden: if a behavior is bad, the preferred loop is **reproduce → explain → fix → verify → follow up**.

Release-level changes are summarized in [`CHANGELOG.md`](./CHANGELOG.md). Contributions remain subject to the repository license.

## License

Daily Planner is **source-available**, not OSI open source. It is licensed under the **PolyForm Perimeter License 1.0.1**. The license permits use, modification, and distribution for permitted purposes, but does not permit providing a product that competes with Daily Planner.

See [`LICENSE`](./LICENSE) for the complete terms.
