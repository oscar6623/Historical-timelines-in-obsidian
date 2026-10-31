'use strict';

const STORAGE_KEY = 'historical-timeline:mobile-chart-zoom:v1';

function isKind(kind) {
  return kind === 'wall' || kind === 'fishbone';
}

function isScale(scale) {
  return typeof scale === 'number' && Number.isFinite(scale) && scale >= 0.5 && scale <= 2.5;
}

function readScales(raw) {
  const scales = { wall: 1, fishbone: 1 };
  if (typeof raw !== 'string') return scales;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return scales;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return scales;
  for (const kind of ['wall', 'fishbone']) {
    if (Object.prototype.hasOwnProperty.call(data, kind) && isScale(data[kind])) {
      scales[kind] = data[kind];
    }
  }
  return scales;
}

// The renderer supplies window.localStorage only for mobile chart views. No
// plugin data or note identifiers enter this device-local preference store.
function createChartPreferences(storage) {
  let memory = { wall: 1, fishbone: 1 };
  let available = storage != null;

  function refresh() {
    if (!available) return;
    try {
      memory = readScales(storage.getItem(STORAGE_KEY));
    } catch (_) {
      available = false;
    }
  }

  function get(kind) {
    if (!isKind(kind)) return 1;
    refresh();
    return memory[kind];
  }

  function set(kind, scale) {
    if (!isKind(kind)) return 1;
    if (!isScale(scale)) return get(kind);
    refresh();
    memory[kind] = scale;
    if (available) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(memory));
      } catch (_) {
        // Keep subsequent reads from replacing an unsaved local preference
        // with stale storage after quota, privacy, or availability failures.
        available = false;
      }
    }
    return memory[kind];
  }

  return { get, set };
}

module.exports = { createChartPreferences };
