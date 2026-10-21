# Daily Planner by Ben Morin

A local-first planner for choosing what matters, protecting time for it, and closing the day without losing unfinished work.

The planner runs in the browser, stores its data locally, works without an account, can be installed as a PWA, and can be exported or backed up at any time.

## The planning loop

**Plan → Do → Close → Decide → Prepare**

- **Day** keeps one intention, one main outcome, up to two other outcomes, supporting tasks, notes, and a time-blocked schedule in one place.
- **Week** shows the configured planning days side by side without the Day plan column.
- **Close day** decides what is done, what moves to a date, what is saved in Unresolved, and what is forgotten.
- **Unresolved** keeps unfinished work visible without turning it into a large backlog system.
- **Journal** keeps the day’s memory and lesson attached to the date they belong to.
- **Horizon** keeps longer-term direction visible through a Misogi, Mini-adventures, Winning Habits, annual commitments, and significant dates.

## First run

A new browser gets a three-step setup:

1. a short introduction to the planning method;
2. the days and visible hours to use in the planner;
3. a compact explanation of the daily loop: Plan → Do → Close → Decide.

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

Planning days define Week columns and Day-view previous/next navigation. They do not prevent you from opening or scheduling another date directly with the date picker.

## Close day

Close day reviews unfinished work and lets each item be:

- planned to a date;
- **Saved** without a date in Unresolved;
- **Forgotten** — taken off active work while remaining part of the historical day.

Moved work keeps its `Moved n×` history. A closed day can be reopened, which reverses the transfers created by that close before the day is closed again.

Close day can also store:

- what made the day worth remembering;
- what the day taught you;
- the active quarterly Winning Habit.

After closing a day, the next planning day can be given a little direction without forcing you to open it immediately.

## Unresolved

Unresolved deliberately stays small:

- **Needs attention** — unfinished work from past days that has not already been placed elsewhere;
- **Later** — work deliberately saved without a date.

Planning from Unresolved is staged and confirmed instead of moving items immediately.

## Horizon

Horizon is the strategic layer, not another task manager. A section rail keeps each part one click (or one key, `1`–`7`) away:

- **Overview** — a year-at-a-glance ribbon that puts the Misogi, milestones, mini-adventures, key dates and quarterly habits on one timeline with a Today marker, the next upcoming moments, and one tile per section.
- **Misogi** — one year-defining challenge with an optional date or period, completion, and up to five milestones.
- **Mini-adventures** — six slots for experiences, each an Idea, Planned (dated) or Lived.
- **Commitments** — three simple statements about what deserves a place in the year.
- **Winning habits** — one habit per quarter, with completion rate, streaks, and an expandable activity view.
- **Year map** — significant dates and periods month by month, without filling the year with daily tasks. Click anywhere in a month to add a key date there.
- **Progress** — the year painting itself: one square per closed day (deeper when the main outcome was done, deepest when the winning habit was kept), a forgiving streak that only counts planning days and gives two jokers a month, and a trophy room where every trophy is visible with its progress from day one.

The **Add** button (or `+`) opens one chooser for every Horizon element — key date, mini-adventure, milestone (or the Misogi itself), commitment and winning habit — and shows how many of each are left.

The Misogi and the rhythm of mini-adventures and quarterly habits come from [Jesse Itzler](https://jesseitzler.com/).

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

## Appearance

Settings → **Appearance** follows the device (System) or keeps the planner Light or Dark. The choice belongs to the browser it was made in: it is not part of backups, exports or sync. Interface motion is skipped automatically when the operating system asks for reduced motion.

## Floating mode

When Document Picture-in-Picture is supported, the planner can stay in a compact floating window with **Focus** (the current block, time left, the main outcome and the next tasks), an editable **Plan** (ending with what is still unresolved from other days, folded away) and a **Schedule** timeline; its arrows always move one day, in step with the main window. Where it is not supported (Firefox, Safari), the button and its shortcut are hidden.

## Install as an app

Daily Planner is a Progressive Web App on supported browsers. **More → Install the app** (also in Settings → Your devices, Help, and the last step of setup) shows the steps for the browser in use, or installs in one click where the browser allows it.

- **Chrome / Edge / other Chromium browsers:** use the browser’s **Install app** action when it appears in the address bar or browser menu.
- **Safari on iPhone / iPad:** use **Share → Add to Home Screen**.
- **Other supported browsers:** use **Install app** or **Add to Home Screen** from the browser UI.

The installed app uses the same local data and does not require an account.

The production service worker caches the application shell so the planner can reopen offline after it has been loaded successfully. Offline, another page of the site that this device never kept (the welcome, Teams, partners or legal pages) shows a short “You’re offline” page with a link back to the planner.

## Storage and privacy

Planner data is stored in `localStorage` under `daily-planner:` keys. Personal use remains local-first: no account or network connection is required.

A deployment can optionally switch on a small owner API (`PLANNER_API_URL`) for the account-sync waitlist, feedback by app version and anonymous daily counts of a few product moments. Planner content is never sent, counts carry no identifier, and with the checked-in blank value the planner makes no such request. When the API is on, a **Privacy** notice (Settings, Help, setup, and the waitlist and feedback forms) lists exactly what this copy counts and stores, and lets each device switch the counts off. It also receives team kit requests from the landing page, and the owner dashboard at `/admin/` supports two-factor sign-in. See [`docs/FEEDBACK_AND_WAITLIST.md`](./docs/FEEDBACK_AND_WAITLIST.md).

A deployment can optionally configure Google Drive personal sync. That path stores one hidden current-state sync document in the user's own Drive `appDataFolder`; Daily Planner does not need a server-side Personal planner database. The sync protocol works at stable planner-record boundaries, tracks deletions as tombstones, and refuses to silently overwrite a record that changed independently on both devices.

Before remote changes are applied, the browser attempts to keep a small rolling set of local recovery snapshots in IndexedDB. Those snapshots stay on that device. **Backup all data** remains the explicit portable backup/restore path.

The app tests whether browser storage is writable and warns when local persistence is unavailable. When the browser blocks storage for the site altogether (cookies and site data off), the planner still opens and works for that tab, on memory only, and says once that nothing will be kept (`src/state/browser-storage.js`). See [`docs/PERSONAL_SYNC.md`](./docs/PERSONAL_SYNC.md) for the sync contract and deployment setup.

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
- `//` — checkbox line in Notes;
- `1`–`6` / `+` — Horizon sections / add to Horizon (while Horizon is open).

## Landing page

`welcome/` is the public landing page (served at `/welcome/`): animated replicas of the planner, Daily Planner Plus, gifts for a friend, a family or a team, pricing in euros or US dollars (by the visitor's country), and an FAQ. `welcome/thanks/` is where the buyer gets the gift link after paying. The Teams page (`teams/`, at `/teams/`: the team gift and the “Ask a question” form) and the partners page (`partners/`, at `/partners/`) share its modules and styles; their old addresses under `/welcome/` redirect to them (`_redirects`, query string and `#hash` kept). The page reuses the planner's runtime configuration, makes no request when `PLANNER_API_URL` is blank, and takes every price from `src/lib/pricing.js`, the file the planner and the owner API use too.

## Legal pages

`legal/` holds the legal notice (`/legal/`), the privacy policy (`/legal/privacy/`), the terms of use and sale (`/legal/terms/`) and the cookies page (`/legal/cookies/`); `_redirects` adds the short links `/privacy`, `/terms` and `/cookies`. The publisher's details come from five build variables — `DAILY_PLANNER_SUPPORT_EMAIL`, `DAILY_PLANNER_PRIVACY_EMAIL`, `DAILY_PLANNER_LEGAL_ADDRESS`, `DAILY_PLANNER_LEGAL_PHONE` and `DAILY_PLANNER_LEGAL_REGISTRATION` (Cloudflare Pages → Settings → Variables and Secrets, then redeploy) — and anything left blank is omitted. The counted moments, prices and Plus features are rendered from the code. See [Legal pages](./docs/FEEDBACK_AND_WAITLIST.md#legal-pages), including the addresses to give Creem.

## Daily Planner Plus

The planner is free. **Plus** is a one-time unlock, for life, that adds new features: **Plan your year** (a guided session that sets up Horizon), **Your year in review** (one printable page), and colours for the painted year. Companies can give Plus to their people as a team gift, and anyone can give it to a friend (Give Plus) or a family of up to five (Plus Family): one link, each person who opens it activates Plus, no accounts and no names collected. Licences are signed by the owner API and verified on the device; a copy built without `DAILY_PLANNER_PLUS_PUBLIC_KEY` cannot activate Plus. Payments go through Creem, the merchant of record (it charges VAT and sends receipts and invoices). The euro area pays in euros and everyone else in US dollars, decided by the server from the buyer's country; partners can share `/welcome/?ref=CODE` links through Creem's affiliate program. Setup is in [`docs/FEEDBACK_AND_WAITLIST.md`](./docs/FEEDBACK_AND_WAITLIST.md).

## Local development

No package installation or framework is required for normal development.

### Windows — one double-click

Double-click **`Start Daily Planner.bat`**. It starts a local server on `http://localhost:8080` and opens the planner in your default browser; close the window to stop it. It uses Node.js when available and falls back to Python.

```text
Start Daily Planner.bat            start and open the planner
Start Daily Planner.bat shortcut   add a "Daily Planner" shortcut to the desktop
Start Daily Planner.bat dist       serve the production build (builds it first if needed)
Start Daily Planner.bat lan        also reachable from a phone on the same Wi-Fi
```

Browsers keep planner data per address, so the launcher always uses port 8080 — the same address as `py -m http.server 8080` — and simply reopens the planner if it is already running.

### Any platform

```bash
npm start            # node scripts/serve.mjs --open
npm run serve:dist   # production build
npm run start:api    # also run the owner API and dashboard (/admin/, token "dev")
npm run start:api:fake # the same, printing emails and with pretend Creem payments
npm run admin:secret # print a fresh ADMIN_TOKEN and two-factor secret for production
npm run plus:keys    # print a fresh Plus signing key and its public key
```

or, without Node:

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

The runtime is deliberately vanilla HTML, CSS, and JavaScript modules. The only third-party runtime code is a small vendored build of [Motion](https://motion.dev) (`src/vendor/motion.js`, see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)) used for interface transitions. `app.js` coordinates shared application state while focused modules own Week rendering, stats, search, print, fit geometry, planning-calendar rules, schedule-time formatting, note-line parsing, Horizon domain calculations, storage, and reusable calendar popovers. Source CSS is split by domain and combined only for production.

The full runtime map, data invariants, persistence model, and refactoring policy live in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

### Engineering reliability

Daily Planner is a stateful local-first application with drag-and-drop, cross-day moves, resizing, linked schedule items, close-day transfers, responsive layouts, and persistence invariants. A refactor is therefore treated as a behavioral change until it has been disproved by tests.

Because of that interaction surface, the repository verifies releases in two layers: **domain tests for pure rules, then interaction tests against the actual production build in Chromium**. The browser smoke test exercises the rendered application rather than only checking that modules parse.

### Optional cloud boundary

Daily Planner stays local-first: using the Personal workspace never requires an account or internet connection. The public client now contains only the **workspace boundary** for an optional private service. If a deployment provides `DAILY_PLANNER_CLOUD_API_URL` and an authenticated profile exposes organizations, a workspace selector can reveal **Personal** plus those company workspaces. Personal planner data is never reinterpreted as company data.

The private service remains a separate repository and owns server-side authentication, organizations, shared company data, Enterprise synchronization, billing, and Enterprise operations. Personal Google Drive sync is deliberately separate and does not pass through the private service. See [`docs/CLOUD_BOUNDARY.md`](./docs/CLOUD_BOUNDARY.md).

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
