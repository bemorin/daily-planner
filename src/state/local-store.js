export function createLocalStore(storage = window.localStorage) {
  const safe = (fallback, fn) => {
    try { return fn(); } catch (_) { return fallback; }
  };

  const get = key => safe(null, () => storage.getItem(key));
  const set = (key, value) => safe(false, () => { storage.setItem(key, value); return true; });
  const remove = key => safe(false, () => { storage.removeItem(key); return true; });
  const readJSON = (key, fallback = null) => {
    const raw = get(key);
    if (raw == null) return fallback;
    return safe(fallback, () => JSON.parse(raw));
  };
  const writeJSON = (key, value) => set(key, JSON.stringify(value));
  const keys = (prefix = '') => safe([], () => {
    const result = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith(prefix)) result.push(key);
    }
    return result;
  });
  const removePrefix = prefix => {
    const matches = keys(prefix);
    matches.forEach(remove);
    return matches.length;
  };
  const canWrite = (prefix = 'daily-planner:') => safe(false, () => {
    const key = `${prefix}storage-probe-${Date.now()}`;
    storage.setItem(key, '1');
    storage.removeItem(key);
    return true;
  });

  return { get, set, remove, readJSON, writeJSON, keys, removePrefix, canWrite };
}
