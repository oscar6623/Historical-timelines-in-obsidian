'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChartPreferences } = require('../src/chart-preferences');

const STORAGE_KEY = 'historical-timeline:mobile-chart-zoom:v1';

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

test('zoom preferences persist across instances and separate chart kinds', () => {
  const storage = fakeStorage();
  const first = createChartPreferences(storage);
  assert.equal(first.get('wall'), 1);
  assert.equal(first.get('fishbone'), 1);
  assert.equal(first.set('wall', 0.5), 0.5);
  assert.equal(first.set('fishbone', 2.5), 2.5);

  const reopened = createChartPreferences(storage);
  assert.equal(reopened.get('wall'), 0.5);
  assert.equal(reopened.get('fishbone'), 2.5);
});

test('existing instances refresh and preserve the other chart preference on write', () => {
  const storage = fakeStorage();
  const first = createChartPreferences(storage);
  const second = createChartPreferences(storage);
  first.set('wall', 1.5);
  assert.equal(second.get('wall'), 1.5);
  second.set('fishbone', 0.75);
  assert.equal(first.get('fishbone'), 0.75);
  first.set('wall', 2);
  assert.deepEqual(JSON.parse(storage.data.get(STORAGE_KEY)), { wall: 2, fishbone: 0.75 });

  storage.data.delete(STORAGE_KEY);
  assert.equal(first.get('wall'), 1);
  assert.equal(second.get('fishbone'), 1);
});

test('invalid kinds never read or write storage', () => {
  const storage = fakeStorage();
  const preferences = createChartPreferences(storage);
  for (const kind of ['timeline', '__proto__', 'constructor', '', null, undefined, {}, Symbol('kind')]) {
    assert.equal(preferences.get(kind), 1);
    assert.equal(preferences.set(kind, 2), 1);
  }
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test('invalid zoom values are ignored without coercion or persistence', () => {
  const storage = fakeStorage();
  const preferences = createChartPreferences(storage);
  preferences.set('wall', 1.25);
  let coerced = false;
  const invalid = [0, -1, 0.499, 2.501, NaN, Infinity, -Infinity, '1.5', true, null, undefined, [], {},
    Symbol('scale'), 1n, { valueOf() { coerced = true; return 2; } }];
  for (const scale of invalid) {
    assert.equal(preferences.set('wall', scale), 1.25);
    assert.equal(preferences.get('wall'), 1.25);
  }
  assert.equal(coerced, false);
  assert.equal(storage.writes.length, 1);
});

test('malformed stored data safely defaults and validates each kind independently', () => {
  const invalid = [null, '', '{', 'null', 'true', '2', '[]', '[1,2]', '{}',
    '{"wall":"2","fishbone":false}', '{"wall":0.49,"fishbone":2.51}',
    '{"wall":1e999,"fishbone":-1e999}', '{"__proto__":{"wall":2}}'];
  for (const raw of invalid) {
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const preferences = createChartPreferences(storage);
    assert.equal(preferences.get('wall'), 1);
    assert.equal(preferences.get('fishbone'), 1);
    assert.deepEqual(storage.writes, []);
  }
  const storage = fakeStorage({ [STORAGE_KEY]: '{"wall":1.75,"fishbone":"2"}' });
  const preferences = createChartPreferences(storage);
  assert.equal(preferences.get('wall'), 1.75);
  assert.equal(preferences.get('fishbone'), 1);
  storage.data.set(STORAGE_KEY, '{"wall":false,"fishbone":0.8}');
  assert.equal(preferences.get('wall'), 1);
  assert.equal(preferences.get('fishbone'), 0.8);
});

test('unavailable or throwing storage preserves usable in-memory preferences', () => {
  const throwingProperty = {};
  Object.defineProperty(throwingProperty, 'getItem', { get() { throw new Error('Unavailable'); } });
  for (const storage of [null, undefined, {}, throwingProperty,
    { getItem() { throw new Error('Privacy mode'); }, setItem() { throw new Error('Privacy mode'); } }]) {
    const preferences = createChartPreferences(storage);
    assert.equal(preferences.get('wall'), 1);
    assert.equal(preferences.set('wall', 2), 2);
    assert.equal(preferences.set('fishbone', 0.7), 0.7);
    assert.equal(preferences.get('wall'), 2);
    assert.equal(preferences.get('fishbone'), 0.7);
  }
});

test('failed writes retain the new zoom and the other stored chart zoom', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: '{"wall":1.5,"fishbone":0.8}' });
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  const preferences = createChartPreferences(storage);
  assert.equal(preferences.set('wall', 2), 2);
  assert.equal(preferences.get('wall'), 2);
  assert.equal(preferences.get('fishbone'), 0.8);
  preferences.set('fishbone', 1.2);
  assert.equal(preferences.get('fishbone'), 1.2);
});

test('a later read failure retains the last successfully read preferences', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: '{"wall":1.5,"fishbone":0.8}' });
  const preferences = createChartPreferences(storage);
  assert.equal(preferences.get('wall'), 1.5);
  storage.getItem = () => { throw new Error('Unavailable'); };
  assert.equal(preferences.get('fishbone'), 0.8);
  preferences.set('wall', 2.1);
  assert.equal(preferences.get('wall'), 2.1);
});

test('only the two scalar zooms are stored and unrelated storage keys remain untouched', () => {
  const unrelated = '{"theme":"dark"}';
  const storage = fakeStorage({
    'another-plugin': unrelated,
    [STORAGE_KEY]: '{"wall":1.4,"fishbone":0.6,"eventIds":["event-1"],"notes":"private","vaultPath":"/vault"}',
  });
  const preferences = createChartPreferences(storage);
  preferences.set('wall', 2.2);
  assert.deepEqual(JSON.parse(storage.data.get(STORAGE_KEY)), { wall: 2.2, fishbone: 0.6 });
  assert.equal(storage.data.get('another-plugin'), unrelated);
  assert.deepEqual(storage.reads, [STORAGE_KEY]);
  assert.deepEqual(storage.writes, [{ key: STORAGE_KEY, value: '{"wall":2.2,"fishbone":0.6}' }]);
});
