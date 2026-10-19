/**
 * An app-style dropdown for the public pages: a button that opens a list,
 * like the planner's own menus, instead of the browser's <select> popup.
 * The chosen value lives in a hidden input inside the host, so a form reads
 * it with FormData exactly as it read the select.
 *
 *   <div class="lb" data-listbox>
 *     <input type="hidden" name="plan" value="up-to-50">
 *     <button class="lb__trigger" type="button" aria-haspopup="listbox" aria-labelledby="…">…</button>
 *   </div>
 *
 *   const plan = createListbox(host, { options: [{ value, label, hint }], onChange })
 *   plan.value · plan.setValue(value) · plan.setOptions(options) · plan.close()
 *
 * Keyboard, as a native select: Enter, Space, ArrowDown or ArrowUp open the
 * list on the selected option; then ArrowUp/ArrowDown, Home/End, typing the
 * start of an option (typeahead), Enter/Space to choose, Escape to close, Tab
 * to close and move on. A click or tap outside closes it. The list opens
 * upwards when there's no room below.
 */

const CHECK = '<svg class="lb__check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6.5 12.5 3.3 3.3 7.7-8"/></svg>';
const TYPEAHEAD_RESET_MS = 700;

let openList = null;
let uid = 0;

/**
 * Where typing `query` lands in `labels`: the next label after `from` that
 * starts with it (case and accents ignored), wrapping around; -1 when none.
 * Repeating one letter cycles through the labels that start with it.
 */
export function typeaheadIndex(labels, query, from = -1) {
  const fold = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const wanted = fold(query);
  if (!wanted || !labels.length) return -1;
  const repeated = [...wanted].every(character => character === wanted[0]);
  const needle = repeated ? wanted[0] : wanted;
  // A longer query keeps matching the current option; a new letter moves on.
  const start = repeated ? from + 1 : Math.max(0, from);
  for (let step = 0; step < labels.length; step += 1) {
    const index = (start + step) % labels.length;
    if (fold(labels[index]).startsWith(needle)) return index;
  }
  return -1;
}

export function createListbox(host, { options = [], value, onChange = () => {} } = {}) {
  const input = host.querySelector('input[type="hidden"]');
  const trigger = host.querySelector('.lb__trigger');
  if (!input || !trigger) return null;
  uid += 1;
  const listId = `lb-list-${uid}`;
  if (!trigger.id) trigger.id = `lb-trigger-${uid}`;

  const valueBox = document.createElement('span');
  valueBox.className = 'lb__value';
  const chevron = trigger.querySelector('.lb__chev');
  trigger.replaceChildren(valueBox, ...(chevron ? [chevron] : []));
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', listId);

  const list = document.createElement('ul');
  list.className = 'lb__list';
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', (trigger.getAttribute('aria-labelledby') || trigger.id).split(/\s+/)[0]);
  list.tabIndex = -1;
  list.hidden = true;
  host.append(list);

  let items = [];
  let current = '';
  let typed = '';
  let typedAt = 0;

  const indexOf = val => items.findIndex(item => item.value === val);
  const optionNodes = () => [...list.children];

  function renderValue() {
    const item = items[indexOf(current)];
    const children = [];
    if (item) {
      const label = document.createElement('span');
      label.className = 'lb__label';
      label.textContent = item.label;
      children.push(label);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'lb__hint';
        hint.textContent = item.hint;
        children.push(hint);
      }
    }
    valueBox.replaceChildren(...children);
    input.value = current;
  }

  function renderList() {
    list.replaceChildren(...items.map((item, index) => {
      const option = document.createElement('li');
      const selected = item.value === current;
      option.className = `lb__option${selected ? ' is-selected' : ''}`;
      option.id = `${listId}-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(selected));
      option.tabIndex = -1;
      option.dataset.index = String(index);
      const label = document.createElement('span');
      label.className = 'lb__label';
      label.textContent = item.label;
      option.append(label);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'lb__hint';
        hint.textContent = item.hint;
        option.append(hint);
      }
      // The check closes the row, as in the planner's menus.
      option.insertAdjacentHTML('beforeend', CHECK);
      return option;
    }));
  }

  function focusOption(index) {
    const nodes = optionNodes();
    if (!nodes.length) return;
    const node = nodes[Math.max(0, Math.min(nodes.length - 1, index))];
    node.focus({ preventScroll: true });
    // Keep the focused option in view inside the list only, never the page.
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 4;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
  }

  function place() {
    host.classList.remove('lb--up');
    const rect = trigger.getBoundingClientRect();
    const height = list.offsetHeight;
    const below = window.innerHeight - rect.bottom;
    if (below < height + 12 && rect.top > below) host.classList.add('lb--up');
    // Room on neither side (a short phone screen): bring the whole list into view.
    const box = list.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) list.scrollIntoView({ block: 'nearest' });
  }

  function onOutside(event) {
    if (!host.contains(event.target)) close();
  }

  function open(focus = 'selected') {
    if (!list.hidden) return;
    openList?.close();
    openList = api;
    renderList();
    list.hidden = false;
    host.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    place();
    const selected = Math.max(0, indexOf(current));
    focusOption(focus === 'first' ? 0 : focus === 'last' ? items.length - 1 : typeof focus === 'number' ? focus : selected);
    document.addEventListener('pointerdown', onOutside, true);
    requestAnimationFrame(() => { if (!list.hidden) host.classList.add('is-shown'); });
  }

  function close({ restoreFocus = false } = {}) {
    if (list.hidden) return;
    list.hidden = true;
    host.classList.remove('is-open', 'is-shown', 'lb--up');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (openList === api) openList = null;
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function choose(index) {
    const item = items[index];
    if (!item) return;
    const changed = item.value !== current;
    current = item.value;
    renderValue();
    close({ restoreFocus: true });
    if (changed) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      onChange(current);
    }
  }

  function typeahead(key) {
    const now = Date.now();
    typed = now - typedAt > TYPEAHEAD_RESET_MS ? key : typed + key;
    typedAt = now;
    const nodes = optionNodes();
    const from = list.hidden ? indexOf(current) : nodes.indexOf(document.activeElement);
    return typeaheadIndex(items.map(item => item.label), typed, from);
  }

  const printable = event => event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey;

  trigger.addEventListener('click', () => {
    if (list.hidden) open();
    else close({ restoreFocus: true });
  });

  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      open(event.key === 'Home' ? 'first' : 'last');
    } else if (printable(event)) {
      const index = typeahead(event.key);
      if (index >= 0) {
        event.preventDefault();
        open(index);
      }
    }
  });

  // A space typed within a typeahead ("up to 5") is part of the query, not a choice.
  const typingSpace = event => event.key === ' ' && typed && Date.now() - typedAt <= TYPEAHEAD_RESET_MS;

  list.addEventListener('keydown', event => {
    const index = optionNodes().indexOf(document.activeElement);
    if (typingSpace(event)) {
      event.preventDefault();
      event.stopPropagation();
      const found = typeahead(' ');
      if (found >= 0) focusOption(found);
      return;
    }
    const keys = {
      ArrowDown: () => focusOption(index + 1),
      ArrowUp: () => focusOption(index - 1),
      Home: () => focusOption(0),
      End: () => focusOption(items.length - 1),
      PageDown: () => focusOption(index + 5),
      PageUp: () => focusOption(index - 5),
      Enter: () => choose(index),
      ' ': () => choose(index),
      Escape: () => close({ restoreFocus: true })
    };
    if (keys[event.key]) {
      event.preventDefault();
      event.stopPropagation();
      keys[event.key]();
    } else if (event.key === 'Tab') {
      // Leave from the trigger, so Tab moves on as it would from a select.
      close({ restoreFocus: true });
    } else if (printable(event)) {
      const found = typeahead(event.key);
      if (found >= 0) focusOption(found);
    }
  });

  list.addEventListener('click', event => {
    const option = event.target.closest('[role="option"]');
    if (option) choose(Number(option.dataset.index));
  });

  // The pointer and the keyboard share one highlight: hovering moves focus.
  list.addEventListener('pointermove', event => {
    const option = event.target.closest('[role="option"]');
    if (option && document.activeElement !== option && event.pointerType === 'mouse') option.focus({ preventScroll: true });
  });

  const api = {
    get value() { return current; },
    setValue(next) {
      if (indexOf(String(next)) < 0) return;
      current = String(next);
      renderValue();
      if (!list.hidden) renderList();
    },
    setOptions(next, fallback) {
      items = (next || []).map(item => ({ value: String(item.value), label: String(item.label), hint: item.hint ? String(item.hint) : '' }));
      if (indexOf(current) < 0) current = indexOf(String(fallback)) >= 0 ? String(fallback) : (items[0]?.value || '');
      renderValue();
      if (!list.hidden) renderList();
    },
    focus() { trigger.focus(); },
    close,
    trigger
  };

  current = String(value ?? input.value ?? '');
  api.setOptions(options, current);
  return api;
}
