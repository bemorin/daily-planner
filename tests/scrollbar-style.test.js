import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pipStyles } from '../src/features/pip-styles.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFile(join(root, rel), 'utf8');

// Chromium ignores every ::-webkit-scrollbar part of an element as soon as the
// standard scrollbar-width / scrollbar-color apply to it, and draws its own
// bar instead (with arrows on Windows and Linux). So the standard properties
// may only be set where ::-webkit-scrollbar is unknown, except to hide a bar
// (scrollbar-width: none, with ::-webkit-scrollbar { display: none }).

function unguarded(css) {
  const outside = css.replace(/@supports not selector\(::-webkit-scrollbar\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  return [...outside.matchAll(/[^{}]*\{[^{}]*\bscrollbar-(?:width|color):[^{}]*\}/g)].map(match => match[0].trim())
    .filter(rule => !/scrollbar-width: none;/.test(rule));
}

async function stylesheets() {
  const files = [];
  for (const dir of ['styles', 'admin', 'welcome', 'legal']) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.css')) files.push(`${dir}/${entry.name}`);
    }
  }
  return files;
}

test('every stylesheet keeps the standard scrollbar properties for browsers without ::-webkit-scrollbar', async () => {
  const files = await stylesheets();
  assert.ok(files.includes('styles/core.css') && files.includes('welcome/landing.css') && files.includes('legal/legal.css') && files.includes('admin/admin.css'), files.join(' '));
  for (const file of files) assert.deepEqual(unguarded(await read(file)), [], `${file}: scrollbar-width / scrollbar-color outside the guard`);
  assert.deepEqual(unguarded(pipStyles()), [], 'the floating window');
  assert.deepEqual(unguarded('a { color: red; }\n* { scrollbar-width: thin; }'), ['* { scrollbar-width: thin; }'], 'the check finds one');
});

test('the planner and the dashboard draw the thin bar: no arrows, no track, a light thumb that darkens under the pointer', async () => {
  const css = await read('styles/core.css');
  assert.match(css, /@supports not selector\(::-webkit-scrollbar\) \{\n {2}html,\n {2}\* \{ scrollbar-width: thin; scrollbar-color: var\(--scrollbar-thumb\) transparent; \}\n\}/);
  assert.match(css, /\*::-webkit-scrollbar \{ width: 7px; height: 7px; \}/);
  assert.match(css, /\*::-webkit-scrollbar-button \{ display: none; width: 0; height: 0; \}/);
  assert.match(css, /\*::-webkit-scrollbar-thumb:hover \{\n {2}background: var\(--scrollbar-thumb-hover\);/);
  // Dialogs: their own thumb, which darkens too.
  assert.match(css, /\.modal__scroll::-webkit-scrollbar-thumb \{[^}]*background: color-mix\(in srgb, var\(--line-strong\) 58%, var\(--surface\)\);/);
  assert.match(css, /\.modal__scroll::-webkit-scrollbar-thumb:hover \{ background: color-mix\(in srgb, var\(--line-strong\) 92%, var\(--surface\)\);/);
  // A bar hidden on purpose stays hidden in every browser.
  for (const [file, selector] of [['styles/core.css', '.end-day-triage'], ['styles/horizon.css', '.hz-tabs__list']]) {
    const source = await read(file);
    assert.ok(source.includes(`${selector}::-webkit-scrollbar { display: none; }`), `${file}: ${selector}`);
    assert.match(source, new RegExp(`${selector.replace('.', '\\.')} \\{[^}]*scrollbar-width: none;`), `${file}: ${selector}`);
  }
  // The dashboard loads the planner's stylesheet, and the build makes one file of the planner's.
  assert.match(await read('admin/index.html'), /<link rel="stylesheet" href="\.\.\/styles\.css">/);
  assert.match(await read('styles.css'), /@import url\('\.\/styles\/core\.css'\);/);
});

test('the floating window has the same bar as the planner', () => {
  const css = pipStyles();
  assert.match(css, /@supports not selector\(::-webkit-scrollbar\) \{ \* \{ scrollbar-width: thin;/);
  assert.match(css, /\*::-webkit-scrollbar \{ width: 7px; height: 7px; \}/);
  assert.match(css, /\*::-webkit-scrollbar-button \{ display: none; width: 0; height: 0; \}/);
  assert.match(css, /\*::-webkit-scrollbar-thumb \{[^}]*background: color-mix\(in srgb, var\(--line\) 82%, var\(--paper\)\);/);
  assert.match(css, /\*::-webkit-scrollbar-thumb:hover \{ background: color-mix\(in srgb, var\(--line-strong\) 72%, var\(--paper\)\);/);
});
