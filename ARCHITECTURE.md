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
  ├─ src/sync/
  │   ├─ document.js
  │   ├─ engine.js
  │   ├─ google-drive.js
  │   ├─ hash.js
  │   ├─ ledger.js
  │   ├─ merge.js
  │   ├─ records.js
  │   └─ recovery-store.js
  ├─ src/ui/
  │   ├─ calendar-popover.js
  │   ├─ motion.js         animation presets; no-ops under reduced motion
  │   └─ theme.js          per-device System / Light / Dark preference
  ├─ src/vendor/
  │   └─ motion.js         vendored Motion (mini animate, stagger, spring)
  └─ src/features/
      ├─ fit.js
      ├─ horizon-model.js
      ├─ horizon-view.js     Horizon sections, overview ribbon, Add chooser
      ├─ personal-sync.js
      ├─ pip-styles.js      Picture-in-Picture stylesheet (injected into the floating window)
      ├─ pip-window.js      Picture-in-Picture: Focus, Plan and Schedule, day-by-day navigation, sync with the main window
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
├─ theme.css       dark tokens, Appearance control, motion hand-off, focus rings
└─ print.css       print-only output
```

Dark mode is token-based: `theme.css` redefines the `:root` colour tokens for `prefers-color-scheme: dark` (unless the visitor chose Light) and for an explicit `data-theme="dark"`. Both are scoped to `@media screen`, so printed pages keep the light print stylesheet. New components should use the tokens rather than literal colours.

The production build concatenates them in the order declared by `styles.css`. That order is part of the current cascade contract and should not be changed casually.

The screen cascade intentionally uses a single `!important`: `[hidden] { display: none !important; }`, which protects the semantic `hidden` contract from component rules. The remaining `!important` declarations live in `print.css`, where they isolate deterministic print output from the interactive screen cascade. New screen styles should not introduce additional `!important` declarations.

## Data model

Planner data is stored locally first. The working planner records live in `localStorage`; optional recovery snapshots use IndexedDB; optional Google Drive sync mirrors the current Personal sync document to the user's own Drive app-data space.

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


## Personal sync invariants

Personal sync does not turn Google Drive into the runtime database. The local planner remains usable before, during, and after sync.

Local mutations always commit to `localStorage` first. When Google Drive is connected, dirty records are batched and uploaded opportunistically after a short idle pause, with a maximum wait so work does not remain unsynced indefinitely — but only while a usable in-memory Google access token already exists. Automatic sync never calls Google Identity Services `requestAccessToken()` and therefore never opens OAuth UI. Returning to the app, regaining connectivity, closing the day, and **Sync now** (with a usable token) are additional sync points. **Connect** / **Reconnect** are the only interactive authorization gestures. There is no continuous polling and no write-after-every-edit to Drive.

The first protocol uses stable top-level record boundaries:

```text
settings
day:YYYY-MM-DD
```

For each record, the client keeps the content hash last confirmed on both sides. A sync compares that base hash with the current local and remote hashes. Local-only changes are pushed, remote-only changes are pulled, identical changes are accepted, and divergent concurrent changes stop as a conflict instead of silently picking a winner.

Deletions are represented as tombstones in the local sync ledger so a deleted day cannot reappear merely because another device still has an older copy. Before remote changes are applied, the client attempts to keep a small rolling recovery snapshot in IndexedDB.

Google Drive is only a transport adapter. The sync engine itself is provider-independent so OneDrive or another Personal transport can implement the same `read()` / `write()` contract later.

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

## Motion policy

Motion is a presentation layer, never a state transition. `src/ui/motion.js` exposes a handful of presets (dialog enter/exit, popover, panel change, list item enter/exit, height toggle, indicator slide). Each one resolves when the animation settles, clears the inline styles it wrote, and does nothing when the system prefers reduced motion or the browser lacks the Web Animations API. While Motion is active the root carries `has-motion`, which removes the CSS transitions of the components it animates (CSS transitions outrank Web Animations in the cascade). Animate only where movement explains something — arrival, change of place, addition or removal — and keep exits shorter than entrances.

## Horizon view

`src/features/horizon-view.js` renders only the active Horizon section and binds its interactions; `app.js` still owns year-data normalization, persistence and the shared Horizon popovers, and passes them in through an explicit context object. `buildHorizonModel()` is a pure derivation (events, upcoming items, per-section progress) and is unit-tested.

## Progress, setup and owner API

`src/features/progress-model.js` is a pure derivation of the painted year, the streak (planning days only, two jokers a month, today pending until closed) and the trophies from saved days and Horizon data; it is unit-tested and memoised briefly by `app.js`. `progress-view.js` renders it for Horizon, the Overview card and the Close-day summary.

First-run setup (`onboarding.js`), the install dialog (`install.js`), the Google Drive sync guide and waitlist (`sync-guide.js`) and versioned feedback (`feedback.js`, asked once per feature release with the notes in `whats-new.js`) are self-contained features that receive their dependencies from `app.js`. `day-summary.js` computes, without touching the DOM, what the Day · Week · Horizon navigation and the phone Plan · Schedule · Horizon tabs (`view-switch.js`), the week heads and the phone week agenda (`week-agenda.js`) say about each day; `plus-previews.js` draws the Plus dialog's previews from the person's own data. Every menu in the planner is one listbox component (`src/ui/listbox.js`); the landing page has its own small copies in `welcome/listbox.js` and `welcome/stepper.js`. Prices and the Plus promise live in `src/lib/pricing.js`, shared by the planner, the landing page and the server.

`src/lib/planner-api.js` is the only client of the optional owner API and does nothing while `PLANNER_API_URL` is blank. The API itself lives in `server/planner-api.js` (a fetch-style router with a pluggable store), served by `functions/api/[[path]].js` on Cloudflare Pages with D1 (`server/d1-store.js`, `migrations/`) and by `scripts/serve.mjs` locally with a JSON file. The owner dashboard is static (`admin/`); it exchanges the admin token and an optional TOTP code for a signed 8-hour session (`server/admin-auth.js`) and reads the API with it. `src/features/privacy.js` builds the Privacy notice from the configuration, so it appears exactly when something is sent. The landing page (`welcome/`) is a separate static page that imports `src/config.js` and `src/lib/planner-api.js` and nothing else from the planner. See [`docs/FEEDBACK_AND_WAITLIST.md`](./docs/FEEDBACK_AND_WAITLIST.md).

## Daily Planner Plus

`src/lib/plus.js` verifies licences (`DP1.<payload>.<signature>`, ECDSA P-256) with the public key from the runtime configuration and keeps the licence in the planner's settings, so sync and backups carry it. `src/features/plus-dialog.js` holds the Plus dialog, the gift welcome sheet and the `?gift=`, `?checkout_id=` (back from a Creem checkout), `?purchase=` (the link in the purchase email) and `?license=` entry flows. The Plus features — `year-plan.js` (Plan your year), `year-review.js` (Your year in review) and `paint-palettes.js` — live inside Horizon and receive `ctx.plus` from `app.js`; without Plus they stay visible with a badge and open the Plus dialog. On the server, `server/licenses.js` signs licences, `server/gifts.js` handles gift links and seats (one conditional `UPDATE` so redemptions can't exceed the limit), `server/creem.js` opens Creem checkouts at the prices of `src/lib/pricing.js` (team tiers and personal gifts alike, in the currency of the buyer's country from `request.cf.country`, with a partner's `affiliate_code` retried once without it if Creem refuses it), reads them back and checks webhook signatures, and `server/email.js` sends through Resend. A purchase is honoured only once its checkout is read from Creem or arrives in a signed webhook; both paths are idempotent, so one checkout always gives one licence id or one gift. The plus dialog's yearly ritual (Plan it, Print it, Check in, Look back) lives in `src/features/plus-cycle.js`, which previews the real printed pages scaled down (the year, the latest quarter check-in with enough closed days, the year in review), with sample data from `src/features/plus-samples.js` until the planner has its own; `src/features/plus-insights.js` draws its small preview of Insights, the weekday chart over the last twelve weeks.

Refunds: every paid checkout's Creem order id and mode are recorded (`orders`, migration 0005); an unmatched refund reads the orders of the 40 latest Creem checkouts delivered without one. `server/refunds.js` turns a signed `refund.created` or `dispute.created` webhook into revocations (transaction → order → checkout): a full refund or a dispute switches off the purchase's claim link and licence, or the gift link and every licence activated from it (gift licences carry a reference to their gift), and its order, so a checkout refunded before it was delivered never is; a partial refund only notifies the owner; a refund from the other Creem mode is ignored; one whose transaction can't be read waits (502, one email if Creem's retry fails too). `POST /api/plus/check` answers whether a licence was revoked, storing nothing, and `src/features/plus-check.js` asks it at most once a week when online; only a clear “revoked” switches Plus off on that planner, with a one-time notice, and the revoked licence is kept aside on the device and asked about weekly, so a Restore brings Plus back. The dashboard lists refunds and can revoke (a checkout not delivered yet too) or restore by hand; Restore puts a gift link back as it was.

## Safety boundaries

User-authored text inserted into HTML templates must pass through the existing escaping helpers. URLs are normalized before being exposed as links.

The public runtime configuration deliberately contains no owner-specific social or repository URLs. Production builds may inject them through environment variables without changing source files. Optional `CLOUD_API_URL`, `GOOGLE_CLIENT_ID` and `PLANNER_API_URL` values may also be injected. When the Google client ID is absent, Personal sync renders nothing and makes no Google request; when the cloud API URL is absent, the workspace feature makes no organization request; when the planner API URL is absent, no count, waitlist or feedback request is made.

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

Enterprise cloud functionality is intentionally outside the Personal planner runtime. A separate private service owns the server-side organization model, authentication, shared organization data, billing, and future team services. Personal sync is different: the public client can synchronize directly with the user's own cloud storage through a provider adapter, without routing Personal planner data through Daily Planner Cloud. The first Enterprise client boundary remains deliberately small: if `/v1/me` exposes organizations, the UI can reveal a workspace selector; Personal remains the default private planner and organization selection never reuses Personal data as team data.

The proposed boundary is described in [`docs/CLOUD_BOUNDARY.md`](./docs/CLOUD_BOUNDARY.md).
