const DEFAULT_INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '.time-block',
  '.week-time-block'
].join(',');

export function swipeDirection(deltaX, deltaY, { minDistance = 64, axisRatio = 1.25 } = {}) {
  const horizontal = Math.abs(Number(deltaX) || 0);
  const vertical = Math.abs(Number(deltaY) || 0);
  if (horizontal < minDistance || horizontal < vertical * axisRatio) return 0;
  return deltaX < 0 ? 1 : -1;
}

export function createDaySwipeNavigation({
  element,
  isEnabled,
  onShift,
  interactiveSelector = DEFAULT_INTERACTIVE_SELECTOR,
  minDistance = 64,
  axisRatio = 1.25
}) {
  if (!element) return { destroy() {} };

  let gesture = null;
  const reset = () => { gesture = null; };
  const shouldIgnoreTarget = target => target instanceof Element && !!target.closest(interactiveSelector);

  const onPointerDown = event => {
    if (event.pointerType !== 'touch' || !isEnabled() || shouldIgnoreTarget(event.target)) return;
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const onPointerUp = event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const direction = swipeDirection(event.clientX - gesture.x, event.clientY - gesture.y, { minDistance, axisRatio });
    reset();
    if (!direction || !isEnabled()) return;
    event.preventDefault();
    onShift(direction);
  };

  element.addEventListener('pointerdown', onPointerDown, { passive: true });
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', reset, { passive: true });

  return {
    destroy() {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', reset);
    }
  };
}
