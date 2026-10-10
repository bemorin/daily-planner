import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptFeedback } from '../src/features/feedback.js';
import { installMode } from '../src/features/install.js';

const now = new Date('2026-10-20T10:00:00Z');
const seen = days => new Date(now.getTime() - days * 86400000).toISOString();

test('feedback is asked once per version, after real use, at most every two weeks', () => {
  const base = { versions: { '1.18.0': { firstSeen: seen(5) } }, lastPromptAt: '' };
  assert.equal(shouldPromptFeedback(base, { version: '1.18.0', now, closeDayCount: 6 }), true);
  assert.equal(shouldPromptFeedback(base, { version: '1.18.0', now, closeDayCount: 4 }), false, 'needs five closed days');
  assert.equal(shouldPromptFeedback({ versions: { '1.18.0': { firstSeen: seen(1) } } }, { version: '1.18.0', now, closeDayCount: 9 }), false, 'needs three days on this version');
  assert.equal(shouldPromptFeedback({ versions: { '1.18.0': { firstSeen: seen(9), sent: seen(2) } } }, { version: '1.18.0', now, closeDayCount: 9 }), false, 'already rated');
  assert.equal(shouldPromptFeedback({ versions: { '1.18.0': { firstSeen: seen(9), dismissed: seen(2) } } }, { version: '1.18.0', now, closeDayCount: 9 }), false, 'dismissed for this version');
  assert.equal(shouldPromptFeedback({ versions: { '1.18.0': { firstSeen: seen(40), prompted: seen(20) } } }, { version: '1.18.0', now, closeDayCount: 9 }), false, 'shown once already, even if never answered');
  assert.equal(shouldPromptFeedback({ ...base, lastPromptAt: seen(10) }, { version: '1.18.0', now, closeDayCount: 9 }), false, 'asked recently about another version');
  assert.equal(shouldPromptFeedback(base, { version: '1.18.0', now, closeDayCount: 9, enabled: false }), false, 'no endpoint, no prompt');
  assert.equal(shouldPromptFeedback(base, { version: '1.19.0', now, closeDayCount: 9 }), false, 'a version never seen is not asked about');
});

test('install guidance follows the browser in hand', () => {
  const iPhone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
  const samsung = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36';
  assert.equal(installMode({ ua: chrome, standalone: true }), 'installed');
  assert.equal(installMode({ ua: chrome, hasPrompt: true }), 'prompt');
  assert.equal(installMode({ ua: iPhone }), 'ios');
  assert.equal(installMode({ ua: macSafari, platform: 'MacIntel', maxTouchPoints: 5 }), 'ios', 'iPadOS reports a Mac with touch');
  assert.equal(installMode({ ua: macSafari, platform: 'MacIntel', maxTouchPoints: 0 }), 'mac-safari');
  assert.equal(installMode({ ua: chrome }), 'chromium');
  assert.equal(installMode({ ua: firefox }), 'firefox');
  assert.equal(installMode({ ua: samsung }), 'android-menu');
  const androidChrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  assert.equal(installMode({ ua: androidChrome }), 'android-menu', 'Android Chrome without a prompt uses the menu');
  assert.equal(installMode({ ua: androidChrome, hasPrompt: true }), 'prompt');
});
