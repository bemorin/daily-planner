// Cloudflare D1 implementation of the planner API store.
// Schema: migrations/0001_planner_api.sql, migrations/0002_team_requests.sql,
// migrations/0003_plus.sql, migrations/0004_creem_reviews.sql, migrations/0005_refunds.sql,
// migrations/0006_partners.sql, migrations/0007_partner_commissions.sql
// Reads that join a 0007 table fall back to the older query while it is
// missing, and writes to it are skipped, so a deployment works before the
// migration is applied (the dashboard says it is missing).
// Every value goes through bound parameters (D1 allows at most 100 per query,
// so id lists are deleted in chunks).
// The stripe_session columns of gifts and purchases hold the checkout reference
// (a Creem checkout id; older rows may hold an earlier reference).

import { normalizeGift } from './gifts.js';
import { normalizePartnerSale, normalizePayout } from './partners.js';

const waitlistColumns = 'id, email, devices, note, locale, app_version AS appVersion, drive_seen AS driveSeen, created_at AS createdAt';
const feedbackColumns = 'id, app_version AS appVersion, rating, kind, message, email, platform, created_at AS createdAt';
const teamColumns = 'id, email, name, company, team_size AS teamSize, timing, plan, currency, kind, message, locale, app_version AS appVersion, source, created_at AS createdAt';
const giftColumns = 'code, org, message, seats, redeemed, active, currency, amount, source, stripe_session AS checkoutRef, buyer_email AS buyerEmail, note, created_at AS createdAt, expires_at AS expiresAt, emailed_at AS emailedAt';
const purchaseColumns = 'stripe_session AS checkoutRef, kind, license_id AS licenseId, claims, email, note, created_at AS createdAt';
// Columns an owner may change, by field name. Names come from this list only; values are bound.
const GIFT_EDITABLE = Object.freeze({ org: 'org', message: 'message', seats: 'seats', active: 'active', note: 'note' });
const paymentColumns = 'checkout_id AS checkoutId, kind, plan, seats, amount, currency, country, created_at AS createdAt, emailed_at AS emailedAt';
const reviewColumns = 'id, app_version AS appVersion, rating, text, name, created_at AS createdAt';
const orderColumns = 'order_id AS orderId, checkout_id AS checkoutId, kind, mode, created_at AS createdAt';
const refundColumns = 'id, kind, order_id AS orderId, transaction_id AS transactionId, checkout_id AS checkoutId, item, amount, currency, full_refund AS fullRefund, scope, reason, revoked, status, note, attempts, created_at AS createdAt';
const revocationColumns = 'target, source, kind, label, reason, note, was_active AS wasActive, created_at AS createdAt';
const partnerSaleColumns = 'checkout_id AS checkoutId, code, kind, plan, amount, currency, member, mode, created_at AS createdAt';
const payoutColumns = 'checkout_id AS checkoutId, code, amount, currency, note, paid_at AS paidAt';
const isMissingTable = error => /no such table/i.test(String(error?.message || ''));
/** The first query, or the second when the first needs a table that isn't there yet (migration 0007). */
const withFallback = async (query, fallback) => { try { return await query(); } catch (error) { if (isMissingTable(error)) return fallback(); throw error; } };
const skipMissing = error => { if (!isMissingTable(error)) throw error; return 0; };
const refundRow = row => (row ? { ...row, amount: row.amount == null ? null : Number(row.amount), fullRefund: Number(row.fullRefund) === 1, attempts: Number(row.attempts) || 0, ...(row.inForce === undefined ? {} : { inForce: Number(row.inForce) === 1 }) } : null);
const revocationRow = row => ({ ...row, wasActive: row.wasActive == null ? null : Number(row.wasActive) === 1 });
const ID_CHUNK = 90;
const nextDay = day => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

export function createD1Store(db) {
  const all = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results || [];
  const run = async (sql, ...params) => Number((await db.prepare(sql).bind(...params).run()).meta?.changes) || 0;
  const purchaseRow = row => (row ? { ...row, claims: Number(row.claims) || 0 } : null);
  return {
    async addGift(gift) {
      // Neither a code nor a checkout reference can be stored twice; the caller tells which.
      return await run('INSERT INTO gifts (code, org, message, seats, redeemed, active, currency, amount, source, stripe_session, buyer_email, note, created_at, expires_at, emailed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        gift.code, gift.org, gift.message, gift.seats, gift.redeemed, gift.active ? 1 : 0, gift.currency, gift.amount, gift.source, gift.checkoutRef || null, gift.buyerEmail, gift.note, gift.createdAt, gift.expiresAt, gift.emailedAt || null) > 0;
    },
    getGift: code => all(`SELECT ${giftColumns} FROM gifts WHERE code = ?`, code).then(([row]) => normalizeGift(row)),
    getGiftByCheckout: ref => all(`SELECT ${giftColumns} FROM gifts WHERE stripe_session = ?`, ref).then(([row]) => normalizeGift(row)),
    listGifts: ({ limit = 0 } = {}) => (limit
      ? all(`SELECT ${giftColumns} FROM gifts ORDER BY created_at DESC, code LIMIT ?`, limit)
      : all(`SELECT ${giftColumns} FROM gifts ORDER BY created_at DESC, code`)).then(rows => rows.map(normalizeGift)),
    /** `paid`: gifts bought online (every source but 'manual'). */
    giftTotals: () => all('SELECT COUNT(*) AS count, COALESCE(SUM(seats), 0) AS seats, COALESCE(SUM(redeemed), 0) AS redeemed, COALESCE(SUM(CASE WHEN source <> ? THEN 1 ELSE 0 END), 0) AS paid FROM gifts', 'manual')
      .then(([row]) => ({ count: Number(row?.count) || 0, seats: Number(row?.seats) || 0, redeemed: Number(row?.redeemed) || 0, paid: Number(row?.paid) || 0 })),
    /**
     * One activation in a single statement: the WHERE clause re-checks the
     * limit (giftLimit in gifts.js: seats + max(1, seats / 10) from 10 seats, exactly the seats below), so concurrent requests can never
     * push `redeemed` past it.
     */
    redeemGift: async (code, nowIso) => await run('UPDATE gifts SET redeemed = redeemed + 1 WHERE code = ? AND active = 1 AND expires_at > ? AND redeemed < seats + CASE WHEN seats >= 10 THEN MAX(1, seats / 10) ELSE 0 END', code, nowIso) === 1,
    unredeemGift: async code => await run('UPDATE gifts SET redeemed = redeemed - 1 WHERE code = ? AND redeemed > 0', code) === 1,
    async updateGift(code, fields) {
      const names = Object.keys(GIFT_EDITABLE).filter(name => fields[name] !== undefined);
      if (!names.length) return false;
      const values = names.map(name => (name === 'active' ? (fields.active ? 1 : 0) : fields[name]));
      return await run(`UPDATE gifts SET ${names.map(name => `${GIFT_EDITABLE[name]} = ?`).join(', ')} WHERE code = ?`, ...values, code) > 0;
    },
    deleteGift: async code => await run('DELETE FROM gifts WHERE code = ?', code) > 0,
    markGiftEmailed: async (code, iso) => await run('UPDATE gifts SET emailed_at = ? WHERE code = ? AND emailed_at IS NULL', iso, code) === 1,
    clearGiftEmailed: async code => { await run('UPDATE gifts SET emailed_at = NULL WHERE code = ?', code); },
    getPurchase: ref => all(`SELECT ${purchaseColumns} FROM purchases WHERE stripe_session = ?`, ref).then(([row]) => purchaseRow(row)),
    addPurchase: async row => await run('INSERT INTO purchases (stripe_session, kind, license_id, claims, email, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(stripe_session) DO NOTHING',
      row.checkoutRef, row.kind, row.licenseId, row.claims, row.email || '', row.note || '', row.createdAt) > 0,
    claimPurchase: async (ref, max) => await run('UPDATE purchases SET claims = claims + 1 WHERE stripe_session = ? AND claims < ?', ref, max) === 1,
    purchaseTotals: () => all('SELECT kind, COUNT(*) AS count FROM purchases GROUP BY kind').then(rows => {
      const count = kind => Number(rows.find(row => row.kind === kind)?.count) || 0;
      return { plus: count('plus'), manual: count('manual') };
    }),
    listPurchases: ({ kind = '', limit = 50 } = {}) => (kind
      ? all(`SELECT ${purchaseColumns} FROM purchases WHERE kind = ? ORDER BY created_at DESC LIMIT ?`, kind, limit)
      : all(`SELECT ${purchaseColumns} FROM purchases ORDER BY created_at DESC LIMIT ?`, limit)).then(rows => rows.map(purchaseRow)),
    // Payments (migration 0004): one row per paid checkout, for the sales chart.
    addPayment: async row => await run('INSERT INTO payments (checkout_id, kind, plan, seats, amount, currency, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(checkout_id) DO NOTHING',
      row.checkoutId, row.kind, row.plan || '', row.seats ?? null, row.amount ?? null, row.currency || '', row.country || '', row.createdAt) > 0,
    getPayment: id => all(`SELECT ${paymentColumns} FROM payments WHERE checkout_id = ?`, id).then(([row]) => row || null),
    /** Payments made between two UTC days, both included. */
    listPayments: ({ fromDay, toDay }) => all(`SELECT ${paymentColumns} FROM payments WHERE created_at >= ? AND created_at < ? ORDER BY created_at, checkout_id`, fromDay, nextDay(toDay)),
    markPaymentEmailed: async (id, iso) => await run('UPDATE payments SET emailed_at = ? WHERE checkout_id = ? AND emailed_at IS NULL', iso, id) === 1,
    clearPaymentEmailed: async id => { await run('UPDATE payments SET emailed_at = NULL WHERE checkout_id = ?', id); },
    // Refunds (migration 0005): the order of each paid checkout, refunds and disputes, revocations.
    addOrder: async row => await run('INSERT INTO orders (order_id, checkout_id, kind, mode, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING',
      row.orderId, row.checkoutId, row.kind, row.mode || '', row.createdAt) > 0,
    getOrder: id => all(`SELECT ${orderColumns} FROM orders WHERE order_id = ?`, id).then(([row]) => (row ? { ...row } : null)),
    getOrderByCheckout: id => all(`SELECT ${orderColumns} FROM orders WHERE checkout_id = ? ORDER BY created_at LIMIT 1`, id).then(([row]) => (row ? { ...row } : null)),
    /** Creem checkouts (ch_…) delivered as a Plus purchase or a gift whose order is not recorded yet, newest first. */
    listCheckoutsWithoutOrder: (limit = 50) => all(`SELECT checkoutId, kind, note, createdAt FROM (
      SELECT stripe_session AS checkoutId, 'plus' AS kind, note, created_at AS createdAt FROM purchases WHERE kind = 'plus' AND substr(stripe_session, 1, 3) = 'ch_'
      UNION ALL SELECT stripe_session AS checkoutId, 'gift' AS kind, note, created_at AS createdAt FROM gifts WHERE substr(stripe_session, 1, 3) = 'ch_'
    ) AS paid WHERE NOT EXISTS (SELECT 1 FROM orders WHERE orders.checkout_id = paid.checkoutId) ORDER BY createdAt DESC, checkoutId LIMIT ?`, limit),
    addRefund: async row => await run('INSERT INTO refunds (id, kind, order_id, transaction_id, checkout_id, item, amount, currency, full_refund, scope, reason, revoked, status, note, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      row.id, row.kind, row.orderId || '', row.transactionId || '', row.checkoutId || '', row.item || '', row.amount ?? null, row.currency || '', row.fullRefund ? 1 : 0, row.scope || '', row.reason || '', row.revoked || '', row.status || '', row.note || '', Number(row.attempts) || 0, row.createdAt) > 0,
    /** A refund waiting for its transaction, now processed. False when it was not waiting (already processed elsewhere). */
    completeRefund: async row => await run("UPDATE refunds SET kind = ?, order_id = ?, transaction_id = ?, checkout_id = ?, item = ?, amount = ?, currency = ?, full_refund = ?, scope = ?, reason = ?, revoked = ?, status = '', note = ?, created_at = ? WHERE id = ? AND status = 'pending'",
      row.kind, row.orderId || '', row.transactionId || '', row.checkoutId || '', row.item || '', row.amount ?? null, row.currency || '', row.fullRefund ? 1 : 0, row.scope || '', row.reason || '', row.revoked || '', row.note || '', row.createdAt, row.id) > 0,
    /** One more failed read of a waiting refund's transaction. */
    retryRefund: async (id, note) => await run("UPDATE refunds SET attempts = attempts + 1, note = ? WHERE id = ? AND status = 'pending'", note || '', id) > 0,
    /** True only the first time: the owner is told about a waiting refund once. */
    markRefundNotified: async id => await run('UPDATE refunds SET notified = 1 WHERE id = ? AND notified = 0', id) === 1,
    /** A refund matched later, when the checkout it refunded was delivered (and refused). */
    linkRefund: async (id, fields) => await run('UPDATE refunds SET checkout_id = ?, item = ?, revoked = ? WHERE id = ?', fields.checkoutId || '', fields.item || '', fields.revoked || '', id) > 0,
    getRefund: id => all(`SELECT ${refundColumns} FROM refunds WHERE id = ?`, id).then(([row]) => refundRow(row)),
    /** Newest first; `inForce` says whether what the refund revoked is still revoked (not restored). */
    listRefunds: ({ limit = 100 } = {}) => all(`SELECT ${refundColumns}, EXISTS (SELECT 1 FROM revocations WHERE revocations.source = refunds.id) AS inForce FROM refunds ORDER BY created_at DESC, id LIMIT ?`, limit).then(rows => rows.map(refundRow)),
    /** Rows already there (same target and source) are kept as they are. Returns how many were added. */
    async addRevocations(rows) {
      let added = 0;
      for (const row of rows) {
        added += await run('INSERT INTO revocations (target, source, kind, label, reason, note, was_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target, source) DO NOTHING',
          row.target, row.source, row.kind, row.label || '', row.reason || '', row.note || '', typeof row.wasActive === 'boolean' ? (row.wasActive ? 1 : 0) : null, row.createdAt);
      }
      return added;
    },
    /** True when any of the targets is revoked, by any source. */
    isRevoked: async targets => (targets.length ? (await all(`SELECT 1 AS hit FROM revocations WHERE target IN (${targets.map(() => '?').join(', ')}) LIMIT 1`, ...targets)).length > 0 : false),
    /** Every revocation of these targets (any source), oldest first. */
    async listRevocationsFor(targets) {
      const rows = [];
      for (let start = 0; start < targets.length; start += ID_CHUNK) {
        const chunk = targets.slice(start, start + ID_CHUNK);
        rows.push(...await all(`SELECT ${revocationColumns} FROM revocations WHERE target IN (${chunk.map(() => '?').join(', ')})`, ...chunk));
      }
      return rows.map(revocationRow).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.source).localeCompare(String(b.source)) || String(a.target).localeCompare(String(b.target)));
    },
    listRevocations: ({ limit = 500 } = {}) => all(`SELECT ${revocationColumns} FROM revocations ORDER BY created_at DESC, source, target LIMIT ?`, limit).then(rows => rows.map(revocationRow)),
    listRevocationsBySource: source => all(`SELECT ${revocationColumns} FROM revocations WHERE source = ? ORDER BY target`, source).then(rows => rows.map(revocationRow)),
    deleteRevocations: async source => await run('DELETE FROM revocations WHERE source = ?', source),
    // Partner sales (migration 0006): one row per paid checkout that came through a partner's link.
    // The tax included in a sale's amount is kept apart (migration 0007), skipped while that table is missing.
    async addPartnerSale(row) {
      const added = await run('INSERT INTO partner_sales (checkout_id, code, kind, plan, amount, currency, member, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(checkout_id) DO NOTHING',
        row.checkoutId, row.code, row.kind, row.plan || '', row.amount ?? null, row.currency || '', row.member ? 1 : 0, row.mode || '', row.createdAt) > 0;
      if (Number.isInteger(row.tax)) await run('INSERT INTO partner_sale_taxes (checkout_id, tax) VALUES (?, ?) ON CONFLICT(checkout_id) DO NOTHING', row.checkoutId, row.tax).catch(skipMissing);
      return added;
    },
    listPartnerSales: ({ limit = 2000 } = {}) => withFallback(
      () => all(`SELECT partner_sales.checkout_id AS checkoutId, code, kind, plan, amount, partner_sale_taxes.tax AS tax, currency, member, mode, created_at AS createdAt FROM partner_sales LEFT JOIN partner_sale_taxes ON partner_sale_taxes.checkout_id = partner_sales.checkout_id ORDER BY created_at DESC, partner_sales.checkout_id LIMIT ?`, limit),
      () => all(`SELECT ${partnerSaleColumns} FROM partner_sales ORDER BY created_at DESC, checkout_id LIMIT ?`, limit)
    ).then(rows => rows.map(normalizePartnerSale)),
    // Team commissions the owner marked as paid (migration 0007): one row per checkout.
    addPartnerPayout: async row => await run('INSERT INTO partner_payouts (checkout_id, code, amount, currency, note, paid_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(checkout_id) DO NOTHING',
      row.checkoutId, row.code, row.amount ?? null, row.currency || '', row.note || '', row.paidAt) > 0,
    listPartnerPayouts: () => all(`SELECT ${payoutColumns} FROM partner_payouts ORDER BY paid_at DESC, checkout_id`).then(rows => rows.map(normalizePayout)),
    deletePartnerPayout: async checkoutId => await run('DELETE FROM partner_payouts WHERE checkout_id = ?', checkoutId) > 0,
    /** Revocations of partner sales' checkouts ({ checkoutId, reason }): a refund, a dispute or the owner switched them off. Needs migration 0005 too. */
    partnerSaleStates: () => all("SELECT partner_sales.checkout_id AS checkoutId, revocations.reason AS reason FROM partner_sales JOIN revocations ON revocations.target = 'checkout:' || partner_sales.checkout_id"),
    /** Refunds of partner sales ({ checkoutId, amount, currency, fullRefund }), so partial ones come off the revenue. Needs migration 0005 too. */
    partnerSaleRefunds: () => all("SELECT refunds.checkout_id AS checkoutId, refunds.amount AS amount, refunds.currency AS currency, refunds.full_refund AS fullRefund FROM partner_sales JOIN refunds ON refunds.checkout_id = partner_sales.checkout_id WHERE refunds.status <> 'pending'")
      .then(rows => rows.map(row => ({ ...row, amount: row.amount == null ? null : Number(row.amount), fullRefund: Number(row.fullRefund) === 1 }))),
    // Reviews (migration 0004): feedback its author agreed may be quoted.
    async addReview(entry) {
      await run('INSERT INTO reviews (app_version, rating, text, name, created_at) VALUES (?, ?, ?, ?, ?)', entry.appVersion, entry.rating, entry.text, entry.name || '', entry.createdAt);
    },
    listReviews: ({ limit = 50 } = {}) => all(`SELECT ${reviewColumns} FROM reviews ORDER BY created_at DESC, id DESC LIMIT ?`, limit),
    deleteReview: async id => await run('DELETE FROM reviews WHERE id = ?', id) > 0,
    /** Counts per day and name between two UTC days (both included), summed across app versions; internal rows left out. */
    eventsSeries: (fromDay, toDay) => all("SELECT day, name, SUM(count) AS count FROM events WHERE day >= ? AND day <= ? AND name NOT LIKE 'internal:%' GROUP BY day, name ORDER BY day, name", fromDay, toDay)
      .then(rows => rows.map(row => ({ day: row.day, name: row.name, count: Number(row.count) || 0 }))),
    async countEvent(day, name, appVersion) {
      await db.prepare('INSERT INTO events (day, name, app_version, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, name, app_version) DO UPDATE SET count = count + 1')
        .bind(day, name, appVersion).run();
    },
    async addWaitlist(entry) {
      const result = await db.prepare('INSERT INTO waitlist (email, devices, note, locale, app_version, drive_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
        .bind(entry.email, entry.devices, entry.note, entry.locale, entry.appVersion, entry.driveSeen, entry.createdAt).run();
      return { duplicate: !(result.meta?.changes > 0) };
    },
    async addFeedback(entry) {
      await db.prepare('INSERT INTO feedback (app_version, rating, kind, message, email, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(entry.appVersion, entry.rating, entry.kind, entry.message, entry.email, entry.platform, entry.createdAt).run();
    },
    // A request's partner code is kept apart (migration 0007), skipped while that table is missing.
    async addTeamRequest(entry) {
      const sql = 'INSERT INTO team_requests (email, name, company, team_size, timing, plan, currency, kind, message, locale, app_version, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      const values = [entry.email, entry.name, entry.company, entry.teamSize, entry.timing, entry.plan, entry.currency, entry.kind, entry.message, entry.locale, entry.appVersion, entry.source, entry.createdAt];
      if (!entry.ref) {
        await db.prepare(sql).bind(...values).run();
        return;
      }
      const [row] = await all(`${sql} RETURNING id`, ...values);
      if (row?.id != null) await run('INSERT INTO team_request_partners (request_id, code, created_at) VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING', Number(row.id), entry.ref, entry.createdAt).catch(skipMissing);
    },
    listTeamRequests: ({ limit = 0 } = {}) => withFallback(
      () => all(`SELECT ${teamColumns.split(', ').map(column => `team_requests.${column}`).join(', ')}, COALESCE(team_request_partners.code, '') AS ref FROM team_requests LEFT JOIN team_request_partners ON team_request_partners.request_id = team_requests.id ORDER BY team_requests.created_at DESC, team_requests.id DESC${limit ? ' LIMIT ?' : ''}`, ...(limit ? [limit] : [])),
      () => all(`SELECT ${teamColumns}, '' AS ref FROM team_requests ORDER BY created_at DESC, id DESC${limit ? ' LIMIT ?' : ''}`, ...(limit ? [limit] : []))
    ),
    teamRequestTotals: () => all('SELECT COUNT(*) AS count, COALESCE(SUM(team_size), 0) AS seats FROM team_requests')
      .then(([row]) => ({ count: Number(row?.count) || 0, seats: Number(row?.seats) || 0 })),
    async deleteTeamRequest(id) {
      const result = await db.prepare('DELETE FROM team_requests WHERE id = ?').bind(id).run();
      await run('DELETE FROM team_request_partners WHERE request_id = ?', id).catch(skipMissing);
      return result.meta?.changes > 0;
    },
    eventTotals: ({ sinceDay }) => all('SELECT name, app_version AS appVersion, SUM(count) AS count FROM events WHERE day >= ? GROUP BY name, app_version ORDER BY name, app_version DESC', sinceDay),
    eventDaily: ({ sinceDay }) => all('SELECT day, name, SUM(count) AS count FROM events WHERE day >= ? GROUP BY day, name ORDER BY day, name', sinceDay),
    listWaitlist: () => all(`SELECT ${waitlistColumns} FROM waitlist ORDER BY created_at DESC, id DESC`),
    async deleteWaitlist(id) {
      const result = await db.prepare('DELETE FROM waitlist WHERE id = ?').bind(id).run();
      return result.meta?.changes > 0;
    },
    async deleteWaitlistByEmail(email) {
      const result = await db.prepare('DELETE FROM waitlist WHERE email = ?').bind(email).run();
      return result.meta?.changes > 0;
    },
    /** Oldest sign-ups first: the order a capped announcement goes out in. */
    oldestWaitlist: limit => all(`SELECT ${waitlistColumns} FROM waitlist ORDER BY created_at ASC, id ASC LIMIT ?`, limit),
    countWaitlist: () => all('SELECT COUNT(*) AS count FROM waitlist').then(([row]) => Number(row?.count) || 0),
    async deleteWaitlistIds(ids) {
      let removed = 0;
      for (let start = 0; start < ids.length; start += ID_CHUNK) {
        const chunk = ids.slice(start, start + ID_CHUNK);
        const result = await db.prepare(`DELETE FROM waitlist WHERE id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).run();
        removed += Number(result.meta?.changes) || 0;
      }
      return removed;
    },
    /** Emails sent on a UTC day, kept as an internal row of the counts table. */
    async addEmailSends(day, name, count) {
      await db.prepare('INSERT INTO events (day, name, app_version, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, name, app_version) DO UPDATE SET count = count + excluded.count')
        .bind(day, name, '', count).run();
    },
    emailSendsOn: (day, name) => all('SELECT COALESCE(SUM(count), 0) AS count FROM events WHERE day = ? AND name = ?', day, name).then(([row]) => Number(row?.count) || 0),
    async deleteFeedback(id) {
      const result = await db.prepare('DELETE FROM feedback WHERE id = ?').bind(id).run();
      return result.meta?.changes > 0;
    },
    listFeedback: ({ version = '', limit = 100 } = {}) => version
      ? all(`SELECT ${feedbackColumns} FROM feedback WHERE app_version = ? ORDER BY created_at DESC, id DESC LIMIT ?`, version, limit)
      : all(`SELECT ${feedbackColumns} FROM feedback ORDER BY created_at DESC, id DESC LIMIT ?`, limit),
    feedbackByVersion: () => all('SELECT app_version AS appVersion, COUNT(*) AS count, COUNT(rating) AS rated, ROUND(AVG(rating), 2) AS avgRating, MAX(created_at) AS lastAt FROM feedback GROUP BY app_version')
      .then(rows => rows.sort((a, b) => String(b.appVersion).localeCompare(String(a.appVersion), undefined, { numeric: true })))
  };
}
