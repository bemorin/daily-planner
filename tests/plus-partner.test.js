import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The partner program's invitations in the planner: the Plus window (everyone), the share sheet and How it works.
const stored = new Map();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: key => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) }, configurable: true, writable: true });

const { PARTNER_PROGRAM } = await import('../src/lib/pricing.js');
const { partnerEarnText } = await import('../src/features/plus-dialog.js');
const { sharePartnerText } = await import('../src/features/share-dialog.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFile(join(root, rel), 'utf8');

test('what a partner earns is said from the program’s terms, with a calm fallback', () => {
  assert.equal(partnerEarnText(), `${PARTNER_PROGRAM.rate}% of every Plus purchase made through your link`);
  assert.equal(partnerEarnText(25), '25% of every Plus purchase made through your link');
  assert.equal(partnerEarnText(12.5), '12.5% of every Plus purchase made through your link');
  for (const rate of [0, -5, 100, NaN, 'soon', null]) assert.equal(partnerEarnText(rate), 'a commission on every Plus purchase made through your link', String(rate));
  assert.equal(sharePartnerText(), `Earn ${PARTNER_PROGRAM.rate}% of every Plus purchase made through your link.`);
  assert.equal(sharePartnerText(30), 'Earn 30% of every Plus purchase made through your link.');
  assert.equal(sharePartnerText(0), 'Earn a commission on every Plus purchase made through your link.');
});

test('the Plus window invites everyone: members keep their card, others get one quiet line after everything Plus offers', async () => {
  const dialog = await read('src/features/plus-dialog.js');
  assert.doesNotMatch(dialog, /AFFILIATE_COMMISSION|from '\.\.\/config\.js'/, 'the rate comes from PARTNER_PROGRAM, not a build variable');
  assert.match(dialog, /import \{[^}]*\bPARTNER_PROGRAM\b[^}]*\} from '\.\.\/lib\/pricing\.js'/);
  const card = /function partnerCard\(\) \{[\s\S]*?\n {2}\}/.exec(dialog)[0];
  assert.match(card, /if \(!partnerHintShown\('plus'\)\) return '';/, 'shown to everyone until hidden here');
  assert.doesNotMatch(card, /hasPlus\(\) \|\|/, 'no longer for members only');
  assert.match(card, /Not ready for Plus\? <a href="\.\/welcome\/partners\/" target="_blank" rel="noopener" data-plus-partner-go>Become a partner<\/a> — earn \$\{esc\(partnerEarnText\(\)\)\}\./);
  assert.match(card, /data-plus-partner-dismiss aria-label="Hide the partner program"/);
  assert.equal((card.match(/data-plus-partner-go/g) || []).length, 2, 'following it counts as hiding it, in both forms');
  // Without Plus, the line comes after the offer, the gifts and the team line, never beside Get Plus.
  const offer = /const title = focus \?[\s\S]*?\$\{bar\(\)\}`;/.exec(dialog)[0];
  const order = ['${offer()}', '${plusAvailable() ? gifts() : \'\'}', '${teams}', '${plusAvailable() ? partnerCard() : \'\'}', '${privacy}', '${bar()}'].map(part => offer.indexOf(part));
  assert.ok(order.every((at, index) => at > -1 && (!index || at > order[index - 1])), `order ${order}`);
  // With Plus, the card stays where it was: after the gifts, before the team line.
  const member = /if \(active\) \{[\s\S]*?data-plus-close>Done<\/button><\/div>`;/.exec(dialog)[0];
  assert.ok(member.indexOf('${gifts()}') < member.indexOf('${partnerCard()}') && member.indexOf('${partnerCard()}') < member.indexOf('${teams}'));
  assert.match(dialog, /dismissPartnerHint\('plus'\);\s*qs\('\[data-plus-partner\]', el\)\?\.remove\(\);/);
  assert.match(dialog, /\.\/welcome\/teams\//, 'the team line goes to the Teams page');
  assert.doesNotMatch(dialog, /\d+%/, 'no rate typed in by hand');
});

test('the share sheet’s line is for everyone and says the rate', async () => {
  const share = await read('src/features/share-dialog.js');
  assert.doesNotMatch(share, /hasPlus|plusLicense/, 'not gated by Plus');
  assert.match(share, /partner: partnerHintShown\('share'\)/);
  assert.match(share, /dismissPartnerHint\('share'\)/);
  assert.match(share, /\$\{esc\(sharePartnerText\(\)\)\} <a href="\.\/welcome\/partners\/" target="_blank" rel="noopener" data-share-partner-go>Partner program/);
  assert.doesNotMatch(share, /\d+%/, 'no rate typed in by hand');
});

test('How it works keeps a permanent Partners row beside For teams, filled from the program’s terms', async () => {
  const page = await read('index.html');
  const help = /<div class="modal" data-help-modal hidden>[\s\S]*?<div class="help-content">/.exec(page)[0];
  const row = /<div class="help-feedback help-partners" data-partner-entry hidden>[\s\S]*?<\/div>/.exec(help)?.[0] || '';
  assert.ok(row, 'the row exists');
  assert.ok(help.indexOf('help-teams') < help.indexOf('help-partners'), 'right after For teams');
  assert.match(row, /<strong>Partners<\/strong> · Recommend Daily Planner and earn <span data-partner-earn>[^<]*<\/span>\. No Plus needed\./);
  assert.match(row, /<a class="secondary-button" href="\.\/welcome\/partners\/" target="_blank" rel="noopener">See the partner program<\/a>/);
  assert.doesNotMatch(row, /\d/, 'the rate is filled in by the planner, never typed here');
  assert.match(help, /href="\.\/welcome\/teams\/"/);
  assert.doesNotMatch(help, /welcome\/#teams/);
  const dialog = await read('src/features/plus-dialog.js');
  assert.match(dialog, /qsa\('\[data-partner-entry\]'\)\.forEach\(node => \{ node\.hidden = !plannerApiEnabled\(\); \}\);/);
  assert.match(dialog, /qsa\('\[data-partner-earn\]'\)\.forEach\(node => \{ node\.textContent = partnerEarnText\(\); \}\);/);
  const css = await read('styles/guides.css');
  assert.match(css, /\.help-teams \+ \.help-partners \{ margin-top: -8px; \}/, 'grouped with For teams');
});
