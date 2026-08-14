/** Escape user-authored text before inserting it into HTML templates. */
export function esc(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

export function escAttr(value = '') {
  return esc(value);
}

/** Normalize a user-entered link to an explicit HTTP(S) URL. */
export function normalizeUrl(raw) {
  try {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch (_) {
    return '';
  }
}

export function safeUrl(raw) {
  return raw ? normalizeUrl(raw) : '';
}

export function linkLabel(raw) {
  try {
    const url = new URL(raw);
    return url.hostname.replace(/^www\./, '');
  } catch (_) {
    return 'Open link';
  }
}
