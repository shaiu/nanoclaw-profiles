export function createCache({ ttlMs = 30_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    async get(key, compute) {
      const hit = entries.get(key);
      if (hit && hit.expires > now()) return hit.value;
      const value = await compute();
      entries.set(key, { value, expires: now() + ttlMs });
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}
