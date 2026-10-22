// Imported as a namespace so a value missing from an older config.js reads as
// undefined instead of failing the whole module.
import * as config from '../src/config.js';
import { setupTopMenu } from './top-menu.js';

/* ============================================================================
   Small pieces shared by the welcome pages (/welcome/, /teams/, /contact/,
   /partners/, /welcome/thanks/): DOM helpers, the header that gains a
   hairline once the page scrolls (and its menu on a phone), the footer's
   social links, and copying text. No page logic here.
   ============================================================================ */

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

export const CHECK_ICON = '<svg class="i"><use href="#i-check"/></svg>';

// Same rule as the server: a plain domain (letters, digits, dots, hyphens).
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"?&=%/#]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,188}[a-z0-9])?\.[a-z]{2,24}$/i;

export const httpsUrl = value => (typeof value === 'string' && /^https:\/\/[^\s"'<>]+$/.test(value.trim()) ? value.trim() : '');

/** A string from runtime-config.js / config.js, trimmed; '' when it isn't set (or an older config lacks it). */
export const configText = key => (typeof config[key] === 'string' ? config[key].trim() : '');

/**
 * The address in an email setting typed “<support@example.com>” or
 * “Support <support@example.com>” (config.js emailAddress); anything else
 * trimmed, for EMAIL_RE to check.
 */
export const emailAddress = value => (typeof config.emailAddress === 'function' ? config.emailAddress(value) : String(value ?? '').trim());

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

/**
 * The header gains its hairline once the page has scrolled; below 960px its
 * Menu button opens the section links (welcome/top-menu.js).
 */
export function setupTopBar() {
  const top = qs('[data-top]');
  if (!top) return;
  setupTopMenu(top);
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

/* Footer: the configured social links ---------------------------------------

   Every footer repeats nothing its page's top bar already has (1.32). Above,
   the brand and “By Ben Morin”, with these links across from it once one is
   set (and Open the planner on the partners page, whose top bar has no such
   button); below, the legal pages and Contact, then “What this page
   counts”. No support address: the Contact page shows it when SUPPORT_EMAIL
   is set, and so does the legal notice. */

export function renderFooter() {
  const social = qs('[data-social]');
  const links = [['PROJECT_GITHUB_URL', 'GitHub'], ['SOCIAL_X_URL', 'X'], ['SOCIAL_LINKEDIN_URL', 'LinkedIn']]
    .map(([key, label]) => [httpsUrl(configText(key)), label])
    .filter(([url]) => url)
    .map(([url, label]) => el('a', { href: url, rel: 'noopener' }, label));
  if (social && links.length) {
    social.replaceChildren(...links);
    social.hidden = false;
    // Their group waits hidden until it has something to show.
    const group = social.closest('.foot__links');
    if (group) group.hidden = false;
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
