import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

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
// What the build publishes (scripts/build.mjs): the root files, admin/, welcome/, legal/ and src/.
const published = ['index.html', 'app.js', 'sw.js', 'runtime-config.js', 'styles.css', ...['admin/', 'welcome/', 'legal/', 'src/'].flatMap(walk)];

test('_headers is valid: one Cache-Control per rule, within Pages limits', () => {
  assert.ok(rules.length > 0 && rules.length <= 100, 'Pages reads at most 100 rules');
  for (const rule of rules) {
    assert.match(rule.pattern, /^\//, `${rule.pattern} is a path`);
    assert.ok((rule.pattern.match(/\*/g) || []).length <= 1, `${rule.pattern}: one splat at most`);
    assert.deepEqual(rule.headers, [['cache-control', 'no-cache']], rule.pattern);
  }
  for (const line of read('_headers').split('\n')) assert.ok(line.length <= 2000, 'Pages reads lines of 2,000 characters at most');
});

test('every page, script and stylesheet revalidates on each visit, matched by exactly one rule', () => {
  const pages = published.filter(path => path.endsWith('index.html')).map(path => `/${path.slice(0, -'index.html'.length)}`);
  assert.ok(pages.includes('/') && pages.includes('/admin/') && pages.includes('/welcome/') && pages.includes('/legal/privacy/'), pages.join(' '));
  const files = published.filter(path => /\.(?:html|js|css)$/.test(path)).map(path => `/${path}`);
  assert.ok(files.includes('/admin/admin.js') && files.includes('/admin/admin.css') && files.includes('/src/features/year-plan.js'));
  for (const path of [...pages, ...files]) {
    const { matched, headers } = headersFor(rules, path);
    assert.equal(matched.length, 1, `${path} matches ${matched.map(rule => rule.pattern).join(', ') || 'no rule'}`);
    assert.equal(headers['cache-control'], 'no-cache', path);
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
