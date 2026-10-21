export const snap = 15;
export const minTaskSlots = 3;
export const scheduleTopPad = 14;
export const scheduleBottomPad = 16;
const runtimeConfig = globalThis.__DAILY_PLANNER_CONFIG__ && typeof globalThis.__DAILY_PLANNER_CONFIG__ === 'object'
  ? globalThis.__DAILY_PLANNER_CONFIG__
  : {};
const runtimeValue = key => typeof runtimeConfig[key] === 'string' ? runtimeConfig[key].trim() : '';
/**
 * The address in an email setting as it may be typed: “support@example.com”,
 * “<support@example.com>” or “Support <support@example.com>” (spaces around it
 * allowed) all give support@example.com. Anything else comes back trimmed, and
 * whoever shows it checks it is a plain address (legal/legal-details.js has the
 * same rule for the build and the dashboard).
 */
export const emailAddress = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[^<>]*<\s*([^<>]*?)\s*>$/.exec(text)?.[1] ?? text;
};

export const PROJECT_GITHUB_URL = runtimeValue('PROJECT_GITHUB_URL');
export const GITHUB_SPONSOR_URL = runtimeValue('GITHUB_SPONSOR_URL');
export const SOCIAL_X_URL = runtimeValue('SOCIAL_X_URL');
export const SOCIAL_LINKEDIN_URL = runtimeValue('SOCIAL_LINKEDIN_URL');
export const CLOUD_API_URL = runtimeValue('CLOUD_API_URL');
export const GOOGLE_CLIENT_ID = runtimeValue('GOOGLE_CLIENT_ID');
// Optional feedback / waitlist / anonymous-count endpoint (e.g. "/api" on Cloudflare Pages).
// Blank means the planner never calls it.
export const PLANNER_API_URL = runtimeValue('PLANNER_API_URL').replace(/\/+$/, '');
// Daily Planner Plus: the public key that verifies licences on the device
// (base64 SPKI, ECDSA P-256). Blank in public source: Plus can't be activated
// here. Buying goes through the owner API (GET/POST /api/checkout).
export const PLUS_PUBLIC_KEY = runtimeValue('PLUS_PUBLIC_KEY').replace(/\s+/g, '');
// Legal pages (legal/): the publisher's contact address, the address for
// privacy questions, phone number, postal address and registration (e.g.
// SIRET or VAT number). Blank details are left out of the pages; without
// SUPPORT_EMAIL they point to the “Ask a question” form, and privacy
// questions go to PRIVACY_EMAIL, else SUPPORT_EMAIL, else the form.
// legal/legal.js checks each one before showing it (a plain address, a phone
// number of digits, spaces and + ( ) - . only). The two addresses may be typed
// “<support@example.com>” or “Support <support@example.com>”: only the address is kept.
export const SUPPORT_EMAIL = emailAddress(runtimeValue('SUPPORT_EMAIL'));
export const PRIVACY_EMAIL = emailAddress(runtimeValue('PRIVACY_EMAIL'));
export const LEGAL_PHONE = runtimeValue('LEGAL_PHONE');
export const LEGAL_ADDRESS = runtimeValue('LEGAL_ADDRESS');
export const LEGAL_REGISTRATION = runtimeValue('LEGAL_REGISTRATION');
// Partners (/partners/): the Creem affiliate sign-up link (Creem → Growth
// → Affiliate Hub) behind “Become a partner”. Blank: the button opens the
// question form on the Teams page. The program's terms (rates, days, minimum)
// are PARTNER_PROGRAM in src/lib/pricing.js.
export const AFFILIATE_URL = /^https:\/\/[^\s"'<>]+$/.test(runtimeValue('AFFILIATE_URL')) ? runtimeValue('AFFILIATE_URL') : '';
// Kept in step with package.json by scripts/check.mjs; feedback is grouped by it.
export const APP_VERSION = '1.29.1';
// Public/project links are deployment configuration, not repository defaults.


export const palette = [
  { group: 'Muted', name: 'Brick', value: '#8f5f59' },
  { group: 'Muted', name: 'Cinnamon', value: '#9a704e' },
  { group: 'Muted', name: 'Olive', value: '#7a7950' },
  { group: 'Muted', name: 'Moss', value: '#5f755b' },
  { group: 'Muted', name: 'Eucalyptus', value: '#54766f' },
  { group: 'Muted', name: 'Slate', value: '#5f7084' },
  { group: 'Muted', name: 'Iris', value: '#716786' },
  { group: 'Muted', name: 'Mauve', value: '#8a6578' },
  { group: 'Muted', name: 'Stone', value: '#746e67' },
  { group: 'Rich', name: 'Burgundy', value: '#7b3440' },
  { group: 'Rich', name: 'Copper', value: '#a5522e' },
  { group: 'Rich', name: 'Mustard', value: '#a47d19' },
  { group: 'Rich', name: 'Forest', value: '#3f6a43' },
  { group: 'Rich', name: 'Petrol', value: '#2f6d70' },
  { group: 'Rich', name: 'Cobalt', value: '#3e5f96' },
  { group: 'Rich', name: 'Plum', value: '#694a83' },
  { group: 'Rich', name: 'Berry', value: '#8a4566' },
  { group: 'Rich', name: 'Charcoal', value: '#575b60' },
  { group: 'Bright', name: 'Coral', value: '#d75d54' },
  { group: 'Bright', name: 'Tangerine', value: '#df7a31' },
  { group: 'Bright', name: 'Sunflower', value: '#d5a91f' },
  { group: 'Bright', name: 'Leaf', value: '#5aa64d' },
  { group: 'Bright', name: 'Turquoise', value: '#35a59e' },
  { group: 'Bright', name: 'Azure', value: '#4b86c6' },
  { group: 'Bright', name: 'Violet', value: '#8264c7' },
  { group: 'Bright', name: 'Fuchsia', value: '#c35c94' },
  { group: 'Bright', name: 'Graphite', value: '#6b737d' }
];

export const defaultCategories = [
  { id: 'deep-work', name: 'Deep work', color: '#5f7084' },
  { id: 'admin', name: 'Admin', color: '#746e67' },
  { id: 'health', name: 'Health', color: '#5f755b' },
  { id: 'learning', name: 'Learning', color: '#716786' },
  { id: 'personal', name: 'Personal', color: '#9a704e' }
];
