// Imported as a namespace so a value missing from an older config.js reads as
// undefined instead of failing the whole module.
import * as config from '../src/config.js';

/* ============================================================================
   Small pieces shared by the welcome pages (/welcome/, /welcome/teams/): DOM
   helpers, the header that gains a hairline once the page scrolls, the footer's
   support address and links, and copying text. No page logic here.
   ============================================================================ */

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

export const CHECK_ICON = '<svg class="i"><use href="#i-check"/></svg>';

// Same rule as the server: a plain domain (letters, digits, dots, hyphens).
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"?&=%/#]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,188}[a-z0-9])?\.[a-z]{2,24}$/i;

export const httpsUrl = value => (typeof value === 'string' && /^https:\/\/[^\s"'<>]+$/.test(value.trim()) ? value.trim() : '');

/** A string from runtime-config.js / config.js, trimmed; '' when it isn't set (or an older config lacks it). */
export const configText = key => (typeof config[key] === 'string' ? config[key].trim() : '');

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === false || value == null) return;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  });
  children.flat().forEach(child => { if (child != null) node.append(child instanceof Node ? child : String(child)); });
  return node;
}

/** The header gains its hairline once the page has scrolled. */
export function setupTopBar() {
  const top = qs('[data-top]');
  if (!top) return;
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      top.classList.toggle('is-scrolled', window.scrollY > 4);
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* Footer: support address and configured links ---------------------------- */

export function renderFooter({ supportEmail = '' } = {}) {
  const support = qs('[data-support]');
  // config.SUPPORT_EMAIL may not exist in an older config.js: '' is fine.
  const email = String(supportEmail || configText('SUPPORT_EMAIL') || '').trim();
  if (support && EMAIL_RE.test(email)) {
    support.replaceChildren('Support: ', el('a', { href: `mailto:${email}` }, email));
    support.hidden = false;
  }
  const social = qs('[data-social]');
  const links = [['PROJECT_GITHUB_URL', 'GitHub'], ['SOCIAL_X_URL', 'X'], ['SOCIAL_LINKEDIN_URL', 'LinkedIn']]
    .map(([key, label]) => [httpsUrl(configText(key)), label])
    .filter(([url]) => url)
    .map(([url, label]) => el('a', { href: url, rel: 'noopener' }, label));
  if (social && links.length) {
    social.replaceChildren(...links);
    social.hidden = false;
  }
}

/** Copies `text`, with the old way as a fallback. True when it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const area = el('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    area.remove();
    return ok;
  }
}
