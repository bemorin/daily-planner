import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ? resolve(projectRoot, process.argv[2]) : projectRoot;

async function firstExisting(paths) {
  for (const path of paths.filter(Boolean)) {
    try { await fs.access(path); return path; } catch {}
  }
  return '';
}

const chrome = await firstExisting([
  process.env.CHROME_BIN,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}/Google/Chrome/Application/chrome.exe` : '',
  process.env['PROGRAMFILES(X86)'] ? `${process.env['PROGRAMFILES(X86)']}/Google/Chrome/Application/chrome.exe` : ''
]);
if (!chrome) {
  console.error('Smoke test requires Chromium or Chrome. Set CHROME_BIN to the browser executable.');
  process.exit(1);
}

const profile = await mkdtemp(resolve(tmpdir(), 'daily-planner-smoke-'));
const args = [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=0',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  'about:blank'
];
if (process.platform === 'linux') args.unshift('--no-sandbox');

const browser = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let browserWs = '';
let stderr = '';
const started = new Promise((resolveStarted, reject) => {
  const timer = setTimeout(() => reject(new Error(`Chrome did not expose DevTools in time.\n${stderr}`)), 10000);
  browser.stderr.setEncoding('utf8');
  browser.stderr.on('data', chunk => {
    stderr += chunk;
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match && !browserWs) {
      browserWs = match[1];
      clearTimeout(timer);
      resolveStarted();
    }
  });
  browser.once('exit', code => {
    if (!browserWs) {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before DevTools became available (${code}).\n${stderr}`));
    }
  });
});

class CDP {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolveOpen, reject) => {
      this.ws.addEventListener('open', resolveOpen, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result || {});
      } else {
        this.events.push(message);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    const value = result.result;
    if (value?.subtype === 'error') throw new Error(value.description || 'Runtime evaluation failed');
    return value?.value;
  }
  close() { this.ws?.close(); }
}

function defaultStorage() {
  const settings = {
    startHour: 6,
    endHour: 22,
    expandedView: false,
    fitDefaultV8: true,
    weekStartDay: 1,
    weekEndDay: 5,
    weekStartsOn: 1,
    planningDays: [1, 2, 3, 4, 5],
    onboardingComplete: true,
    closeDayCount: 3,
    installPromptShown: true,
    sponsorPromptShown: true,
    openWork: [{ id: 'o1', text: 'Open item', kind: 'task', originDay: '2026-08-13', carriedCount: 1 }],
    horizon: {
      years: {
        2026: {
          misogi: 'Ride a mountain stage',
          misogiStartDate: '2026-09-01',
          misogiEndDate: '2026-09-07',
          misogiDone: false,
          meaningful: ['Ship the planner', 'Finish the manuscript', 'Build stronger relationships'],
          miniAdventures: [{ id: 'a1', text: 'Weekend in Girona', startDate: '2026-10-03', endDate: '2026-10-05', month: 9, status: 'planned', done: false, nextStep: '' }],
          habits: ['Read every day', '', '', ''],
          habitStartedAt: ['2026-07-01', '', '', ''],
          habitChecks: { '2026-08-14': [0] },
          keyDates: [{ id: 'k1', text: 'Product launch', startDate: '2026-08-20', endDate: '', done: false }]
        }
      }
    },
    horizonStartYear: 2026
  };
  const makeDay = (day, title) => ({
    focus: 'Keep the day simple.',
    priorities: [
      { id: 'p1', text: 'Ship the quality release', done: false, carriedCount: 0 },
      { id: 'p2', text: 'Review landing page copy', done: true, carriedCount: 0 },
      { id: 'p3', text: 'Call Max', done: false, carriedCount: 1, originDay: '2026-08-13' }
    ],
    tasks: [
      { id: 't1', text: 'Run regression tests', done: false, carriedCount: 0 },
      { id: 't2', text: 'Prepare GitHub PR', done: false, carriedCount: 0 }
    ],
    notes: 'A normal note\n// checklist note',
    blocks: [
      { id: `b${day.slice(-2)}`, title, link: '', notes: 'Refactor without changing behavior', start: 540, duration: 90, startDate: day, endDate: day, categoryId: '', linkedType: 'priority', linkedId: 'p1', done: false, completedAt: '', actualDuration: null, carriedCount: 0, originDay: '' },
      { id: `l${day.slice(-2)}`, title: 'Lunch', link: '', notes: '', start: 720, duration: 60, startDate: day, endDate: day, categoryId: '', linkedType: '', linkedId: '', done: false, completedAt: '', actualDuration: null, carriedCount: 0, originDay: '' }
    ],
    endedAt: '',
    carriedForward: [],
    memory: '',
    lesson: '',
    triaged: [],
    closeTransfers: []
  });
  const storage = { 'daily-planner:settings': JSON.stringify(settings) };
  for (const [day, title] of [
    ['2026-08-10', 'Monday block'],
    ['2026-08-11', 'Tuesday block'],
    ['2026-08-12', 'Wednesday block'],
    ['2026-08-13', 'Thursday block'],
    ['2026-08-14', 'Deep work']
  ]) storage[`daily-planner:${day}`] = JSON.stringify(makeDay(day, title));
  return storage;
}

const importRe = /(?:import\s+(?:[^'\"]+?\s+from\s+)?|import\s*)['\"]([^'\"]+)['\"]/g;
function normalizeModule(base, spec) {
  const stack = dirname(base).split('/').filter(Boolean);
  for (const part of spec.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}
async function moduleBundle(entry = 'app.js') {
  const sources = {};
  const deps = {};
  async function load(key) {
    if (sources[key]) return;
    const source = await fs.readFile(resolve(root, key), 'utf8');
    sources[key] = source;
    deps[key] = [];
    for (const match of source.matchAll(importRe)) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      const target = normalizeModule(key, spec);
      deps[key].push({ spec, key: target });
      await load(target);
    }
  }
  await load(entry);
  const seen = new Set();
  const order = [];
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    deps[key].forEach(dep => visit(dep.key));
    order.push(key);
  }
  visit(entry);
  return { sources, deps, order };
}

async function combinedCss() {
  const coordinator = await fs.readFile(resolve(root, 'styles.css'), 'utf8');
  const imports = [...coordinator.matchAll(/@import\s+url\(['"](.+?)['"]\);/g)].map(match => match[1]);
  if (!imports.length) return coordinator;
  return (await Promise.all(imports.map(spec => fs.readFile(resolve(root, spec), 'utf8')))).join('\n');
}

async function selfContainedHtml() {
  const { sources, deps, order } = await moduleBundle();
  let html = await fs.readFile(resolve(root, 'index.html'), 'utf8');
  html = html
    .replace('<link rel="stylesheet" href="styles.css">', '')
    .replace('<script src="runtime-config.js"></script>', '')
    .replace('<script type="module" src="app.js"></script>', '');
  const css = await combinedCss();
  const storage = defaultStorage();
  const bootstrap = `<style>${css}</style><script>(()=>{
    const data=new Map(Object.entries(${JSON.stringify(storage)}));
    const mock={get length(){return data.size},key(i){return [...data.keys()][i]??null},getItem(k){return data.has(String(k))?data.get(String(k)):null},setItem(k,v){data.set(String(k),String(v))},removeItem(k){data.delete(String(k))},clear(){data.clear()}};
    Object.defineProperty(globalThis,'localStorage',{value:mock,configurable:true});
    globalThis.__DAILY_PLANNER_CONFIG__=Object.freeze({});
    const RealDate=Date;class FixedDate extends RealDate{constructor(...a){super(...(a.length?a:['2026-08-14T12:12:00']))}static now(){return new RealDate('2026-08-14T12:12:00').valueOf()}};globalThis.Date=FixedDate;
    const sources=${JSON.stringify(sources)},depmap=${JSON.stringify(deps)},order=${JSON.stringify(order)},urls={};
    for(const key of order){let code=sources[key];for(const d of depmap[key])code=code.split(d.spec).join(urls[d.key]);urls[key]=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));}
    import(urls['app.js']).then(()=>globalThis.__APP_READY__=true).catch(err=>{console.error('APP_IMPORT_ERROR',err,err?.stack);globalThis.__APP_IMPORT_ERROR__=String(err?.stack||err)});
  })();</script>`;
  return html.replace('</body>', `${bootstrap}</body>`);
}

function runtimeErrors(events) {
  const errors = [];
  for (const message of events) {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails || {};
      errors.push(details.exception?.description || details.text || 'Runtime exception');
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') errors.push(message.params.entry.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      errors.push((message.params.args || []).map(arg => arg.value || arg.description || '').join(' '));
    }
  }
  return errors;
}

let client;
try {
  await started;
  const browserUrl = new URL(browserWs);
  const pageInfo = await fetch(`http://${browserUrl.hostname}:${browserUrl.port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  client = new CDP(pageInfo.webSocketDebuggerUrl);
  await client.connect();
  for (const method of ['Runtime.enable', 'Page.enable', 'Log.enable']) await client.send(method);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const frameTree = await client.send('Page.getFrameTree');
  await client.send('Page.setDocumentContent', { frameId: frameTree.frameTree.frame.id, html: await selfContainedHtml() });

  for (let attempt = 0; attempt < 250; attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
    const ready = await client.evaluate('globalThis.__APP_READY__||globalThis.__APP_IMPORT_ERROR__||false');
    if (ready) break;
  }

  const failures = [];
  async function check(label, expression, expected = true, awaitPromise = false) {
    let value;
    try { value = await client.evaluate(expression, awaitPromise); }
    catch (error) { failures.push(`${label}: ${error.message}`); return; }
    if (value !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  }

  await check('app imports', 'globalThis.__APP_IMPORT_ERROR__||globalThis.__APP_READY__', true);
  await check('date renders', "document.querySelector('[data-date]').textContent.length>0", true);
  await check('hour grid renders', "document.querySelectorAll('.hour-label').length>5", true);
  await check('current-time line renders', "document.querySelectorAll('.time-line').length===1", true);
  await check('schedule blocks render', "document.querySelectorAll('.time-block').length>=1", true);
  await check('Day notes editor renders', "!!document.querySelector('[data-day-notes-editor]')", true);

  const modals = [
    ['Search', '[data-search-open]', '[data-search-modal]'],
    ['Journal', '[data-journal-open]', '[data-journal-modal]'],
    ['Unresolved', '[data-open-work-open]', '[data-open-work-modal]'],
    ['Horizon', '[data-horizon-open]', '[data-horizon-modal]'],
    ['Time stats', '[data-stats-open]', '[data-stats-modal]'],
    ['Settings', '[data-settings-open]', '[data-settings-modal]'],
    ['How it works', '[data-help-open]', '[data-help-modal]'],
    ['Block editor', '[data-schedule-add]', '[data-block-modal]']
  ];
  for (const [label, trigger, modal] of modals) {
    await check(`${label} opens`, `document.querySelector('${trigger}').click(); !document.querySelector('${modal}').hidden`, true);
    await check(`${label} closes`, `document.querySelector('${modal}').querySelector('[data-modal-close]').click(); new Promise(r=>setTimeout(()=>r(document.querySelector('${modal}').hidden),260))`, true, true);
  }

  await check('Week view activates', "document.querySelector('[data-week-view]').click();document.querySelector('[data-week-view]').getAttribute('aria-pressed')==='true'", true);
  await check('Week columns render', "document.querySelectorAll('.week-day-column').length>=5", true);
  await check('Week blocks render', "document.querySelectorAll('.week-time-block').length>=1", true);
  await check('Day view restores', "document.querySelector('[data-week-view]').click();document.querySelector('[data-week-view]').getAttribute('aria-pressed')==='false'", true);

  await check('Settings time menu opens above its modal', "document.querySelector('[data-settings-open]').click();document.querySelector('[data-setting-start-hour]').click();new Promise(r=>requestAnimationFrame(()=>r(!!document.querySelector('.app-popover.is-time-menu.is-open')&&Number(getComputedStyle(document.querySelector('.app-popover.is-time-menu')).zIndex)>Number(getComputedStyle(document.querySelector('[data-settings-modal]')).zIndex))))", true, true);
  await check('Settings displayed-hour controls fill the available row like Add/Edit controls', "(()=>{const row=document.querySelector('.hours-setting').getBoundingClientRect();const group=document.querySelector('.hours-setting').closest('.settings-group').getBoundingClientRect();const a=document.querySelector('[data-setting-start-hour]').closest('.settings-time-combo').getBoundingClientRect();const b=document.querySelector('[data-setting-end-hour]').closest('.settings-time-combo').getBoundingClientRect();return row.width>=group.width*.9&&a.width>=180&&b.width>=180&&Math.abs(a.width-b.width)<1;})()", true);
  await check('Settings accepts typed visible hours', "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));(()=>{const input=document.querySelector('[data-setting-start-time]');input.value='07:00';input.dispatchEvent(new Event('blur',{bubbles:true}));return JSON.parse(localStorage.getItem('daily-planner:settings')).startHour===7;})()", true);
  await check('Week start can be explicitly changed', "document.querySelector('[data-week-starts-on]').click();(()=>{const option=[...document.querySelectorAll('.app-popover .popover-option')].find(button=>button.textContent.includes('Sunday'));option?.click();const stored=JSON.parse(localStorage.getItem('daily-planner:settings'));return stored.weekStartsOn===0&&stored.weekStartsOnExplicit===true;})()", true);
  await check('Week view respects configured first day', "document.querySelector('[data-planning-day=\"0\"]').click();document.querySelector('[data-settings-modal] [data-modal-close]').click();new Promise(r=>setTimeout(()=>{document.querySelector('[data-week-view]').click();r(document.querySelector('.week-day-head span')?.textContent.startsWith('Sun'));},260))", true, true);
  await check('Return to Day before restoring Monday-first', "document.querySelector('[data-week-view]').click();document.querySelector('[data-week-view]').getAttribute('aria-pressed')==='false'", true);
  await check('Week start can be restored to Monday', "document.querySelector('[data-settings-open]').click();document.querySelector('[data-week-starts-on]').click();(()=>{const option=[...document.querySelectorAll('.app-popover .popover-option')].find(button=>button.textContent.includes('Monday'));option?.click();document.querySelector('[data-planning-day=\"0\"]').click();document.querySelector('[data-settings-modal] [data-modal-close]').click();const stored=JSON.parse(localStorage.getItem('daily-planner:settings'));return stored.weekStartsOn===1&&!stored.planningDays.includes(0);})()", true);
  await new Promise(resolveWait => setTimeout(resolveWait, 260));

  await check('Block date calendar opens above the block modal', "document.querySelector('[data-schedule-add]').click();document.querySelector('[data-start-date]').click();new Promise(r=>requestAnimationFrame(()=>r(!!document.querySelector('.calendar-popover.is-open')&&Number(getComputedStyle(document.querySelector('.calendar-popover')).zIndex)>Number(getComputedStyle(document.querySelector('[data-block-modal]')).zIndex)&&document.querySelector('.calendar-popover__weekdays span')?.textContent==='M'))) ", true, true);
  await check('Block date calendar closes cleanly', "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));!document.querySelector('.calendar-popover')", true);
  await check('Block editor closes after date-picker regression check', "document.querySelector('[data-block-modal] [data-modal-close]').click();new Promise(r=>setTimeout(()=>r(document.querySelector('[data-block-modal]').hidden),260))", true, true);

  await check('Horizon Misogi date range opens above Horizon', "document.querySelector('[data-horizon-open]').click();document.querySelector('[data-misogi-period]').click();new Promise(r=>requestAnimationFrame(()=>r(!!document.querySelector('.period-calendar-popover.is-open')&&Number(getComputedStyle(document.querySelector('.period-calendar-popover')).zIndex)>Number(getComputedStyle(document.querySelector('[data-horizon-modal]')).zIndex))))", true, true);
  await check('Horizon period picker closes without closing Horizon', "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));!document.querySelector('.period-calendar-popover')&&!document.querySelector('[data-horizon-modal]').hidden", true);
  await check('Horizon Add a key date opens its editor', "document.querySelector('[data-horizon-month-add]').click();new Promise(r=>requestAnimationFrame(()=>r(!!document.querySelector('.horizon-event-popover--keydate-new.is-open'))))", true, true);
  await check('Horizon key-date editor closes and Horizon remains open', "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));!document.querySelector('.horizon-event-popover--keydate-new')&&!document.querySelector('[data-horizon-modal]').hidden", true);
  await check('Horizon closes after popover regression checks', "document.querySelector('[data-horizon-modal] [data-modal-close]').click();new Promise(r=>setTimeout(()=>r(document.querySelector('[data-horizon-modal]').hidden),260))", true, true);

  await check('Fit mode activates', "document.querySelector('[data-expanded-view]').click();document.body.classList.contains('app-expanded')", true);
  await check('Fit mode deactivates', "document.querySelector('[data-expanded-view]').click();!document.body.classList.contains('app-expanded')", true);
  await check('Export menu opens', "document.querySelector('[data-export]').click();!document.querySelector('[data-export-menu]').hidden", true);
  await check('Export menu closes', "document.querySelector('[data-export]').click();document.querySelector('[data-export-menu]').hidden", true);
  await check('Day next navigation skips excluded weekend days', "document.querySelector('[data-next]').click();document.querySelector('[data-date]').textContent.includes('17')", true);
  await check('Day previous navigation returns to the prior configured planning day', "document.querySelector('[data-prev]').click();document.querySelector('[data-date]').textContent.includes('14')", true);

  await check('Close day review opens', "document.querySelector('[data-end-day-open]').click();!document.querySelector('[data-end-day-modal]').hidden", true);
  await check('Close day carry chevron is centered in its control', "(()=>{const box=document.querySelector('.end-day-date-chevron').getBoundingClientRect();const icon=document.querySelector('.end-day-date-chevron .select-chevron').getBoundingClientRect();return Math.abs((box.left+box.width/2)-(icon.left+icon.width/2))<1.5&&Math.abs((box.top+box.height/2)-(icon.top+icon.height/2))<1.5;})()", true);
  await check('Close day completes', "document.querySelector('[data-end-day-form]').requestSubmit();new Promise(r=>setTimeout(()=>r(!document.querySelector('[data-day-closed-modal]').hidden),320))", true, true);
  await check('Post-close page has no reopen action', "!document.querySelector('[data-day-closed-reopen]')", true);
  await check('Friday first shows next planning day prep', "!document.querySelector('[data-next-day-prep]').hidden && document.querySelector('[data-week-review-summary]').hidden", true);
  await check('Friday prep is the required next step', "document.querySelector('[data-day-closed-done]').hidden && document.querySelector('[data-prepare-next-day]').textContent==='Continue to weekly review'", true);
  await check('Next planning day prep persists', "(()=>{const input=document.querySelector('[data-next-day-focus]');input.value='Start Monday calmly';input.dispatchEvent(new Event('input',{bubbles:true}));const stored=JSON.parse(localStorage.getItem('daily-planner:2026-08-17'));return stored.focus==='Start Monday calmly';})()", true);
  await check('Weekly review follows prep in the same flow', "document.querySelector('[data-prepare-next-day]').click();!document.querySelector('[data-week-review-summary]').hidden && document.querySelector('[data-next-day-prep]').hidden && !document.querySelector('[data-day-closed-done]').hidden", true);
  await check('Week review time breakdown renders', "document.querySelectorAll('.week-review-time-track').length>=1", true);
  await check('Unresolved review is integrated into summary', "!!document.querySelector('[data-week-review-summary] [data-review-open-work]')", true);
  await check('Unresolved review opens without losing close-day flow', "document.querySelector('[data-week-review-summary] [data-review-open-work]').click();new Promise(r=>setTimeout(()=>r(!document.querySelector('[data-open-work-modal]').hidden),260))", true, true);
  await check('Unresolved tabs expose exact queue counts', "(()=>{const needs=Number(document.querySelector('[data-open-work-count=\"needs\"]')?.textContent);const later=Number(document.querySelector('[data-open-work-count=\"later\"]')?.textContent);return Number.isInteger(needs)&&needs>=0&&Number.isInteger(later)&&later>=0;})()", true);
  await check('Weekly review unresolved total matches both modal queues', "(()=>{const total=Number(document.querySelector('.week-review-section--unresolved .week-review-section__title em')?.textContent);const needs=Number(document.querySelector('[data-open-work-count=\"needs\"]')?.textContent);const later=Number(document.querySelector('[data-open-work-count=\"later\"]')?.textContent);return total===needs+later;})()", true);
  await check('Closing unresolved returns to weekly review', "document.querySelector('[data-open-work-modal] [data-modal-close]').click();new Promise(r=>setTimeout(()=>r(!document.querySelector('[data-day-closed-modal]').hidden && !document.querySelector('[data-week-review-summary]').hidden),460))", true, true);
  await check('Close-day flow can finish before mobile shell checks', "document.querySelector('[data-day-closed-done]').click();new Promise(r=>setTimeout(()=>r(document.querySelector('[data-day-closed-modal]').hidden),300))", true, true);

  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise(resolveWait => setTimeout(resolveWait, 80));
  await check('View toggle sits before the date identity on mobile', "document.querySelector('.date-identity').firstElementChild.matches('[data-week-view]')", true);
  await check('Mobile removes previous/next chrome', "getComputedStyle(document.querySelector('[data-prev]')).display==='none'&&getComputedStyle(document.querySelector('[data-next]')).display==='none'", true);
  await check('Mobile Today control is hidden on today', "getComputedStyle(document.querySelector('[data-today]')).display==='none'&&getComputedStyle(document.querySelector('[data-today-label]')).display==='none'&&document.querySelector('[data-today-day]').textContent==='14'", true);
  await check('Mobile Today control appears away from today', "document.querySelector('[data-next]').click();getComputedStyle(document.querySelector('[data-today]')).display!=='none'", true);
  await check('Mobile Today control returns to today', "document.querySelector('[data-today]').click();getComputedStyle(document.querySelector('[data-today]')).display==='none'", true);
  await check('Mobile header uses larger action targets and icons', "(()=>{const button=document.querySelector('[data-mobile-more]');const icon=button.querySelector('svg');return button.getBoundingClientRect().width>=38&&icon.getBoundingClientRect().width>=21;})()", true);
  await check('Mobile Horizon moves into the More menu', "(()=>{const direct=document.querySelector('.header-horizon-action');document.querySelector('[data-mobile-more]').click();const menu=document.querySelector('[data-mobile-more-menu]');const horizon=menu.querySelector('[data-horizon-open]');return getComputedStyle(direct).display==='none'&&!menu.hidden&&!!horizon&&horizon.getBoundingClientRect().height>=44&&parseFloat(getComputedStyle(horizon).fontSize)>=12;})()", true);
  await check('Mobile Horizon entry opens the strategic layer', "document.querySelector('[data-mobile-more-menu] [data-horizon-open]').click();!document.querySelector('[data-horizon-modal]').hidden", true);
  await check('Mobile Misogi field has room for a wrapped placeholder', "parseFloat(getComputedStyle(document.querySelector('[data-horizon-misogi]')).minHeight)>=58", true);
  await check('Mobile Horizon closes after responsive checks', "document.querySelector('[data-horizon-modal] [data-modal-close]').click();new Promise(r=>setTimeout(()=>r(document.querySelector('[data-horizon-modal]').hidden),260))", true, true);
  await check('Day workspace reserves horizontal touch gestures for swipe navigation', "getComputedStyle(document.querySelector('[data-workspace]')).touchAction==='pan-y'", true);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await client.evaluate("document.querySelector('[data-mobile-view=\"schedule\"]').click()");
  const swipePoint = await client.evaluate("(()=>{const r=document.querySelector('[data-schedule-pane]').getBoundingClientRect();return {left:r.left,right:r.right,y:r.top+Math.min(420,r.height*.7)};})()");
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: swipePoint.left + 75, y: swipePoint.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipePoint.left + 5, y: swipePoint.y + 4, radiusX: 4, radiusY: 4, force: 1, id: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  await check('Mobile physical swipe left advances to the next planning day', "document.querySelector('[data-date]').textContent.includes('17')", true);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: swipePoint.left + 5, y: swipePoint.y, radiusX: 4, radiusY: 4, force: 1, id: 2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipePoint.left + 75, y: swipePoint.y + 4, radiusX: 4, radiusY: 4, force: 1, id: 2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  await check('Mobile physical swipe right returns to the previous planning day', "document.querySelector('[data-date]').textContent.includes('14')", true);
  await check('Mobile Plan/Schedule dock has a real touch target', "document.querySelector('[data-mobile-view=\\\"plan\\\"]').getBoundingClientRect().height>=44&&parseFloat(getComputedStyle(document.querySelector('[data-mobile-view=\\\"plan\\\"]')).fontSize)>=13", true);
  await check('Mobile schedule no longer carries a large bottom padding', "parseFloat(getComputedStyle(document.querySelector('[data-schedule-scroll]')).paddingBottom)<=12", true);
  await check('Mobile Plan scroller stops above persistent dock', "document.querySelector('[data-left-pane]').getBoundingClientRect().bottom<=document.querySelector('[data-mobile-view-switch]').getBoundingClientRect().top+1", true);
  await check('Mobile Schedule scroller stops above persistent dock', "document.querySelector('[data-schedule-pane]').getBoundingClientRect().bottom<=document.querySelector('[data-mobile-view-switch]').getBoundingClientRect().top+1", true);
  await check('Mobile schedule exposes the floating add action', "document.querySelector('[data-mobile-view=\\\"schedule\\\"]').click();getComputedStyle(document.querySelector('[data-mobile-schedule-add]')).display==='grid'", true);
  await check('Mobile floating add opens the block editor', "document.querySelector('[data-mobile-schedule-add]').click();!document.querySelector('[data-block-modal]').hidden", true);
  await check('Modal suppresses persistent mobile chrome', "getComputedStyle(document.querySelector('[data-mobile-schedule-add]')).visibility==='hidden'&&getComputedStyle(document.querySelector('[data-mobile-view-switch]')).visibility==='hidden'", true);
  await check('Modal layer sits above mobile actions', "Number(getComputedStyle(document.querySelector('[data-block-modal]')).zIndex)>Number(getComputedStyle(document.querySelector('[data-mobile-view-switch]')).zIndex)", true);
  await check('Mobile floating add editor closes', "document.querySelector('[data-block-modal] [data-modal-close]').click();new Promise(r=>setTimeout(()=>r(document.querySelector('[data-block-modal]').hidden),260))", true, true);
  await check('Mobile Week block copy stays clear of its checkbox', "document.querySelector('[data-week-view]').click();new Promise(r=>requestAnimationFrame(()=>{const block=document.querySelector('.week-time-block');const title=block?.querySelector('strong');const meta=block?.querySelector('.week-time-block__meta');const check=block?.querySelector('.week-time-block__check');if(!title||!meta||!check)return r(false);const t=title.getBoundingClientRect();const m=meta.getBoundingClientRect();const c=check.getBoundingClientRect();r(t.right<=c.left+1&&m.right<=c.left+1);}))", true, true);
  await check('Day view restores after mobile Week geometry check', "document.querySelector('[data-week-view]').click();document.querySelector('[data-week-view]').getAttribute('aria-pressed')==='false'", true);

  await new Promise(resolveWait => setTimeout(resolveWait, 80));
  const errors = runtimeErrors(client.events);
  if (errors.length) failures.push(...errors.map(error => `runtime: ${error}`));

  if (failures.length) {
    console.error(`Smoke test failed (${failures.length}):`);
    failures.forEach(failure => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log('Chromium smoke test passed: Day, Week, core modals, Fit mode, Export, next-planning-day prep, and the post-close weekly review are interactive.');
  }
} finally {
  client?.close();
  if (!browser.killed) browser.kill('SIGTERM');
  await Promise.race([
    new Promise(resolveExit => browser.once('exit', resolveExit)),
    new Promise(resolveExit => setTimeout(resolveExit, 1200))
  ]);
  await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 });
}
