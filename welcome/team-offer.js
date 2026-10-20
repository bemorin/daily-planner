import { TEAM_TIERS } from '../src/lib/pricing.js';
import { TEAM_ROWS, lowestPerPerson, perPerson, tierLabel, tierPrice } from './landing-model.js';
import { copyText, el, qs, qsa } from './page-kit.js';
import { checkout } from './sale.js';
import { invoiceAnswer, managerMessage } from './teams-model.js';

/* ============================================================================
   The team gift's offer on the Teams page: one row per tier (Buy online, or
   by invoice; a quote above the last tier), the optional talk, the lines
   that depend on what is on sale, and “Send this to my manager”.
   ============================================================================ */

const people = value => new Intl.NumberFormat('en-US').format(value);

/**
 * @param {object} options
 * @param {ReturnType<import('./sale.js').createSale>} options.sale
 * @param {(name: string) => void} options.track
 * @param {(request: { kind: string, plan?: string }) => void} options.openRequest
 * @param {() => void} options.refresh  Re-renders the page's prices (after the sale options changed).
 * @param {typeof import('./landing-settings.js').LANDING} options.settings
 */
export function createTeamOffer({ sale, track = () => {}, openRequest = () => {}, refresh = () => {}, settings }) {
  function renderTiers() {
    const box = qs('[data-tiers]');
    if (!box) return;
    const state = sale.state('gift');
    const rows = TEAM_ROWS.map(row => {
      const price = tierPrice(row, sale.currency);
      const named = tierLabel(row).toLowerCase();
      const quote = price == null;
      const look = `btn btn--tier ${row.highlight ? 'btn--light' : 'btn--outline-light'}`;
      const actions = [];
      if (quote) {
        actions.push(el('a', { class: look, href: '#request', 'data-request': 'quote', 'data-plan': row.plan, 'aria-label': `Ask for a quote for ${named}` }, 'Ask for a quote'));
      } else if (state.buyable) {
        actions.push(el('button', { class: look, type: 'button', 'data-buy': 'gift', 'data-plan': row.plan, 'aria-label': `Buy the team gift for ${named}, ${sale.money(price)}` }, 'Buy'));
        actions.push(el('a', { class: 'tier__link', href: '#request', 'data-request': 'invoice', 'data-plan': row.plan, 'aria-label': `Get the team gift for ${named} by invoice` }, 'Invoice'));
      } else {
        actions.push(el('a', { class: look, href: '#request', 'data-request': 'invoice', 'data-plan': row.plan, 'aria-label': `Get the team gift for ${named} by invoice` }, 'Get it by invoice'));
      }
      return el('div', { class: `tier${row.highlight ? ' is-highlight' : ''}${quote ? ' tier--quote' : ''}` },
        el('b', { class: 'tier__who' }, tierLabel(row), row.badge ? el('span', { class: 'tier__badge' }, row.badge) : null),
        el('small', { class: 'tier__per' }, quote ? (row.note || '') : `${perPerson(row, sale.currency)} per person`),
        el('div', { class: 'tier__price' }, quote ? 'On quote' : sale.money(price)),
        el('div', { class: 'tier__act' }, actions),
        el('p', { class: 'buy__error tier__error', role: 'alert', 'data-buy-error': true, hidden: true }));
    });
    box.replaceChildren(...rows);
    const after = qs('[data-gift-after]');
    if (after) {
      after.replaceChildren(...(state.buyable
        ? [el('b', {}, 'Right after paying, you land on your gift page'), ' with the link to forward, the seats used and the message your team sees. Its link also arrives by email.']
        : [el('b', {}, 'Once the invoice is paid,'), ' you get your gift page by email: a private page with the gift link to forward, the seats used and the message your team sees.']));
    }
  }

  function renderTalk() {
    const talk = qs('[data-talk]');
    if (!talk) return;
    if (!settings.talk?.enabled) {
      talk.hidden = true;
      return;
    }
    talk.replaceChildren(
      el('span', { class: 'talk__what' }, el('b', {}, 'Add-on'), settings.talk.label),
      el('span', { class: 'talk__price' }, settings.talk.price),
      el('a', { class: 'tier__link', href: '#request', 'data-request': 'talk' }, 'Ask about the talk'));
    talk.hidden = false;
  }

  /* Send this to my manager ----------------------------------------------- */

  const managerBody = () => managerMessage(settings.managerEmail.body, { url: settings.teamsUrl, perPerson: lowestPerPerson(sale.currency) });

  function updateManagerLinks() {
    const body = managerBody().replace(/\n/g, '\r\n');
    const href = `mailto:?subject=${encodeURIComponent(settings.managerEmail.subject)}&body=${encodeURIComponent(body)}`;
    qsa('[data-manager-mail]').forEach(link => { link.href = href; });
  }

  function setupManagerEmail() {
    const status = qs('[data-copy-status]');
    updateManagerLinks();
    qsa('[data-manager-mail]').forEach(link => link.addEventListener('click', () => track('manager_email_opened')));
    qs('[data-manager-copy]')?.addEventListener('click', async () => {
      const ok = await copyText(`Subject: ${settings.managerEmail.subject}\n\n${managerBody()}`);
      if (status) status.textContent = ok ? 'Message copied. Paste it into an email or a chat with your manager.' : 'Copy didn’t work here. Use “Send this to my manager” instead.';
      if (ok) track('manager_email_opened');
    });
  }

  /** Everything that depends on the currency and on what is on sale. */
  function render() {
    renderTiers();
    qsa('[data-faq-pay]').forEach(node => { node.textContent = invoiceAnswer(sale.state('gift').buyable); });
    qsa('[data-largest-tier]').forEach(node => { node.textContent = people(Math.max(...TEAM_TIERS.map(tier => tier.seats))); });
    updateManagerLinks();
  }

  /** A team gift's Buy button: Creem's checkout, or the invoice request when it can't be bought online here. */
  function buy(button) {
    track('pack_checkout_clicked');
    return checkout(button, {
      sale,
      unavailable: ({ plan }) => {
        refresh();
        openRequest({ kind: 'invoice', plan });
      }
    });
  }

  renderTalk();
  setupManagerEmail();
  return { render, buy };
}
