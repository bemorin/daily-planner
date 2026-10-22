import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// The public pages, each with its folder (for relative links) and what its footer holds besides the brand.
const PAGES = [
  { file: 'welcome/index.html', folder: 'welcome/', root: '../', counts: /<button class="foot__counts" type="button" data-privacy-open hidden>/ },
  { file: 'teams/index.html', folder: 'teams/', root: '../', counts: /<button class="foot__counts" type="button" data-privacy-open hidden>/ },
  { file: 'contact/index.html', folder: 'contact/', root: '../', counts: /<a class="foot__counts" href="\.\.\/welcome\/#privacy" data-counts-link hidden>/ },
  { file: 'partners/index.html', folder: 'partners/', root: '../', counts: /<a class="foot__counts" href="\.\.\/welcome\/#privacy" data-counts-link hidden>/, planner: true },
  { file: 'welcome/thanks/index.html', folder: 'welcome/thanks/', root: '../../', counts: /<a class="foot__counts" href="\.\.\/#privacy" data-counts-link hidden>/ }
];

// A site path with its #part: ../welcome/#plus from contact/ is welcome/#plus.
const resolveHref = (folder, href) => {
  const [path, hash = ''] = href.split('#');
  return `${posix.normalize(posix.join(folder, path || './'))}${hash ? `#${hash}` : ''}`;
};
const linksOf = html => [...html.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map(match => ({ href: /href="([^"]+)"/.exec(match[1])?.[1] || '', text: match[2].replace(/<[^>]+>/g, '').trim() }));

test('every footer repeats nothing its top bar has (1.32)', () => {
  for (const { file, folder } of PAGES) {
    const page = read(file);
    const top = /<header class="top"[\s\S]*?<\/header>/.exec(page)[0];
    const foot = /<footer class="foot">[\s\S]*?<\/footer>/.exec(page)[0];
    // The brand leads home in both: any other destination the top bar has, the footer doesn't.
    const inTop = new Set(linksOf(top).filter(link => !link.text.includes('Daily Planner')).map(link => resolveHref(folder, link.href)));
    for (const link of linksOf(foot)) {
      if (/^https:/.test(link.href)) continue;
      assert.ok(!inTop.has(resolveHref(folder, link.href)), `${file}: “${link.text}” is already in the top bar`);
    }
  }
});

test('every footer is built the same: the brand, its social links, the legal pages and Contact, what the page counts', () => {
  for (const { file, root, counts, planner } of PAGES) {
    const foot = /<footer class="foot">[\s\S]*?<\/footer>/.exec(read(file))[0];
    assert.match(foot, /<div class="foot__brand">[\s\S]*?<span><b>Daily Planner<\/b> By <a href="https:\/\/bemorin\.com\/" rel="noopener">Ben Morin<\/a><\/span>/, file);
    // Across from the brand: the social links once set (their group waits hidden), and Open the planner where the top bar has no such button.
    if (planner) assert.match(foot, /<nav class="foot__links" aria-label="Footer">\s*<a href="\.\.\/">Open the planner<\/a>\s*<span class="foot__social" data-social hidden><\/span>\s*<\/nav>/, file);
    else assert.match(foot, /<nav class="foot__links" aria-label="Social links" hidden>\s*<span class="foot__social" data-social hidden><\/span>\s*<\/nav>/, file);
    // Below: the legal pages, then Contact, as in the planner's own footer; what this page counts across from them.
    const base = /<div class="wrap foot__base">([\s\S]*?)\n {4}<\/div>/.exec(foot)?.[1] || '';
    assert.deepEqual(linksOf(base).filter(link => link.text !== 'What this page counts').map(link => [link.href, link.text]), [
      [`${root}legal/privacy/`, 'Privacy'], [`${root}legal/terms/`, 'Terms'], [`${root}legal/cookies/`, 'Cookies'], [`${root}legal/`, 'Legal notice'],
      [file === 'contact/index.html' ? './' : `${root}contact/`, 'Contact']
    ], file);
    assert.match(base, /^\s*<div class="foot__links">\s*<nav class="foot__legal" aria-label="Legal">[\s\S]*?<\/nav>\s*<a [^>]*>Contact<\/a>\s*<\/div>/, `${file}: Contact beside the legal pages, outside their nav`);
    assert.match(base, counts, file);
    assert.doesNotMatch(foot, /data-support|foot__support|Support:|mailto:/, `${file}: no support address`);
    for (const word of ['Plus', 'Pricing', 'Partners', 'Team gift', 'Ask a question']) assert.ok(!linksOf(foot).some(link => link.text === word), `${file}: no ${word}`);
  }
  assert.match(read('contact/index.html'), /<a href="\.\/" aria-current="page">Contact<\/a>/, 'the Contact page marks itself');
  // The thanks page draws the same stats icon as the others.
  assert.match(read('welcome/thanks/index.html'), /<symbol id="i-stats" viewBox="0 0 24 24">/);
});

test('every page’s script fills in the social links, and shows what it counts only when it counts', () => {
  for (const [file, call] of [['teams/teams.js', /^renderFooter\(\);$/m], ['contact/contact.js', /^renderFooter\(\);$/m], ['partners/partners.js', /^renderFooter\(\);$/m], ['welcome/thanks/thanks.js', /^ {2}renderFooter\(\);$/m], ['welcome/landing.js', /renderFooter\(/]]) {
    assert.match(read(file), call, file);
  }
  for (const file of ['contact/contact.js', 'partners/partners.js', 'welcome/thanks/thanks.js']) assert.match(read(file), /qsa\('\[data-counts-link\]'\)\.forEach\(link => \{ link\.hidden = !apiOn; \}\);/, file);
  const kit = read('welcome/page-kit.js');
  assert.match(kit, /export function renderFooter\(\) \{/);
  assert.match(kit, /social\.hidden = false;\n[\s\S]*?const group = social\.closest\('\.foot__links'\);\n {4}if \(group\) group\.hidden = false;/, 'the group shows once it has a link');
  assert.doesNotMatch(kit, /data-support|Support: /);
});
