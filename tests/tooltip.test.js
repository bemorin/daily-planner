import test from 'node:test';
import assert from 'node:assert/strict';
import { placeTooltip, TOOLTIP_GAP, TOOLTIP_MARGIN } from '../src/ui/tooltip.js';

const viewport = { width: 1440, height: 900 };
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });

test('a tooltip sits centred below its control when there is room', () => {
  const place = placeTooltip(rect(600, 100, 40, 30), { width: 120, height: 24 }, viewport);
  assert.equal(place.placement, 'below');
  assert.equal(place.top, 130 + TOOLTIP_GAP);
  assert.equal(place.left, 620 - 60);
});

test('it flips above near the bottom of the viewport', () => {
  const place = placeTooltip(rect(600, 860, 40, 30), { width: 120, height: 24 }, viewport);
  assert.equal(place.placement, 'above');
  assert.equal(place.top, 860 - TOOLTIP_GAP - 24);
});

test('it never comes closer than the margin to a viewport edge', () => {
  const right = placeTooltip(rect(1420, 100, 16, 16), { width: 260, height: 38 }, viewport);
  assert.equal(right.left, viewport.width - TOOLTIP_MARGIN - 260);
  const left = placeTooltip(rect(2, 100, 16, 16), { width: 260, height: 38 }, viewport);
  assert.equal(left.left, TOOLTIP_MARGIN);
  const phone = placeTooltip(rect(350, 400, 30, 30), { width: 260, height: 38 }, { width: 390, height: 844 });
  assert.ok(phone.left >= TOOLTIP_MARGIN && phone.left + 260 <= 390 - TOOLTIP_MARGIN);
});

test('inside a dialog it stays within the visible area and prefers above when there is no room below', () => {
  // Close day: the last row's Forget button sits just above the dialog's action bar.
  const list = rect(418, 417, 600, 328);
  const forget = rect(958, 705, 48, 34);
  const place = placeTooltip(forget, { width: 244, height: 25 }, viewport, { bounds: list, inDialog: true });
  assert.equal(place.placement, 'above');
  assert.ok(place.top >= list.top && place.top + 25 <= forget.top, 'above the button, inside the list');
  assert.ok(place.left + 244 <= list.right, 'does not cross the dialog edge');
  assert.ok(place.left >= list.left);
});

test('when the area is too small for either side, dialogs fall back to above and pages to below', () => {
  const tiny = rect(100, 300, 400, 40);
  const anchor = rect(200, 305, 30, 30);
  assert.equal(placeTooltip(anchor, { width: 120, height: 24 }, viewport, { bounds: tiny, inDialog: true }).placement, 'above');
  assert.equal(placeTooltip(anchor, { width: 120, height: 24 }, viewport, { bounds: tiny }).placement, 'below');
});

test('a tooltip wider than its area is clamped to the viewport instead', () => {
  const narrow = rect(300, 0, 100, 900);
  const place = placeTooltip(rect(340, 200, 20, 20), { width: 200, height: 24 }, viewport, { bounds: narrow });
  assert.equal(place.left, 250);
});
