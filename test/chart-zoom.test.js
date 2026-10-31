'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountChartZoom } = require('../src/chart-zoom');

function setup(options = {}) {
  const frames = new Map(), observers = [], captureLog = [], changes = [];
  let frameId = 0, time = 0;
  let hiddenState = null;
  let size = options.size || { width: 1200, height: 900 };
  const doc = {
    defaultView: {
      performance: { now: () => time },
      requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
      cancelAnimationFrame(id) { frames.delete(id); },
      ResizeObserver: class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(element) { this.element = element; }
        disconnect() { this.disconnected = true; }
      }
    },
    createElement: tag => new Element(tag)
  };
  class Element {
    constructor(tag) {
      this.tagName = tag; this.ownerDocument = doc; this.children = [];
      this.style = { setProperty(name, value) { this[name] = value; } };
      this.attributes = {}; this.listeners = new Map(); this.captures = new Set(); this.className = '';
      this.scrollLeft = 0; this.scrollTop = 0;
      this.clientWidth = 300; this.clientHeight = 200; this.clientLeft = 2; this.clientTop = 3;
      this.classList = {
        add: name => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' '); },
        remove: name => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); }
      };
    }
    append(...elements) {
      for (const element of elements) { element.remove(); element.parentNode = this; this.children.push(element); }
    }
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.children;
      siblings.splice(siblings.indexOf(this), 1); this.parentNode = null;
    }
    replaceWith(element) {
      if (!this.parentNode) return;
      const parent = this.parentNode, index = parent.children.indexOf(this);
      element.remove(); parent.children[index] = element; element.parentNode = parent; this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, fn, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ fn, options });
    }
    removeEventListener(type, fn, options) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.fn !== fn || item.options !== options));
    }
    getBoundingClientRect() { return { left: 10, top: 20, width: this.clientWidth, height: this.clientHeight }; }
    setPointerCapture(id) { captureLog.push(['capture', id]); this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { captureLog.push(['release', id]); this.captures.delete(id); }
    emit(type, properties = {}) {
      const event = {
        type, target: this, pointerType: 'touch', pointerId: 1, clientX: 112, clientY: 123, detail: 1, cancelable: true,
        prevented: false, stopped: false, immediate: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; this.immediate = true; },
        ...properties
      };
      for (const item of this.listeners.get(type) || []) { item.fn(event); if (event.immediate) break; }
      return event;
    }
  }
  const viewport = new Element('div'), content = new Element('div'), svg = new Element('svg');
  content.style.width = size.width + 'px'; content.append(svg); viewport.append(content);
  if (options.cssHeightCap) Object.defineProperty(viewport, 'clientHeight', {
    get() {
      if (!viewport.className.split(' ').includes('ht-chart-zoom-layout')) return size.height;
      return Math.min(parseFloat(viewport.style['--ht-chart-base-height']) || size.height, options.cssHeightCap);
    }
  });
  if (options.hideable) {
    hiddenState = { hidden: false, width: 300, height: 200, left: 0, top: 0, ignoredWrites: 0 };
    for (const [property, key] of [['clientWidth', 'width'], ['clientHeight', 'height'], ['scrollLeft', 'left'], ['scrollTop', 'top']]) {
      Object.defineProperty(viewport, property, {
        get() { return hiddenState.hidden ? 0 : hiddenState[key]; },
        set(value) {
          if (hiddenState.hidden && property.startsWith('scroll')) hiddenState.ignoredWrites++;
          else hiddenState[key] = value;
        }
      });
    }
  }
  viewport.scrollLeft = options.left || 0; viewport.scrollTop = options.top || 0;
  const controller = mountChartZoom(viewport, content, {
    initialScale: options.scale, getSize: () => size, onScaleChange: scale => changes.push(scale)
  });
  const host = new Element('section'); host.append(viewport, controller.controls);
  const pointer = (type, id, x, y, extra) => viewport.emit(type, { pointerId: id, clientX: x + 12, clientY: y + 23, ...extra });
  return {
    viewport, content, svg, controller, frames, observers, captureLog, changes, pointer,
    advance(ms) { time += ms; },
    setHidden(hidden) { hiddenState.hidden = hidden; if (hidden) hiddenState.left = hiddenState.top = 0; },
    hiddenWrites() { return hiddenState.ignoredWrites; },
    resize(width, height) { viewport.clientWidth = width; viewport.clientHeight = height; observers[0].callback(); },
    setSize(next) { size = next; },
    frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); },
    button(label) { return controller.controls.children.find(element => element.attributes['aria-label'] === label); }
  };
}

test('one fixed base layer scales the original chart and SVG inside a clipped, accurately sized spacer', () => {
  const d = setup({ scale: 0.5 });
  const spacer = d.viewport.children[0], layer = spacer.children[0];
  assert.equal(layer.children[0], d.content);
  assert.equal(d.content.children[0], d.svg);
  assert.equal(layer.style.width, '1200px');
  assert.equal(layer.style.height, '900px');
  assert.equal(layer.style.transform, 'scale(0.5)');
  assert.equal(spacer.style.width, '600px');
  assert.equal(spacer.style.height, '450px');
  assert.equal(spacer.style.overflow, 'hidden');
  assert.equal(d.content.style.width, '1200px');
  assert.equal(d.viewport.style['--ht-chart-base-height'], '900px');
  assert.equal(d.controller.controls.children[1].textContent, '50%');
  assert.equal(d.button('Zoom chart out').disabled, true);
  assert.equal(d.controller.controls.attributes['aria-label'], 'Chart zoom');
  assert.deepEqual(d.changes, []);
});

test('tap preserves the event target and click, while touch drag pans locally and suppresses its click', () => {
  const d = setup();
  const down = d.pointer('pointerdown', 1, 100, 100, { target: d.svg });
  d.pointer('pointermove', 1, 103, 101);
  d.pointer('pointerup', 1, 103, 101);
  assert.equal(down.prevented, false);
  assert.equal(down.stopped, true);
  assert.deepEqual(d.captureLog, []);
  assert.equal(d.viewport.emit('click').prevented, false);
  assert.equal(d.viewport.scrollLeft, 0);

  d.pointer('pointerdown', 2, 200, 100);
  const move = d.pointer('pointermove', 2, 150, 70);
  d.pointer('pointermove', 2, 140, 65);
  assert.ok(move.prevented && move.stopped);
  assert.deepEqual(d.captureLog, [['capture', 2]]);
  assert.equal(d.frames.size, 1);
  d.frame();
  assert.equal(d.viewport.scrollLeft, 60);
  assert.equal(d.viewport.scrollTop, 35);
  d.pointer('pointermove', 2, 130, 60);
  d.pointer('pointerup', 2, 120, 50);
  assert.equal(d.viewport.scrollLeft, 80, 'pointerup flushes the final position');
  assert.equal(d.viewport.scrollTop, 50);
  assert.equal(d.frames.size, 0);
  assert.ok(d.viewport.emit('click').immediate);
  assert.equal(d.viewport.emit('click', { pointerType: 'mouse' }).prevented, false);
  assert.equal(d.viewport.emit('click', { pointerType: '', detail: 0 }).prevented, false);
  assert.equal(d.pointer('pointerdown', 8, 40, 40, { pointerType: 'mouse' }).stopped, false);
  d.pointer('pointerdown', 3, 100, 100);
  d.pointer('pointerup', 3, 100, 100);
  assert.equal(d.viewport.emit('click').prevented, false, 'the next real touch tap is allowed immediately');
});

test('pinch keeps the same logical point under its moving midpoint, then continues as a one-finger pan', () => {
  const d = setup({ left: 200, top: 100 });
  d.pointer('pointerdown', 1, 100, 100);
  d.pointer('pointerdown', 2, 200, 100);
  d.pointer('pointermove', 1, 50, 120);
  d.pointer('pointermove', 2, 250, 120);
  assert.equal(d.controller.getScale(), 1, 'movement is batched until animation frame');
  d.frame();
  assert.equal(d.controller.getScale(), 2);
  assert.deepEqual(d.changes, [], 'live frames do not persist partial gestures');
  assert.equal(d.viewport.scrollLeft, 550);
  assert.equal(d.viewport.scrollTop, 280);
  assert.equal((d.viewport.scrollLeft + 150) / 2, 350);
  assert.equal((d.viewport.scrollTop + 120) / 2, 200);
  d.pointer('pointerup', 2, 250, 120);
  assert.deepEqual(d.changes, [], 'the remaining finger is part of the same gesture');
  d.pointer('pointermove', 1, 20, 100);
  d.frame();
  assert.equal(d.viewport.scrollLeft, 580);
  assert.equal(d.viewport.scrollTop, 300);
  assert.equal(d.controller.getScale(), 2);
  d.pointer('pointerup', 1, 20, 100);
  assert.ok(d.viewport.emit('click').prevented);
  assert.deepEqual(d.changes, [2]);
});

test('pinch and controls clamp scale and scroll; reset restores 100% around the viewport center', () => {
  const d = setup({ scale: 99, left: 900, top: 500 });
  assert.equal(d.controller.getScale(), 2.5);
  assert.equal(d.button('Zoom chart in').disabled, true);
  const anchor = (d.viewport.scrollLeft + 150) / 2.5;
  d.button('Reset chart zoom to 100%').emit('click', { pointerType: '', detail: 0 });
  assert.equal(d.controller.getScale(), 1);
  assert.equal(d.viewport.scrollLeft + 150, anchor);
  d.pointer('pointerdown', 1, 100, 100);
  d.pointer('pointerdown', 2, 200, 100);
  d.pointer('pointermove', 1, -100, 100);
  d.pointer('pointermove', 2, 400, 100);
  d.frame(); assert.equal(d.controller.getScale(), 2.5);
  d.pointer('pointermove', 1, 149, 100);
  d.pointer('pointermove', 2, 151, 100);
  d.frame(); assert.equal(d.controller.getScale(), 0.5);
  d.pointer('pointerup', 2, 151, 100);
  d.pointer('pointermove', 1, 2000, 2000);
  d.frame(); assert.equal(d.viewport.scrollLeft, 0); assert.equal(d.viewport.scrollTop, 0);
  d.pointer('pointermove', 1, -2000, -2000);
  d.frame(); assert.equal(d.viewport.scrollLeft, 300); assert.equal(d.viewport.scrollTop, 250);
});

test('third-finger changes, cancellation, and lost capture rebase safely without jumps', () => {
  const d = setup({ left: 200, top: 100 });
  d.pointer('pointerdown', 1, 100, 100);
  d.pointer('pointerdown', 2, 200, 100);
  d.pointer('pointermove', 2, 300, 100); d.frame();
  const before = [d.controller.getScale(), d.viewport.scrollLeft, d.viewport.scrollTop];
  d.pointer('pointerdown', 3, 350, 100);
  assert.deepEqual([d.controller.getScale(), d.viewport.scrollLeft, d.viewport.scrollTop], before);
  d.pointer('pointercancel', 1, 100, 100);
  d.frame();
  assert.deepEqual([d.controller.getScale(), d.viewport.scrollLeft, d.viewport.scrollTop], before);
  d.pointer('lostpointercapture', 2, 300, 100, { target: d.svg });
  d.pointer('pointermove', 3, 360, 100); d.frame();
  assert.equal(d.controller.getScale(), 2.4, 'child implicit-capture loss does not cancel the pinch');
  d.pointer('lostpointercapture', 2, 300, 100);
  const left = d.viewport.scrollLeft;
  d.pointer('pointermove', 2, 500, 100); d.frame();
  assert.equal(d.viewport.scrollLeft, left, 'lost pointer cannot keep manipulating the chart');
  d.pointer('pointermove', 3, 350, 100); d.frame();
  assert.equal(d.viewport.scrollLeft, left + 10);
  d.pointer('pointercancel', 3, 350, 100);
  assert.equal(d.frames.size, 0);
  assert.ok(d.viewport.emit('click').prevented);
  d.advance(751);
  assert.equal(d.viewport.emit('click').prevented, false);
});

test('coincident fingers do not create an infinite scale or unstable scroll', () => {
  const d = setup({ left: 200, top: 100 });
  d.pointer('pointerdown', 1, 100, 100);
  d.pointer('pointerdown', 2, 100, 100);
  d.pointer('pointermove', 2, 100, 100); d.frame();
  assert.equal(d.controller.getScale(), 1);
  d.pointer('pointermove', 2, 110, 100); d.frame();
  assert.equal(d.controller.getScale(), 1);
  d.pointer('pointermove', 2, 120, 100); d.frame();
  assert.equal(d.controller.getScale(), 2);
  assert.ok(Number.isFinite(d.viewport.scrollLeft));
});

test('refresh and viewport rotation preserve the logical center and cancel pending gestures', () => {
  const d = setup({ scale: 1.5, left: 300, top: 200 });
  d.resize(500, 300);
  assert.equal(d.viewport.scrollLeft, 200);
  assert.equal(d.viewport.scrollTop, 150);
  d.viewport.scrollLeft = 350; d.viewport.scrollTop = 225; d.viewport.emit('scroll');
  d.setSize({ width: 1600, height: 1000 }); d.controller.refresh();
  assert.equal(d.viewport.scrollLeft, 350);
  assert.equal(d.viewport.children[0].style.width, '2400px');
  assert.equal(d.viewport.children[0].children[0].style.width, '1600px');
  d.pointer('pointerdown', 1, 100, 100);
  d.pointer('pointermove', 1, 70, 80);
  d.resize(600, 400);
  assert.equal(d.frames.size, 0);
  assert.equal(d.viewport.captures.size, 0);
  const left = d.viewport.scrollLeft;
  d.pointer('pointermove', 1, 10, 10); d.frame();
  assert.equal(d.viewport.scrollLeft, left);
  d.setSize({ width: 100, height: 100 }); d.controller.refresh();
  assert.equal(d.viewport.scrollLeft, 0); assert.equal(d.viewport.scrollTop, 0);
});

test('unchanged geometry refresh keeps an active gesture and its pending frame', () => {
  const d = setup();
  d.pointer('pointerdown', 1, 200, 100);
  d.pointer('pointermove', 1, 150, 70);
  d.controller.refresh();
  assert.equal(d.frames.size, 1);
  assert.equal(d.viewport.captures.size, 1);
  d.frame();
  assert.equal(d.viewport.scrollLeft, 50);
  d.pointer('pointermove', 1, 130, 60); d.frame();
  assert.equal(d.viewport.scrollLeft, 70);
});

test('initial CSS height constraint does not jump the chart, and repacking uses the new viewport height', () => {
  const d = setup({ scale: 2, cssHeightCap: 540 });
  assert.equal(d.viewport.clientHeight, 540);
  assert.equal(d.viewport.scrollTop, 0);
  d.observers[0].callback();
  assert.equal(d.viewport.scrollTop, 0, 'initial observer delivery keeps the chart at its starting position');
  d.viewport.scrollTop = 300; d.viewport.emit('scroll');
  const center = (d.viewport.scrollTop + d.viewport.clientHeight / 2) / d.controller.getScale();
  d.setSize({ width: 1200, height: 400 }); d.controller.refresh();
  assert.equal(d.viewport.clientHeight, 400);
  assert.equal(d.viewport.scrollTop, 370, 'refresh immediately centers using the resized viewport');
  assert.equal((d.viewport.scrollTop + 200) / 2, center);
  d.observers[0].callback();
  assert.equal(d.viewport.scrollTop, 370, 'subsequent observer delivery does not move the chart again');
  d.setSize({ width: 1200, height: 900 }); d.controller.refresh();
  assert.equal(d.viewport.clientHeight, 540);
  assert.equal(d.viewport.scrollTop, 300);
});

test('rotation keeps the old center even when native scrolling clamps before the resize observer', () => {
  const d = setup({ scale: 2, left: 1500 });
  d.viewport.clientWidth = 1500;
  d.viewport.scrollLeft = 900;
  d.viewport.emit('scroll');
  d.observers[0].callback();
  assert.equal(d.viewport.scrollLeft, 900);
  assert.equal((d.viewport.scrollLeft + 750) / 2, 825);
});

test('hidden charts retain their last visible center and restore it when shown at the same size', () => {
  const d = setup({ hideable: true, scale: 1.5, left: 300, top: 200 });
  d.setHidden(true);
  d.viewport.emit('scroll'); d.observers[0].callback(); d.controller.refresh();
  assert.equal(d.viewport.scrollLeft, 0);
  assert.equal(d.viewport.scrollTop, 0);
  assert.equal(d.hiddenWrites(), 0, 'hidden layout is never recentered through ignored native writes');
  d.setHidden(false); d.observers[0].callback();
  assert.equal(d.controller.getScale(), 1.5);
  assert.equal(d.viewport.scrollLeft, 300);
  assert.equal(d.viewport.scrollTop, 200);
});

test('hiding during a pinch drops pending movement and saves the last visible scale and center', () => {
  const d = setup({ hideable: true, left: 200, top: 100 });
  d.pointer('pointerdown', 1, 100, 100);
  d.pointer('pointerdown', 2, 200, 100);
  d.pointer('pointermove', 2, 300, 100); d.frame();
  assert.equal(d.controller.getScale(), 2);
  const left = d.viewport.scrollLeft, top = d.viewport.scrollTop;
  d.pointer('pointermove', 2, 350, 100);
  d.setHidden(true); d.frame(); d.observers[0].callback();
  assert.equal(d.frames.size, 0);
  assert.equal(d.viewport.captures.size, 0);
  assert.deepEqual(d.changes, [2]);
  assert.equal(d.hiddenWrites(), 0);
  d.setHidden(false); d.observers[0].callback();
  assert.equal(d.controller.getScale(), 2);
  assert.equal(d.viewport.scrollLeft, left);
  assert.equal(d.viewport.scrollTop, top);
  d.pointer('pointermove', 2, 400, 100); d.frame();
  assert.equal(d.viewport.scrollLeft, left);
  assert.deepEqual(d.changes, [2]);
});

test('resize cancels an active pinch and persists its final frame once', () => {
  const d = setup({ left: 200, top: 100 });
  d.pointer('pointerdown', 1, 100, 100);
  d.pointer('pointerdown', 2, 200, 100);
  d.pointer('pointermove', 2, 300, 100);
  d.resize(400, 300);
  assert.equal(d.controller.getScale(), 2);
  assert.deepEqual(d.changes, [2]);
  assert.equal(d.frames.size, 0);
  assert.equal(d.viewport.captures.size, 0);
  d.pointer('pointerup', 1, 100, 100);
  d.pointer('pointerup', 2, 300, 100);
  assert.deepEqual(d.changes, [2]);
});

test('destroy during a gesture releases all behavior and retains inert layout for scroll capture', () => {
  const d = setup();
  d.pointer('pointerdown', 1, 200, 100);
  d.pointer('pointerdown', 2, 250, 100);
  d.pointer('pointermove', 2, 300, 100);
  d.controller.destroy(); d.controller.destroy();
  assert.equal(d.frames.size, 0);
  assert.equal(d.viewport.captures.size, 0);
  assert.equal(d.observers[0].disconnected, true);
  assert.equal(d.viewport.children[0].children[0].children[0], d.content);
  assert.equal(d.content.children[0], d.svg);
  assert.equal(d.viewport.className, 'ht-chart-zoom-layout');
  assert.ok(d.controller.controls.parentNode);
  assert.ok(d.button('Reset chart zoom to 100%').disabled);
  assert.deepEqual(d.changes, [2], 'destroy flushes and persists the final scale once');
  for (const element of [d.viewport, ...d.controller.controls.children]) {
    for (const listeners of element.listeners.values()) assert.equal(listeners.length, 0);
  }
  const scale = d.controller.getScale();
  d.pointer('pointermove', 2, 400, 100); d.resize(700, 500); d.controller.refresh();
  assert.equal(d.controller.getScale(), scale);
});
