'use strict';

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const DRAG_THRESHOLD = 6;
const clampScale = value => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(value) ? value : 1));

/** Add local touch pan/zoom without replacing any chart nodes or event listeners.
 * Destroy leaves the last rendered layout in place so callers can capture scroll
 * positions before replacing the chart. It removes all active behavior.
 */
function mountChartZoom(viewport, content, options = {}) {
  const doc = viewport.ownerDocument;
  const win = doc.defaultView;
  const requestFrame = win?.requestAnimationFrame?.bind(win) || (callback => setTimeout(callback, 16));
  const cancelFrame = win?.cancelAnimationFrame?.bind(win) || clearTimeout;
  const now = () => win?.performance?.now?.() ?? Date.now();
  const make = (tag, className) => {
    const element = doc.createElement(tag);
    element.className = className;
    return element;
  };
  const spacer = make('div', 'ht-chart-zoom-spacer');
  const layer = make('div', 'ht-chart-zoom-layer');
  Object.assign(spacer.style, { position: 'relative', overflow: 'hidden', flex: 'none' });
  Object.assign(layer.style, { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0' });
  let scale = clampScale(options.initialScale);
  let notifiedScale = scale;
  let size = { width: 0, height: 0 };
  const readViewSize = () => ({ width: viewport.clientWidth || 0, height: viewport.clientHeight || 0 });
  const isVisible = dimensions => dimensions.width > 0 && dimensions.height > 0;
  let viewSize = readViewSize();
  let center = { x: 0, y: 0 };
  let suspended = false;
  let destroyed = false;
  let frame = null;
  let gesture = null;
  let handled = false;
  let suppressUntil = 0;
  let lastInputWasTouch = false;
  const pointers = new Map();
  const captured = new Set();
  const listeners = [];
  const listen = (element, type, callback, settings) => {
    element.addEventListener(type, callback, settings);
    listeners.push(() => element.removeEventListener(type, callback, settings));
  };
  const readSize = () => {
    const measured = options.getSize?.() || { width: content.offsetWidth, height: content.offsetHeight };
    const dimension = value => Number.isFinite(value) ? Math.max(0, value) : 0;
    return { width: dimension(measured.width), height: dimension(measured.height) };
  };
  // Measure before wrapping. getSize must always return unscaled layout dimensions.
  size = readSize();
  content.replaceWith(spacer);
  spacer.append(layer);
  layer.append(content);
  viewport.classList.add('ht-chart-zoom-viewport');
  viewport.classList.add('ht-chart-zoom-layout');

  const controls = make('div', 'ht-chart-zoom-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Chart zoom');
  const value = make('span', 'ht-chart-zoom-value');
  value.setAttribute('role', 'status');
  value.setAttribute('aria-live', 'polite');
  value.setAttribute('aria-atomic', 'true');
  const button = (text, label, action) => {
    const element = make('button', 'ht-chart-zoom-button');
    element.type = 'button';
    element.textContent = text;
    element.setAttribute('aria-label', label);
    listen(element, 'click', action);
    return element;
  };
  const zoomOut = button('−', 'Zoom chart out', () => zoomAtCenter(scale - 0.1));
  const reset = button('100%', 'Reset chart zoom to 100%', () => zoomAtCenter(1));
  const zoomIn = button('+', 'Zoom chart in', () => zoomAtCenter(scale + 0.1));
  controls.append(zoomOut, value, reset, zoomIn);

  function rememberCenter() {
    center = {
      x: ((viewport.scrollLeft || 0) + viewSize.width / 2) / scale,
      y: ((viewport.scrollTop || 0) + viewSize.height / 2) / scale
    };
  }
  function updateGeometry() {
    viewport.style.setProperty('--ht-chart-base-height', size.height + 'px');
    layer.style.width = size.width + 'px';
    layer.style.height = size.height + 'px';
    layer.style.transform = `scale(${scale})`;
    spacer.style.width = size.width * scale + 'px';
    spacer.style.height = size.height * scale + 'px';
    value.textContent = Math.round(scale * 100) + '%';
    zoomOut.disabled = scale <= MIN_SCALE;
    zoomIn.disabled = scale >= MAX_SCALE;
  }
  function scrollTo(left, top) {
    viewport.scrollLeft = Math.max(0, Math.min(left, Math.max(0, size.width * scale - viewSize.width)));
    viewport.scrollTop = Math.max(0, Math.min(top, Math.max(0, size.height * scale - viewSize.height)));
    rememberCenter();
  }
  function applyScale(nextScale, anchor, point) {
    scale = clampScale(nextScale);
    updateGeometry();
    scrollTo(anchor.x * scale - point.x, anchor.y * scale - point.y);
  }
  function notifyScale() {
    if (notifiedScale === scale) return;
    notifiedScale = scale;
    options.onScaleChange?.(scale);
  }
  function zoomAtCenter(nextScale) {
    if (destroyed) return;
    flush();
    cancelGesture(false);
    rememberCenter();
    applyScale(nextScale, center, { x: viewSize.width / 2, y: viewSize.height / 2 });
    notifyScale();
  }
  function point(event) {
    const rect = viewport.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - (viewport.clientLeft || 0),
      y: event.clientY - rect.top - (viewport.clientTop || 0)
    };
  }
  function pair() {
    const [a, b] = [...pointers.values()];
    return { midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(b.x - a.x, b.y - a.y) };
  }
  function capture() {
    for (const id of pointers.keys()) {
      if (captured.has(id) || !viewport.setPointerCapture) continue;
      try { viewport.setPointerCapture(id); captured.add(id); } catch (_) { /* Contact may already have ended. */ }
    }
  }
  function release(id) {
    if (!captured.delete(id)) return;
    try {
      if (!viewport.hasPointerCapture || viewport.hasPointerCapture(id)) viewport.releasePointerCapture?.(id);
    } catch (_) { /* Detached charts may have already lost capture. */ }
  }
  function consume(event, prevent = true) {
    event.stopPropagation();
    if (prevent && event.cancelable !== false) event.preventDefault();
  }
  function startGesture() {
    if (pointers.size >= 2) {
      const { midpoint, distance } = pair();
      gesture = {
        kind: 'pinch', distance, scale,
        anchor: { x: ((viewport.scrollLeft || 0) + midpoint.x) / scale, y: ((viewport.scrollTop || 0) + midpoint.y) / scale }
      };
      handled = true;
      capture();
    } else if (pointers.size === 1) {
      const [p] = pointers.values();
      gesture = { kind: handled ? 'pan' : 'tap', x: p.x, y: p.y, left: viewport.scrollLeft || 0, top: viewport.scrollTop || 0 };
      if (handled) capture();
    } else {
      gesture = null;
      if (handled) suppressUntil = now() + 750;
      handled = false;
    }
  }
  function renderGesture() {
    if (destroyed || !gesture) return;
    if (!isVisible(readViewSize())) { suspended = true; cancelGesture(); return; }
    if (gesture.kind === 'pan') {
      const [p] = pointers.values();
      scrollTo(gesture.left + gesture.x - p.x, gesture.top + gesture.y - p.y);
    } else if (gesture.kind === 'pinch') {
      const { midpoint, distance } = pair();
      // Coincident fingers establish a baseline once their separation is usable.
      if (gesture.distance < 1) {
        gesture.distance = distance;
        gesture.scale = scale;
        gesture.anchor = { x: ((viewport.scrollLeft || 0) + midpoint.x) / scale, y: ((viewport.scrollTop || 0) + midpoint.y) / scale };
        return;
      }
      applyScale(gesture.scale * distance / gesture.distance, gesture.anchor, midpoint);
    }
  }
  function flush() {
    if (frame !== null) { cancelFrame(frame); frame = null; }
    renderGesture();
  }
  function schedule() {
    if (frame !== null) return;
    frame = requestFrame(() => { frame = null; renderGesture(); });
  }
  function updatePointer(event) {
    pointers.set(event.pointerId, point(event));
    if (gesture?.kind === 'tap') {
      const p = pointers.get(event.pointerId);
      if (Math.hypot(p.x - gesture.x, p.y - gesture.y) >= DRAG_THRESHOLD) {
        gesture.kind = 'pan';
        handled = true;
        capture();
      }
    }
  }
  function cancelGesture(notify = true) {
    if (frame !== null) { cancelFrame(frame); frame = null; }
    if (handled) suppressUntil = now() + 750;
    gesture = null;
    handled = false;
    pointers.clear();
    for (const id of [...captured]) release(id);
    if (notify) notifyScale();
  }
  function onDown(event) {
    if (destroyed) return;
    if (event.pointerType !== 'touch') { lastInputWasTouch = false; return; }
    lastInputWasTouch = true;
    flush();
    if (!pointers.size) suppressUntil = 0;
    pointers.set(event.pointerId, point(event));
    startGesture();
    consume(event, handled);
  }
  function onMove(event) {
    if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) return;
    updatePointer(event);
    consume(event, handled);
    if (handled) schedule();
  }
  function finishPointer(event, cancelled = false) {
    if (event.pointerType !== 'touch' || !pointers.has(event.pointerId)) return;
    if (!cancelled) updatePointer(event);
    flush();
    consume(event, handled);
    pointers.delete(event.pointerId);
    release(event.pointerId);
    startGesture();
    if (cancelled || !pointers.size) notifyScale();
  }
  listen(viewport, 'pointerdown', onDown, { passive: false });
  listen(viewport, 'pointermove', onMove, { passive: false });
  listen(viewport, 'pointerup', event => finishPointer(event), { passive: false });
  listen(viewport, 'pointercancel', event => finishPointer(event, true), { passive: false });
  listen(viewport, 'lostpointercapture', event => {
    // Ignore the child's implicit capture being transferred to this viewport.
    if (event.target !== viewport || !captured.has(event.pointerId)) return;
    captured.delete(event.pointerId);
    finishPointer(event, true);
  });
  listen(viewport, 'click', event => {
    const touchClick = event.pointerType === 'touch' || (!event.pointerType && (event.sourceCapabilities?.firesTouchEvents || (lastInputWasTouch && event.detail > 0)));
    if (!touchClick || (!handled && now() >= suppressUntil)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  listen(viewport, 'scroll', () => {
    // A resize may clamp native scroll before its observer fires. Keep the old center.
    if (!suspended && viewport.clientWidth === viewSize.width && viewport.clientHeight === viewSize.height) rememberCenter();
  }, { passive: true });

  function refresh() {
    if (destroyed) return;
    const nextSize = readSize();
    const nextViewSize = readViewSize();
    if (!isVisible(nextViewSize)) suspended = true;
    if (!suspended && nextSize.width === size.width && nextSize.height === size.height && nextViewSize.width === viewSize.width && nextViewSize.height === viewSize.height) return;
    // Hidden elements can report zero scroll and ignore writes. Drop pending
    // movement while retaining the last visible center until the chart returns.
    if (!suspended) flush();
    cancelGesture();
    const anchor = center;
    size = nextSize;
    updateGeometry();
    // The base-height variable can change the CSS-constrained viewport height.
    const actualViewSize = readViewSize();
    if (!isVisible(actualViewSize)) { suspended = true; return; }
    viewSize = actualViewSize;
    suspended = false;
    scrollTo(anchor.x * scale - viewSize.width / 2, anchor.y * scale - viewSize.height / 2);
  }
  updateGeometry();
  viewSize = readViewSize();
  if (isVisible(viewSize)) scrollTo(viewport.scrollLeft || 0, viewport.scrollTop || 0);
  else suspended = true;
  const observer = win?.ResizeObserver ? new win.ResizeObserver(() => {
    if (suspended || viewport.clientWidth !== viewSize.width || viewport.clientHeight !== viewSize.height) refresh();
  }) : null;
  observer?.observe(viewport);

  return {
    controls, refresh, getScale: () => scale,
    destroy() {
      if (destroyed) return;
      flush();
      cancelGesture();
      destroyed = true;
      observer?.disconnect();
      for (const remove of listeners) remove();
      viewport.classList.remove('ht-chart-zoom-viewport');
      zoomOut.disabled = reset.disabled = zoomIn.disabled = true;
    }
  };
}

module.exports = { mountChartZoom };
