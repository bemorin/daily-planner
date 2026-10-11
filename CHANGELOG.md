# Changelog

Notable changes to published Daily Planner releases.

## 1.21.0 — 2026-10-11

- Payments move to **Creem**, a merchant of record that charges the right tax worldwide and sends receipts and invoices. Plus and the team gift are bought right from the planner and the landing page in EUR or USD; the team gift's price comes from the pack chosen. A webhook delivers the gift link, or a Plus activation link, by email even if the buyer closes the page.
- The Plus dialog shows what Plus adds with previews built from your own year (the parts of Horizon it fills, your painted year, your weeks in each palette), what is coming to Plus at no extra cost, and a field for a gift link or a licence.
- Week view shows your plan too: each day's main outcome and progress sit above its column, and on a phone the Plan tab lists the week day by day. Day view gives the plan a Plan heading with how much is done. On a phone, Plan and Schedule say where you stand (“2 of 6 done”, “Next 17:30”).
- Horizon is one tap away in the phone header.
- Feedback is asked once per feature release (1.21, not every fix), in a dialog with what's new, a rating, and an opt-in to be quoted on the website.
- Landing page: the hero shows the Close day dialog before the day paints, pricing makes the coming Plus features obvious, and buyers land on their “gift page”.
- Owner dashboard: trends by week, month and year with comparisons, funnels (landing, team gift, Plus), usage by section and installs, reviews, revenue per currency, Creem setup, and an “Open in the planner” link for licences. Anonymous counts now include daily, weekly and monthly active devices and the sections used, each at most once per period on a device.

## 1.20.0 — 2026-10-09

- Add **Daily Planner Plus**, a one-time unlock for life (the planner itself stays free): **Plan your year**, a guided session that sets up Horizon (look back, Misogi, milestones, six mini-adventures, three commitments, quarterly habits, key dates) and ends with printing the year; **Your year in review**, one printable page with days closed, the painted year, streaks, trophies, outcomes, time by category, the Horizon results and a few memories and lessons; and five colour palettes for the painted year. Without Plus they stay visible with a badge.
- Add team gifts: a company gives Plus to its people with one link. Each person who opens it sees the company's message and activates Plus on their planner — no account, no names collected. Plus is verified on the device and carried to other devices by sync and backups.
- Add **Print the year**: Horizon prints the year on one landscape page (Misogi, milestones, adventures, commitments, habits, a 12-month map of dates and the painted year); an empty year prints as a map to fill in by hand.
- Manage categories from the block editor (**Manage** next to Category), in a dialog that returns to the block you were editing.
- Tooltips wrap inside their box and stay on screen, above the button when there is no room below (Close day Save and Forget, the painted year).
- Leave the account-sync waitlist from the sync guide at any time.
- Landing page: Plus and the team gift with prices in EUR or USD, Stripe checkout or invoice, how seats work, a page where buyers get and manage their gift link, the journal, Unresolved and stats, a one-at-a-time FAQ, scroll animations without a flash on load, and legal links.
- Owner dashboard: team gifts (create, seats used, message, links), Plus licences for support, a setup checklist, app-style menus, and email through Resend: notifications, the gift link to buyers, and the waitlist announcement, after which each address is deleted. Database migrations can be pasted into the Cloudflare D1 console.

## 1.19.0 — 2026-10-09

- Add a landing page at `/welcome/`: animated replicas of the Day view, Close day, Week, Horizon, Progress and sync across devices, the New Year kit for teams (request form and “Send this to my manager”), pricing and FAQ. Light and dark, phone to desktop, static with reduced motion. Help links to it.
- Close day and Unresolved now say **Save** (keep it without a date) and **Forget** (remove it) instead of Keep and Drop. The daily loop in setup reads Plan · Do · Close · Decide.
- Setup: the three promises have icons, the week preview shows the hours you choose (its ruler and sample blocks move as you change “Show my day from”), and Appearance uses the same icons as Settings.
- Day and Week: a block that starts above the visible part of the schedule keeps its title and check on screen; a block finished early no longer stays highlighted as current (it shows a quiet “now” ring); the schedule’s add button says “Add a block”; long outcomes and tasks are no longer cut to one line on phones.
- Progress: the hover and focus outline of the painted year is no longer cropped on the first row. Tooltips inside dialogs now appear above them.
- Privacy: when the owner API is switched on, a Privacy notice (Settings, Help, setup, waitlist and feedback forms) lists exactly what is counted and stored, with a per-device switch for anonymous counts. Nothing is shown when the API is off, because nothing is sent.
- Owner dashboard: two-factor sign-in with an authenticator app and 8-hour signed sessions (the token is never stored), team kit requests with a demand funnel, CSV export and delete, a clear message when the API isn’t running, and `/admin` without a trailing slash now loads correctly. `npm run admin:secret` generates the token and the two-factor secret.

## 1.18.0 — 2026-10-09

- Rebuild first-run setup as four short steps — welcome, your week, your day, your year — each with its own illustration of the planner, a live preview of the days you pick, and a Back button. The last step can set the appearance and install the app.
- Add **Progress** to Horizon (`7`): the year paints itself one square per closed day (deeper when the main outcome was done, deepest when the winning habit was kept), a forgiving streak that only counts planning days, two jokers a month for missed days, and days before your first closed day stay neutral. Open any past square to revisit that day.
- Add a trophy room: twenty trophies earned by what you do in your life (closed days, streaks, outcomes, lessons, memories, Misogi, mini-adventures, commitments, habits). Every trophy is visible from day one with its progress, and the closest ones are shown first. Closing a day now shows the month being painted, the streak and any new trophy.
- Year map: click anywhere in a month to add a key date there, like mini-adventure slots — no more aiming for the small `+`.
- Credit Jesse Itzler for the Misogi and mini-adventure rhythm, in Horizon and in setup.
- Month calendars no longer show a sixth row from the next month when the month fits in five (or four) weeks.
- Add an **Install the app** dialog in the planner's style, with steps for the browser you are using (one-click install where the browser supports it, Share → Add to Home Screen on iPhone and iPad, Dock on Safari for Mac). Available from Settings, the More menu, Help, and the end of setup, and offered once after a few closed days.
- Add **Sync on all my devices**: an animated three-step guide to the free Google Drive sync, then — only for people who still want it — a waitlist for account sync with explicit consent.
- Add in-app feedback tied to the app version: a rating and a sentence, asked at most once per version after real use, never twice for the same version.
- Add an optional owner API (Cloudflare Pages Functions + D1, or the local dev server) and a private dashboard at `/admin/` for anonymous daily counts, waitlist sign-ups and feedback by version. It is off unless `PLANNER_API_URL` is set; the planner's own data is never sent.

## 1.17.0 — 2026-10-09

- Rebuild Horizon around a section rail — Overview, Misogi, Mini-adventures, Commitments, Winning habits and Year map — instead of one long scroll. Each section shows its progress in the rail; on phones the rail becomes a swipeable tab strip.
- Add a Horizon Overview with a year-at-a-glance ribbon (Misogi, milestones, adventures, key dates and quarterly habits on one timeline with a Today marker), the next upcoming moments, and one tile per section.
- Add one **Add** chooser for every Horizon element (key date, mini-adventure, milestone or Misogi, commitment, winning habit) that shows what is left and explains why a kind is unavailable. `1`–`6` switch sections and `+` opens the chooser.
- Show mini-adventures as six slots with Idea / Planned / Lived states, give milestones and dates consistent date chips, and hide Winning-habit statistics until a habit exists.
- Make the Year map quieter: empty months and past months recede (empty months collapse on phones), and adding a key date is one click from any month or the section header. Pressing Enter in a new key date moves straight to its dates.
- Add an Appearance setting (System, Light, Dark) with a full dark theme, stored per device and never included in backups or sync.
- Add purposeful motion with the vendored Motion library (dialogs, popovers, section changes, list additions, habit activity, day and week navigation). Motion is skipped entirely when the system asks for reduced motion.
- Add `Start Daily Planner.bat` and `npm start`: a zero-dependency local server that keeps the same address (and therefore the same browser data), opens the browser, and can serve the production build or the local network.

## 1.16.1 — 2026-08-16

- Restore date and time pickers across Settings, Add/Edit, and Horizon, including Misogi periods and key dates.
- Add an explicit week-start setting and make Week plus calendar pickers honor it.
- Let displayed schedule hours be typed or selected while keeping the control consistent with Add/Edit.
- Keep mobile Day navigation compact, add planning-day swipe navigation, and preserve the same navigation order in Picture-in-Picture.
- Improve narrow Week blocks so metadata never runs underneath the completion control.
- Improve mobile header and overflow-menu touch targets, move Horizon into More on mobile, and fix the Misogi placeholder on narrow screens.
- Keep the optional Enterprise workspace boundary isolated from Personal data.

## 1.16.0 — 2026-08-15

- Initial public release of Daily Planner: a local-first browser planner with Day and Week planning, Close day, Unresolved, Journal, Horizon, statistics, PWA install, and a verified production build.
