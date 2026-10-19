# Changelog

Notable changes to published Daily Planner releases.

## 1.24.0 — 2026-10-19

- **Refunds switch Plus off.** A full refund or a dispute received from Creem (`refund.created`, `dispute.created`) switches off the purchase's activation link and its licence, or the gift link and every licence activated from it; a partial refund only notifies the owner. Planners ask about once a week, when online, whether their licence still holds (only the licence is sent) and show a one-time notice if it was revoked. A refund that arrives before the purchase is delivered blocks the delivery. The dashboard lists refunds and disputes (including ones still waiting for Creem) and can revoke or restore by hand; a restored licence comes back on its planners at their next weekly check. Run `migrations/0005_refunds.sql` and add the two webhook events in Creem.
- **Your year in review, printed**: a new one-page design — the year as a typographic title, large figures, the painted year in your palette as the centrepiece, time by category, Horizon results, memories and lessons, and trophies — that stays clean with little data.
- Planner header: ‹ Now › stays in place and the date reads to its right, whatever the month.
- Daily Planner Plus window: a price card beside the title (price, currency line, Get Plus, gift link or licence), a sticky Get Plus bar, a calmer page, no sideways scrolling; a refunded purchase link says so.
- Setup: the daily loop as numbered cards with an “Every day” loop line; Appearance offers Light or Dark with the system's preselected and kept; Install the app and Back have icons.
- Help hides keyboard shortcuts on phones and touch screens.
- Landing page: the request form's button sits on the right; “Colours for your painted year” recolours a whole painted year as you try each palette; the Plus offer is one clear block (what you get, a price card, gift, Plus Family and team links). The gift page explains a link switched off after a refund.
- Legal pages: “On this page” highlights the section you are reading.

## 1.23.0 — 2026-10-19

- **Daily Planner Plus, a yearly ritual**: the Plus window is built around three steps — Plan it (a guided half hour), Print it (the year on one page, filled in by hand all year) and Look back (Your year in review on one printed page) — with “Make 2027 count.” as its headline. Each step shows the real page: the printed year and the year in review from your own planner, or a sample until there is enough to show, with Enlarge to read them. With Plus, each step has its action (Plan 2027, Print the year, Open your review).
- From 1 October, Plan your year prepares next year.
- A finished year's review says “of 219 planning days” instead of “so far”.
- **Legal pages on this site**: Legal notice, Privacy, Terms and Cookies live at `/legal/` (short links `/privacy`, `/terms`, `/cookies`), linked from the planner, the landing page and the gift page. Owner details come from three new build variables (`DAILY_PLANNER_SUPPORT_EMAIL`, `DAILY_PLANNER_LEGAL_ADDRESS`, `DAILY_PLANNER_LEGAL_REGISTRATION`); the dashboard's Setup checklist says which are missing and lists the links Creem asks for.
- Landing page: “What this page counts” opens an app-style dialog (with the same anonymous-counts switch as the planner) instead of a paragraph in the footer; the hero says it works on your computer, tablet and phone and installs like an app; “Yours, on every device” shows all three; a “Plan 2027 in 30 minutes” link leads to Plus, now “Make 2027 count.” with the three-step ritual and a printed year map with pen marks.
- Counted moments on the landing page use the current names (team gift, request form).

## 1.22.0 — 2026-10-19

- **Day · Week · Horizon**: the year sits beside the day and the week at the top of the planner (V and Y on a keyboard). On a phone, Horizon is the third tab at the bottom, next to Plan and Schedule, and says what comes next; the tab bar stays visible while Horizon is open.
- Every menu in the planner, on the landing page and in the dashboard looks and works like the app's own (keyboard included); number fields use a − / + stepper with one-click choices instead of the browser's arrows.
- **Give Plus** (one person) and **Plus Family** (up to five people in one household) are sold as gift links, from the landing page and the Plus window. Personal gifts and other gifts under 10 seats activate exactly their seats; team gifts keep their 10% margin for reinstalls.
- The welcome note in setup is signed Ben Morin.
- Prices follow the buyer's country: euros in the euro area, US dollars elsewhere. The currency switch is gone and the server charges the right currency.
- Partner links (`?ref=CODE`) are remembered for 60 days on the device and credited through Creem's affiliate program; a stale code never blocks a purchase.
- Landing page: pricing shows Free and Plus with a “Compare plans” table, team tiers live in the team gift section, the progress section comes before the week, and “Questions” stays in view beside the FAQ.

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
