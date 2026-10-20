/**
 * The partners page's words that depend on the deployment (pure, unit-tested):
 * where “Become a partner” goes and how the commission is said.
 *
 * `url`: DAILY_PLANNER_AFFILIATE_URL, the Creem affiliate sign-up link (Creem →
 * Growth → Affiliate Hub). Only an https address counts; without one, the
 * button opens the landing page's question form about the program.
 * `commission`: DAILY_PLANNER_AFFILIATE_COMMISSION as shown, e.g. “30%”; blank:
 * “a commission”, with no number.
 */

/** The question form of the landing page, about the partner program (from welcome/partners/). */
export const PARTNER_QUESTION_HREF = '../?ask=question&topic=partners#request';
const COMMISSION_MAX = 24;

/** A commission as shown: one short line of plain text (“30%”, “25% for a year”), or ''. */
export function cleanCommission(value) {
  return String(value ?? '').replace(/[\u0000-\u001f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, COMMISSION_MAX).trim();
}

/** The Creem sign-up link when it is an https address, else ''. */
export function affiliateHref(value) {
  const text = String(value ?? '').trim();
  return /^https:\/\/[^\s"'<>]+$/.test(text) ? text : '';
}

/**
 * { href, external, commission, earn, short, figure, big, of }: `earn` ends “you
 * earn …” (“30% of what they pay”, “a commission”), `short` reads before “on
 * every purchase …” (“30%”, “a commission”), `figure` and `big` are the
 * commission on its own (or “A commission”), `of` what it applies to.
 */
export function partnerPage({ url = '', commission = '' } = {}) {
  const link = affiliateHref(url);
  const rate = cleanCommission(commission);
  return {
    href: link || PARTNER_QUESTION_HREF,
    external: !!link,
    commission: rate,
    earn: rate ? `${rate} of what they pay` : 'a commission',
    short: rate || 'a commission',
    figure: rate || 'A commission',
    big: rate || 'A commission',
    of: 'on every purchase made through your link'
  };
}
