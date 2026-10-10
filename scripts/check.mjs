import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirs = new Set(['dist', 'node_modules', '.git', '.planner-dev']);

async function walk(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const files = await walk(root);
const jsFiles = files.filter(file => file.endsWith('.js') || file.endsWith('.mjs'));
const textFiles = files.filter(file => /\.(?:js|mjs|css|html|md|json|webmanifest|txt)$/.test(file) || file.endsWith('LICENSE'));
const failures = [];

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${relative(root, file)}: ${result.stderr.trim() || 'syntax check failed'}`);
}

const forbidden = [
  new RegExp(['bike', 'shop', 'network'].join('[-_ ]*'), 'i'),
  new RegExp(['M', 'IT License'].join(''), 'i')
];
// Third-party notices legitimately reproduce other projects' license texts.
const thirdPartyNotices = new Set(['THIRD_PARTY_NOTICES.md']);
for (const file of textFiles) {
  const rel = relative(root, file);
  const text = await fs.readFile(file, 'utf8');
  for (const pattern of forbidden) {
    if (thirdPartyNotices.has(rel.replaceAll('\\', '/')) && pattern.source.includes('IT License')) continue;
    if (pattern.test(text)) failures.push(`${rel}: contains forbidden legacy text matching ${pattern}`);
  }
}

const coordinator = await fs.readFile(resolve(root, 'styles.css'), 'utf8');
const cssImports = [...coordinator.matchAll(/@import\s+url\(['"](.+?)['"]\);/g)].map(match => match[1]);
if (!cssImports.length) failures.push('styles.css: expected domain stylesheet imports');
for (const spec of cssImports) {
  try { await fs.access(resolve(root, spec)); }
  catch { failures.push(`styles.css: missing imported stylesheet ${spec}`); }
}

const importRe = /(?:import\s+(?:[^'\"]+?\s+from\s+)?|import\s*)['\"]([^'\"]+)['\"]/g;
const modulePaths = new Set();
async function collectModules(relPath) {
  if (modulePaths.has(relPath)) return;
  modulePaths.add(relPath);
  const source = await fs.readFile(resolve(root, relPath), 'utf8');
  for (const match of source.matchAll(importRe)) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue;
    const normalized = relative(root, resolve(root, dirname(relPath), spec)).replaceAll('\\', '/');
    await collectModules(normalized);
  }
}
await collectModules('app.js');

const packageJson = JSON.parse(await fs.readFile(resolve(root, 'package.json'), 'utf8'));
const releaseVersion = String(packageJson.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(releaseVersion)) failures.push('package.json: version must be semantic MAJOR.MINOR.PATCH');

const changelog = await fs.readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## ${releaseVersion} —`)) failures.push(`CHANGELOG.md: latest public version must include ${releaseVersion}`);
if (/^##\s+v\d+/m.test(changelog)) failures.push('CHANGELOG.md: internal v-number labels are not public release versions');

const sw = await fs.readFile(resolve(root, 'sw.js'), 'utf8');
if (!sw.includes(`const CACHE = 'daily-planner-${releaseVersion}';`)) failures.push(`sw.js: cache namespace must match package version ${releaseVersion}`);
if (/daily-planner-v\d+/i.test(sw)) failures.push('sw.js: internal build labels must not be used as public cache names');
for (const modulePath of modulePaths) {
  if (modulePath === 'app.js') continue;
  if (!sw.includes(`'./${modulePath}'`)) failures.push(`sw.js: CORE cache is missing ./${modulePath}`);
}

const appConfig = await fs.readFile(resolve(root, 'src/config.js'), 'utf8');
if (!appConfig.includes(`export const APP_VERSION = '${releaseVersion}';`)) failures.push(`src/config.js: APP_VERSION must match package version ${releaseVersion}`);

const license = await fs.readFile(resolve(root, 'LICENSE'), 'utf8');
if (!license.includes('PolyForm Perimeter License 1.0.1')) failures.push('LICENSE: expected PolyForm Perimeter 1.0.1');
if (!license.includes('Required Notice: Copyright 2026 Ben Morin.')) failures.push('LICENSE: missing required copyright notice');

const runtimeConfig = await fs.readFile(resolve(root, 'runtime-config.js'), 'utf8');
for (const key of ['PROJECT_GITHUB_URL', 'GITHUB_SPONSOR_URL', 'SOCIAL_X_URL', 'SOCIAL_LINKEDIN_URL', 'GOOGLE_CLIENT_ID', 'PLANNER_API_URL', 'PLUS_PUBLIC_KEY', 'PLUS_CHECKOUT_URL']) {
  if (!runtimeConfig.includes(`${key}: ''`)) failures.push(`runtime-config.js: ${key} must remain blank in the public source`);
}

if (failures.length) {
  console.error(`Repository checks failed (${failures.length}):`);
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Repository checks passed: ${jsFiles.length} JavaScript files, ${cssImports.length} CSS modules, ${modulePaths.size} runtime modules.`);
