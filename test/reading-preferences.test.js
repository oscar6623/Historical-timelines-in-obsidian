'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadingPreferences } = require('../src/reading-preferences');

const STORAGE_KEY = 'historical-timeline:mobile-reading:v1';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    reads: [],
    writes: [],
    getItem(key) {
      this.reads.push(key);
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      this.writes.push({ key, value });
      data.set(key, value);
    },
  };
}

test('reading mode defaults to true and storage is read lazily without writes', () => {
  const storage = fakeStorage();
  const preferences = createReadingPreferences(storage);
  assert.deepEqual(storage.reads, []);
  assert.equal(preferences.get(), true);
  assert.deepEqual(storage.reads, [STORAGE_KEY]);
  assert.deepEqual(storage.writes, []);
});

test('reading and editing choices persist across reloads and other views', () => {
  const storage = fakeStorage();
  const first = createReadingPreferences(storage);
  const otherView = createReadingPreferences(storage);
  assert.equal(first.set(false), false);
  assert.equal(otherView.get(), false);
  assert.equal(createReadingPreferences(storage).get(), false);
  assert.equal(otherView.set(true), true);
  assert.equal(first.get(), true);
  assert.equal(createReadingPreferences(storage).get(), true);
  storage.data.delete(STORAGE_KEY);
  assert.equal(first.get(), true);
});

test('invalid stored values default to reading mode without migration writes', () => {
  for (const raw of [null, '', '{', 'null', '0', '1', '"false"', '[]', '{}',
    '{"readOnly":false}', '{"eventIds":["event-1"]}', false, 0]) {
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const preferences = createReadingPreferences(storage);
    assert.equal(preferences.get(), true);
    assert.deepEqual(storage.writes, []);
  }
});

test('set only accepts boolean values and does not coerce or overwrite the choice', () => {
  const storage = fakeStorage();
  const preferences = createReadingPreferences(storage);
  preferences.set(false);
  let coerced = false;
  for (const value of [null, undefined, 0, 1, 'true', 'false', [], {}, NaN,
    Symbol('reading'), 1n, { valueOf() { coerced = true; return true; } }]) {
    assert.equal(preferences.set(value), false);
    assert.equal(preferences.get(), false);
  }
  assert.equal(coerced, false);
  assert.deepEqual(storage.writes, [{ key: STORAGE_KEY, value: 'false' }]);
});

test('unavailable storage retains reading and editing choices for the session', () => {
  const throwingProperty = {};
  Object.defineProperty(throwingProperty, 'getItem', { get() { throw new Error('Blocked'); } });
  for (const storage of [null, undefined, {}, throwingProperty,
    { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } }]) {
    const preferences = createReadingPreferences(storage);
    assert.equal(preferences.get(), true);
    assert.equal(preferences.set(false), false);
    assert.equal(preferences.get(), false);
    assert.equal(preferences.set(true), true);
    assert.equal(preferences.get(), true);
  }
});

test('failed writes do not allow stale storage to replace the session choice', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: 'true' });
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  const preferences = createReadingPreferences(storage);
  assert.equal(preferences.get(), true);
  assert.equal(preferences.set(false), false);
  assert.equal(preferences.get(), false);
  assert.equal(preferences.set(true), true);
  assert.equal(preferences.get(), true);
  assert.equal(preferences.set(false), false);
  assert.equal(preferences.get(), false);
  assert.deepEqual(storage.reads, [STORAGE_KEY]);
});

test('a later read failure preserves the most recent successful choice', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: 'false' });
  const preferences = createReadingPreferences(storage);
  assert.equal(preferences.get(), false);
  storage.getItem = () => { throw new Error('Unavailable'); };
  assert.equal(preferences.get(), false);
  assert.equal(preferences.set(true), true);
  assert.equal(preferences.get(), true);
});

test('only a boolean is stored and chart or plugin data is untouched', () => {
  const zoomKey = 'historical-timeline:mobile-chart-zoom:v1';
  const zoom = '{"wall":1.5,"fishbone":2}';
  const pluginData = '{"eventIds":["event-1"]}';
  const storage = fakeStorage({ [zoomKey]: zoom, 'plugin-data': pluginData });
  const preferences = createReadingPreferences(storage);
  assert.equal(preferences.set(false), false);
  assert.equal(preferences.get(), false);
  assert.equal(storage.data.get(zoomKey), zoom);
  assert.equal(storage.data.get('plugin-data'), pluginData);
  assert.deepEqual(storage.writes, [{ key: STORAGE_KEY, value: 'false' }]);
  assert.deepEqual(storage.reads, [STORAGE_KEY]);
});
