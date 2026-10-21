# Changelog

Notable changes to published Daily Planner releases.

## 1.30.0 — 2026-10-21

- **Opening the planner**: no more empty shell that jumps into place (layout shift 0.26 → 0 on a computer). The page shows plain paper in the right theme until the day is drawn, then — once per tab, on a visible cold open — the header settles in, the hour grid fades in and the plan and the schedule rise in turn, all within 600 ms, with clicks and keys working from the first frame. Skipped with reduced motion, in the background, before first-run setup, for activation/gift/checkout links or a dialog open on load; a short fade on slow devices; the planner shows on its own after 2.4 s if the script fails. The head script also sets the browser's colour scheme and toolbar colour for a saved theme before first paint.
- **`/teams/` and `/partners/` are the real addresses** of the Teams and Partners pages. `/welcome/teams/…` and `/welcome/partners/…` redirect there (301, query and hash kept); the old short-link redirects are gone, the old addresses aren't cached (`no-store`), and `/welcome/teams/` and `/welcome/partners/` (where 1.28's short links pointed) clear the browser's HTTP cache (`Clear-Site-Data: "cache"`, to remove after 2027-01-31) so a remembered 1.28 redirect can't loop in Chromium. `/welcome/#teams` opens the Teams page at the top. Every link in the pages, the planner, the legal pages and the docs is updated; the dev server applies `_redirects` like Cloudflare (`scripts/redirects.mjs`).
- `DAILY_PLANNER_SUPPORT_EMAIL` and `DAILY_PLANNER_PRIVACY_EMAIL` accept `<address>` and `Name <address>` (one shared reading, `emailAddress` in `src/lib/text.js`; two addresses are refused); the dashboard's Setup says what it read. Without the owner API, the request form writes an email to the support address.
- **Blocked storage**: when the browser refuses site data, the planner no longer fails to start: it keeps plans in memory for that tab and says so (“This browser won’t keep your plans.”), over first-run setup if needed.
- Before its entrance the hidden planner is inert (no focus, no clicks, nothing for screen readers), released at the reveal or after 2.4 s.
- **Offline**: only the planner's own address falls back to the planner; another page that isn't cached (Teams, Partners, welcome, legal) shows a small “You’re offline” page with a way back to the planner.

## 1.29.1 — 2026-10-21

- **Ask a question** is a plain contact form: email, name and the question (plus consent) — no company, plan, number of people or timing; the panel reads “Contact · Ask a question”, and links from other pages land on it focused. The API accepts a question without the team fields (invoice, quote and talk still require them); the owner email and the dashboard (“Requests and questions”, Needs your attention) show it as a question.
- Legal notice: `DAILY_PLANNER_LEGAL_PHONE` is written as `+33…` (no leading 0, no spaces) and shown with the country's usual grouping (`+33 1 99 00 12 34`, `+1 514 555 0123`, UK, Belgium, Switzerland, Germany; other countries in groups), linked as `tel:+33…`; the dashboard's Setup shows how it will read. Legal variables are Text, not secrets.

## 1.29.0 — 2026-10-21

- **Welcome page hero**: the Day replica now alternates with a Horizon replica (the year at a glance, the Misogi, mini-adventures; a key date lands on the map, an adventure is ticked, the Misogi reaches its last milestone) in the same window, with a “Your day · Your year” switch whose line fills until the next view, and a pause button. Pointing at the replica or focusing the switch waits; a hidden tab or a hero out of view stops the scene. Reduced motion or no JavaScript: no rotation, the switch shows each view's final frame.
- Insights: the outline of a hovered or focused mark (heatmap cells, week rows, columns, bars, stacks, streaks, year-over-year rows) sits above its neighbours on every side; marks reached with the arrow keys scroll fully into view.
- Legal pages: new build variables `DAILY_PLANNER_PRIVACY_EMAIL` (privacy questions and rights, else the support address) and `DAILY_PLANNER_LEGAL_PHONE` (recommended: a Phone row in the legal notice); every address is a real `mailto:`/`tel:` link; the director of publication is a row of the publisher table; the cookies page has a Questions section; the build writes the configured details into the legal pages, so they show without JavaScript; the terms say plainly that a full refund or a dispute earns nothing and a partial refund of a team gift lowers its commission in proportion. Dated 21 October 2026. Owner dashboard Setup flags a value that is set but not used (not a plain email address, not a phone number).
- Thin scrollbars without arrows in Chrome and Edge everywhere — the planner, its modals (the thumb now darkens on hover), the floating window, the dashboard, the welcome, Teams, Partners and legal pages: the standard `scrollbar-width`/`scrollbar-color` now apply only where `::-webkit-scrollbar` is unsupported, since Chromium drops the custom parts when they are set.
- Hero details: the caption shows from first paint (the welcome page's largest paint is back under half a second on a computer), a paused hero stays paused when reduced motion is turned off, and Horizon fills the window on narrow screens. The dev server reads the legal and partner variables from `DAILY_PLANNER_*`.

## 1.28.0 — 2026-10-20

- **Teams page** (`/welcome/teams/`, short link `/teams`): the team gift, how seats work, team prices and checkout, the “Invoice, quote or question” form and a Teams FAQ moved off the welcome page, which now ends Pricing with a banner to it. Old links (`/welcome/?ask=…#request`, `#teams`, `#team-prices`, `#seats`) lead to the same place on the Teams page; every “Ask a question” link points there. A request sends the visitor's partner code, if any, and the owner sees it.
- **Partner program terms**: 25% of the price before tax of Plus, Give Plus and Plus Family, tracked and paid by Creem; 10% of a team gift a partner introduced, paid by the owner by bank transfer (team checkouts are no longer sent to Creem with an affiliate code); a link counts for 30 days (was 60); a sale earns once its 14-day refund period has passed with no refund or dispute; payouts from €50/$50. Anyone can be a partner. The terms have a Partner program section. `DAILY_PLANNER_AFFILIATE_COMMISSION` is removed (the rates live in `PARTNER_PROGRAM`, `src/lib/pricing.js`).
- **Partners page** rebuilt: key figures, an example month, what each sale earns before tax, the rules, a “Bringing a company?” callout, an FAQ that opens smoothly, and sections that rise in like on the welcome page (shared `welcome/page-motion.js`).
- Owner dashboard: the Partners card shows what you owe for team gifts (with Mark as paid / Undo) apart from Creem's commissions, each sale as pending, earned, paid, refunded or disputed; earned, unpaid team commissions appear in Needs your attention; team requests show the partner code. A code Creem has never credited is marked “Not confirmed” (check it in Creem → Affiliate Hub before paying, or mark it “Not a partner”); a team sale with a refund of unknown amount shows “At most …” and asks what you paid. Team sales opened before 1.28 (sent to Creem with the code) stay Creem's to pay; 1.28 team checkouts carry a sealed `payout: 'owner'` marker. Run `migrations/0007_partner_commissions.sql` (until then the card lists sales without the payout tools).
- In the planner, everyone is invited to become a partner (a quiet line in the Plus window, the share sheet, and Help → Partners), not only Plus members.
- Insights: chart details stay inside the chart's card and the visible part of the window, flipping above or below and following keyboard focus and zoom on phones.

## 1.27.0 — 2026-10-20

- **Tips the first time you open a dialog**: Close day, the block editor, the weekly review, Horizon, the journal, Unresolved, Time stats and Insights, search and Settings each show a short spotlight guide once (Esc or Got it closes only the guide; typing is never blocked). How it works → Tips → Show tips again.
- The tour sets the names of what it points at in bold; every How it works item does too. The How it works rows keep their button on the right on a computer; View on GitHub and Sponsor on GitHub carry the GitHub mark, under “Source code” (source-available, not open source).
- **Launch price**: Plus shows a “Launch price” badge and says it: paid once during the launch, yours for life; after the launch, Plus becomes a yearly subscription for new members. The terms say launch buyers (and people who activate a gift bought during the launch) keep Plus for life.
- **Member price on gifts**: with Plus, Give Plus costs €24/$24 instead of €29/$29 and Plus Family €79/$79 instead of €99/$99, checked by the server from the member's licence (never sent to Creem).
- **Partners**: a Partners page (`/welcome/partners/`) explains the program run through Creem's Affiliate Hub; the partner code of each paid sale is recorded (migration `0006_partners.sql`) and the dashboard's Partners card shows sales by code. Quiet, dismissible invitations to become a partner in the Plus window (members), after a share image, on the gift page and in the team section. New build variables `DAILY_PLANNER_AFFILIATE_URL` and `DAILY_PLANNER_AFFILIATE_COMMISSION`.
- If a member price cannot be confirmed, checkout says so and asks before going on at the usual price. Partner sales are recorded only from sealed checkouts; the Partners card keeps test sales apart and subtracts partial refunds. A guide closes on any key other than Esc, Enter, the arrows, Tab and Space, and that key still reaches the planner. Close day fits a 360 × 640 phone.

## 1.26.0 — 2026-10-20

- **A guided tour of the planner**: right after setup (once), a spotlight tour shows each part — Day · Week · Horizon, moving through days, outcomes and tasks, the schedule, Close day, the year, the journal and Unresolved, stats and Insights, search, the floating window and print, Settings and Help — with each keyboard shortcut on a computer and a phone version that follows the bottom tabs. Existing users are offered it once; it is always in How it works and, on a phone, in More.
- Owner dashboard: **Needs your attention** at the top lists everything to act on, most urgent first, with how long ago it started and a link to the exact row; the cards concerned are marked, and the panel says “All clear” when nothing is due.
- Stats: Day, Week and Insights always sit on one row, with room around the Plus badge.
- Landing page: the arrows of the gift, Plus Family and team links no longer sit on their icons; “Everything in Free” in the Plus card has the app's colour.

## 1.25.0 — 2026-10-20

- **Share your week and your year (free)**: closing the last day of the week offers “Share your week”, and Horizon → Progress offers “Share your year” — an image drawn on the device (square, story or landscape; paper or ink) in your palette, shared, copied or downloaded. Private text (a lesson, the Misogi) appears only when you switch it on.
- **Plus: Quarterly check-ins** — ten guided minutes as each quarter ends: the quarter's days, habit, time, Horizon and journal; two questions; the next quarter's habit and what to reschedule; a one-page print with room to write by hand. A card in Horizon from two weeks before a quarter ends to four weeks after.
- **Plus: Insights** — in Stats and from Progress: findings in plain words, weekday rates and a focus heatmap, hours by category over time, outcomes per week and what happens to unfinished work, streaks, and this year against last. Computed on the device; free users see a sample.
- Plus is now told as a four-step ritual (plan, print, check in, look back) plus Insights; the “Coming to Plus” list is gone.
- **Floating window (Picture-in-Picture)**: a new Focus view (the block in progress with time left, what's next, the main outcome and the next tasks), a Plan that never crops wrapped rows and a Schedule timeline with no sideways scrolling; its arrows always move one day, in step with the main window; light and dark follow the app; Plan ends with a folded Unresolved list. Browsers without Picture-in-Picture no longer show the button.
- “Now” slides in the right direction, like the arrows, in Day, Week and the floating window.
- Plan your year offers the previous year's key dates on the same days (29 February becomes 28), once.
- Owner dashboard: shows its version, warns when a cached copy is older than the deployed one and reloads it; a `_headers` file makes pages, scripts and styles revalidate on every visit.

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
