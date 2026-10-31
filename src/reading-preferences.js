'use strict';

const STORAGE_KEY = 'historical-timeline:mobile-reading:v1';

function readPreference(raw) {
  if (typeof raw !== 'string') return true;
  try {
    const value = JSON.parse(raw);
    return typeof value === 'boolean' ? value : true;
  } catch (_) {
    return true;
  }
}

// Supplied only by the mobile host. This device preference never contains
// event data and is independent of the plugin's synced settings.
function createReadingPreferences(storage) {
  let readOnly = true;
  let available = storage != null;

  function refresh() {
    if (!available) return;
    try {
      readOnly = readPreference(storage.getItem(STORAGE_KEY));
    } catch (_) {
      available = false;
    }
  }

  function get() {
    refresh();
    return readOnly;
  }

  function set(value) {
    if (typeof value !== 'boolean') return get();
    readOnly = value;
    if (available) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(readOnly));
      } catch (_) {
        // Keep the user's session choice when storage is blocked or full;
        // a later read must not replace it with the stale saved value.
        available = false;
      }
    }
    return readOnly;
  }

  return { get, set };
}

module.exports = { createReadingPreferences };
