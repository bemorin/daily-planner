import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { parseRedirects, redirectFor } from '../scripts/redirects.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

/** _headers as Cloudflare Pages reads it: a URL pattern, then indented `Name: value` lines. */
function parseHeaders(source) {
  const rules = [];
  for (const line of source.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      const [, name, value] = /^\s+([^:]+):\s*(.*)$/.exec(line) || [];
      assert.ok(name && rules.length, `header line belongs to a rule: ${line}`);
      rules.at(-1).headers.push([name.trim().toLowerCase(), value.trim()]);
    } else {
      rules.push({ pattern: line.trim(), headers: [] });
    }
  }
  return rules;
}

// A splat (*) matches anything, slashes included; a :placeholder one path segment.
const matcher = pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:[A-Za-z]\w*/g, '[^/]+')}$`);

/** The headers a path receives: every matching rule, values of a repeated header joined with a comma (as Pages does). */
function headersFor(rules, path) {
  const matched = rules.filter(rule => matcher(rule.pattern).test(path));
  const headers = {};
  matched.forEach(rule => rule.headers.forEach(([name, value]) => { headers[name] = headers[name] ? `${headers[name]}, ${value}` : value; }));
  return { matched, headers };
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(`${path}/`));
    else files.push(path);
  }
  return files;
}

const rules = parseHeaders(read('_headers'));
// What the build publishes (scripts/build.mjs): the root files, admin/, welcome/, teams/, partners/, legal/ and src/.
const published = ['index.html', 'app.js', 'sw.js', 'runtime-config.js', 'styles.css', ...['admin/', 'welcome/', 'teams/', 'partners/', 'legal/', 'src/'].flatMap(walk)];

// The old addresses of the Teams and partners pages: redirects (_redirects) that are never kept (no-store)…
const MOVED = ['/welcome/teams', '/welcome/teams/*', '/welcome/partners', '/welcome/partners/*'];
// …and the two exact addresses 1.28's /teams and /partners redirects went to, which also empty the HTTP cache (see _headers).
const CLEARING = ['/welcome/teams/', '/welcome/partners/'];

test('_headers is valid: one Cache-Control per rule, within Pages limits', () => {
  assert.ok(rules.length > 0 && rules.length <= 100, 'Pages reads at most 100 rules');
  for (const rule of rules) {
    assert.match(rule.pattern, /^\//, `${rule.pattern} is a path`);
    assert.ok((rule.pattern.match(/\*/g) || []).length <= 1, `${rule.pattern}: one splat at most`);
    const expected = CLEARING.includes(rule.pattern) ? [['clear-site-data', '"cache"']]
      : MOVED.includes(rule.pattern) ? [['cache-control', 'no-store']] : [['cache-control', 'no-cache']];
    assert.deepEqual(rule.headers, expected, rule.pattern);
  }
  assert.deepEqual(rules.filter(rule => rule.headers.some(([name]) => name === 'clear-site-data')).map(rule => rule.pattern), CLEARING);
  for (const line of read('_headers').split('\n')) assert.ok(line.length <= 2000, 'Pages reads lines of 2,000 characters at most');
  // A dated reminder: Clear-Site-Data makes every visit to those addresses scan the browser's whole HTTP cache.
  assert.match(read('_headers'), /remove the two Clear-Site-Data rules in a release after\s+(?:#\s*)?2027-01-31/);
});

test('every page, script and stylesheet revalidates on each visit, matched by exactly one rule', () => {
  const pages = published.filter(path => path.endsWith('index.html')).map(path => `/${path.slice(0, -'index.html'.length)}`);
  assert.ok(['/', '/admin/', '/welcome/', '/welcome/thanks/', '/teams/', '/partners/', '/legal/privacy/'].every(page => pages.includes(page)), pages.join(' '));
  const files = published.filter(path => /\.(?:html|js|css)$/.test(path)).map(path => `/${path}`);
  assert.ok(files.includes('/admin/admin.js') && files.includes('/admin/admin.css') && files.includes('/src/features/year-plan.js'));
  for (const path of [...pages, ...files]) {
    const { matched, headers } = headersFor(rules, path);
    assert.equal(matched.length, 1, `${path} matches ${matched.map(rule => rule.pattern).join(', ') || 'no rule'}`);
    assert.equal(headers['cache-control'], 'no-cache', path);
  }
});

test('a browser that kept the old /teams → /welcome/teams/ redirect is not caught in a loop', () => {
  const redirects = parseRedirects(read('_redirects'));
  // 1.28's short links, /teams, /teams/, /partners and /partners/, all went to exactly these two addresses (and kept a query string).
  for (const [path, search] of [['/welcome/teams/', ''], ['/welcome/teams/', '?ask=question'], ['/welcome/partners/', '']]) {
    // Each one is a redirect to the new page…
    assert.ok(redirectFor(redirects, path, search), `${path}${search} redirects`);
    // …that is never kept, and empties the HTTP cache, where 1.28's /teams/ → /welcome/teams/ may still be.
    const { headers } = headersFor(rules, path);
    assert.equal(headers['cache-control'], 'no-store', path);
    assert.equal(headers['clear-site-data'], '"cache"', `${path}: the HTTP cache only, never the planner's data ("storage")`);
  }
});

test('the other old addresses are redirects never kept, without the slow cache clearing', () => {
  const redirects = parseRedirects(read('_redirects'));
  for (const path of ['/welcome/teams', '/welcome/teams/index.html', '/welcome/teams/teams.js', '/welcome/teams/thanks/', '/welcome/partners', '/welcome/partners/index.html', '/welcome/partners/partners.css']) {
    assert.ok(redirectFor(redirects, path, ''), `${path} redirects`);
    // (/welcome/teams/index.html also matches /*.html: “no-cache, no-store”, and no-store wins.)
    const { headers } = headersFor(rules, path);
    assert.match(headers['cache-control'], /(?:^|, )no-store$/, path);
    // Clear-Site-Data makes the browser scan its whole HTTP cache before it follows the redirect (half a second or more).
    assert.equal(headers['clear-site-data'], undefined, path);
  }
  // The new pages, the rest of /welcome/ and the planner are left alone.
  for (const path of ['/teams/', '/partners/', '/welcome/', '/welcome/thanks/', '/welcome/teams-model.js', '/', '/index.html', '/sw.js']) {
    assert.equal(headersFor(rules, path).headers['clear-site-data'], undefined, path);
  }
});

test('the API, images and icons are left alone', () => {
  for (const path of ['/api/admin/summary', '/api/checkout', '/api/plus/check', '/api/creem/webhook', '/api/', '/favicon.svg', '/pwa-512.png', '/welcome/og.png', '/manifest.webmanifest']) {
    assert.equal(headersFor(rules, path).matched.length, 0, path);
  }
});

test('the build copies _headers next to _redirects', () => {
  const build = read('scripts/build.mjs');
  assert.match(build, /await copyFile\('_headers'\);/);
  assert.match(build, /await copyFile\('_redirects'\);/);
});

test('the service worker keeps its own network-first copy, so no-cache does not break offline use', () => {
  const sw = read('sw.js');
  assert.match(sw, /fetch\(request\)\.then/, 'network first');
  assert.match(sw, /caches\.match\(request\)/, 'then its own cache');
  assert.match(sw, /url\.pathname\.includes\('\/api\/'\)/, 'never the API');
});
