import { checkoutOptions, plannerApiEnabled, startCheckout } from '../src/lib/planner-api.js';
import { formatMoney } from '../src/lib/pricing.js';
import { buyState, checkoutUrl, currencyLine, lowestPerPerson, pageCurrency, readCheckoutOptions, taxLine } from './landing-model.js';
import { el, qs, qsa } from './page-kit.js';

/* ============================================================================
   What can be bought online, in which currency, and the buy buttons — shared
   by the landing page (Plus, personal gifts) and the Teams page (team gifts).

   The currency: a first guess from the browser's languages; the server's
   answer (from the visitor's country, GET /api/checkout) replaces it as soon
   as it arrives, before the prices are on screen. There is no switch: the
   euro area pays in EUR, everyone else in USD, and Creem charges exactly that.
   ============================================================================ */

/**
 * @param {object} options
 * @param {() => void} options.onLoad  Called once the server said what's on sale (re-render the prices).
 */
export function createSale({ onLoad = () => {} } = {}) {
  const apiOn = plannerApiEnabled();
  let currency = pageCurrency(null);
  let options = readCheckoutOptions(null);
  let pending = null;

  return {
    apiOn,
    get currency() { return currency; },
    money: value => formatMoney(value, currency),
    currencyName: () => (currency === 'EUR' ? 'euros' : 'US dollars'),
    /** Whether `item` ('plus' | 'gift') can be bought online here: { buyable, reason, other }. */
    state: item => buyState({ apiOn, options, item, currency }),
    /** Asks the server once (again on the next click if it couldn't be reached). */
    load() {
      if (!apiOn || options.known) return Promise.resolve(options);
      if (!pending) {
        pending = checkoutOptions().then(result => {
          options = readCheckoutOptions(result);
          pending = null;
          currency = pageCurrency(options);
          onLoad();
          return options;
        });
      }
      return pending;
    }
  };
}

/** The lines every price area shares: its currency, taxes included, and the lowest team price per person. */
export function renderPriceLines(sale) {
  qsa('[data-currency-line]').forEach(node => { node.textContent = currencyLine(sale.currency); });
  qsa('[data-tax-line]').forEach(node => { node.textContent = taxLine(sale.currency); });
  qsa('[data-min-per-person]').forEach(node => { node.textContent = lowestPerPerson(sale.currency); });
}

/* Buy buttons: busy while the checkout opens, an error underneath if it can't */

export function buyError(button, text) {
  const box = button.closest('[data-plus-cta], [data-gifts], .tier');
  const error = box && qs('[data-buy-error]', box);
  if (!error) return;
  error.textContent = text;
  error.hidden = !text;
}

const busyLabels = new WeakMap();

export function setBusy(button, busy) {
  if (busy) {
    busyLabels.set(button, [...button.childNodes]);
    const label = button.dataset.buy === 'plus' ? 'Opening checkout…' : 'Opening…';
    if (button.classList.contains('gift-btn')) button.replaceChildren(el('span', { class: 'gift-btn__name' }, label));
    else button.textContent = label;
  } else if (busyLabels.has(button)) {
    button.replaceChildren(...busyLabels.get(button));
    busyLabels.delete(button);
  }
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  button.setAttribute('aria-busy', String(busy));
}

/**
 * Opens Creem's checkout for a [data-buy] button (item, and plan for a gift).
 * Loading the sale options can re-render the offers, so it always acts on the
 * matching button now on the page.
 *
 * @param {HTMLElement} clicked
 * @param {object} options
 * @param {ReturnType<typeof createSale>} options.sale
 * @param {string} [options.license]  A member's licence, for a personal gift's member price.
 * @param {(details: { item: string, plan: string }) => void} [options.unavailable]  Not on sale online after all.
 * @param {(details: { plan: string, result: object, url: string }) => boolean} [options.confirm]  True: it takes over (asks before leaving).
 */
export async function checkout(clicked, { sale, license = '', unavailable = () => {}, confirm = () => false }) {
  const item = clicked.dataset.buy;
  const plan = clicked.dataset.plan || '';
  const selector = `[data-buy="${CSS.escape(item)}"]${plan ? `[data-plan="${CSS.escape(plan)}"]` : ':not([data-plan])'}`;
  const current = () => (clicked.isConnected ? clicked : qs(selector) || clicked);
  buyError(current(), '');
  setBusy(current(), true);
  await sale.load();
  const button = current();
  setBusy(button, true);
  if (!sale.state(item).buyable) {
    // Not on sale online after all: the page shows the honest state.
    setBusy(button, false);
    unavailable({ item, plan });
    return;
  }
  const result = await startCheckout({ item, plan, currency: sale.currency, license });
  const url = result.ok ? checkoutUrl(result.url) : '';
  if (url && confirm({ plan, result, url })) return;
  if (url) {
    // The button stays busy while the browser leaves for the checkout.
    location.assign(url);
    return;
  }
  setBusy(current(), false);
  buyError(current(), result.error || 'The checkout could not be opened. Please try again in a minute.');
}

/** Every [data-buy] button of the page calls `buy(button)`; back from the checkout, they work again. */
export function setupBuyButtons(buy, { onReturn = () => {} } = {}) {
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-buy]');
    if (!button || button.disabled) return;
    event.preventDefault();
    buy(button);
  });
  // Back from the checkout page (back/forward cache).
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    qsa('[data-buy].is-busy').forEach(button => setBusy(button, false));
    onReturn();
  });
}
