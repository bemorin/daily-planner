/**
 * A number field the app's way: − [value] + with large hit areas instead of
 * the browser's tiny overlapping spin arrows, and optional one-click quick
 * choices underneath. Typing still works and the input keeps its name, so a
 * form reads it as before. Holding − or + repeats, faster after a moment.
 *
 *   createStepper(input, { min: 2, max: 100000, quick: [10, 25, 50], noun: 'people', onChange })
 *
 * Every change made here fires the input's own `input` and `change` events.
 * `prefix` names the CSS classes (default "stepper": .stepper, .stepper__btn,
 * .stepper__quick, .stepper__chip), so another page can style its own.
 */

const HOLD_DELAY_MS = 420;
const HOLD_EVERY_MS = 90;
const FAST_AFTER = 8;

const MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 12h12"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 6v12M6 12h12"/></svg>';

/** A whole number within [min, max], or null when `value` isn't one (empty, letters). */
export function readCount(value, { min = 1, max = 100000 } = {}) {
  const text = String(value ?? '').replace(/[\s,\u00a0\u202f]/g, '');
  if (!/^\d+$/.test(text)) return null;
  return Math.min(max, Math.max(min, Number(text)));
}

/** One step from `value` (or from min/max when there's no number yet). */
export function stepCount(value, delta, { min = 1, max = 100000, step = 1 } = {}) {
  const now = readCount(value, { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (now == null) return min;
  return Math.min(max, Math.max(min, now + delta * step));
}

const formatCount = value => new Intl.NumberFormat('en-US').format(value);
let stepperId = 0;

export function createStepper(input, { min = 1, max = 100000, step = 1, quick = [], noun = '', prefix = 'stepper', onChange = () => {} } = {}) {
  if (!input || input.closest(`.${prefix}`)) return null;
  const range = { min, max, step };

  const box = document.createElement('div');
  box.className = prefix;
  const button = (delta, label) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `${prefix}__btn ${prefix}__btn--${delta < 0 ? 'down' : 'up'}`;
    node.setAttribute('aria-label', label);
    node.innerHTML = delta < 0 ? MINUS : PLUS;
    node.dataset.delta = String(delta);
    return node;
  };
  // A wrapping <label> would name the first button instead: point it at the input.
  const label = input.closest('label');
  if (label && !label.htmlFor) {
    stepperId += 1;
    if (!input.id) input.id = `${prefix}-input-${stepperId}`;
    label.htmlFor = input.id;
  }
  const down = button(-1, noun ? `Fewer ${noun}` : 'Decrease');
  const up = button(1, noun ? `More ${noun}` : 'Increase');
  input.replaceWith(box);
  box.append(down, input, up);
  input.classList.add(`${prefix}__input`);

  let chips = [];
  let row = null;
  if (quick.length) {
    row = document.createElement('div');
    row.className = `${prefix}__quick`;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', noun ? `Quick choices, number of ${noun}` : 'Quick choices');
    chips = quick.map(value => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `${prefix}__chip`;
      chip.dataset.value = String(value);
      chip.textContent = formatCount(value);
      if (noun) chip.setAttribute('aria-label', `${formatCount(value)} ${noun}`);
      return chip;
    });
    row.append(...chips);
    box.after(row);
  }

  function sync() {
    const value = readCount(input.value, { min: 0, max: Number.MAX_SAFE_INTEGER });
    down.setAttribute('aria-disabled', String(value != null && value <= min));
    up.setAttribute('aria-disabled', String(value != null && value >= max));
    chips.forEach(chip => chip.setAttribute('aria-pressed', String(value === Number(chip.dataset.value))));
  }

  // What the next `change` came from: a step, a quick choice, or typing.
  let source = '';
  function set(value, from) {
    const next = String(value);
    if (input.value === next) return;
    input.value = next;
    sync();
    source = from;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const nudge = delta => set(stepCount(input.value, delta, range), 'step');

  // Hold to repeat: one step on press, then a steady repeat that speeds up.
  let timer = 0;
  let repeats = 0;
  let pressed = null;
  const stopHold = () => {
    window.clearTimeout(timer);
    timer = 0;
    repeats = 0;
  };
  const repeat = delta => {
    timer = window.setTimeout(() => {
      repeats += 1;
      const before = input.value;
      nudge(delta * (repeats > FAST_AFTER * 2 ? 10 : 1));
      if (input.value === before) return stopHold();
      repeat(delta);
    }, repeats > FAST_AFTER ? HOLD_EVERY_MS / 2 : HOLD_EVERY_MS);
  };

  [down, up].forEach(node => {
    node.addEventListener('pointerdown', event => {
      if (event.button !== 0 || node.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      pressed = node;
      const delta = Number(node.dataset.delta);
      nudge(delta);
      stopHold();
      timer = window.setTimeout(() => repeat(delta), HOLD_DELAY_MS);
    });
    // Touch pointers also "leave" right after lifting, before the click.
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(type => node.addEventListener(type, stopHold));
    node.addEventListener('keydown', () => { pressed = null; });
    node.addEventListener('contextmenu', event => event.preventDefault());
    node.addEventListener('click', () => {
      // A pointer press already stepped; Enter or Space on the button steps here.
      if (pressed === node) {
        pressed = null;
        return;
      }
      if (node.getAttribute('aria-disabled') !== 'true') nudge(Number(node.dataset.delta));
    });
  });

  chips.forEach(chip => chip.addEventListener('click', () => set(chip.dataset.value, 'quick')));

  input.addEventListener('input', sync);
  // Typing: settle on a whole number within range when the field is left.
  input.addEventListener('change', () => {
    const from = source || 'type';
    source = '';
    const value = readCount(input.value, range);
    if (value != null && String(value) !== input.value) {
      input.value = String(value);
      sync();
    }
    onChange(value, from);
  });
  // The wheel never changes the number by accident while scrolling the page.
  input.addEventListener('wheel', () => { if (document.activeElement === input) input.blur(); }, { passive: true });

  sync();
  return {
    set: value => { input.value = value == null ? '' : String(value); sync(); },
    sync,
    get value() { return readCount(input.value, range); },
    element: box,
    quick: row
  };
}
