import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/cache.mjs';

test('caches within the TTL and recomputes after it', async () => {
  let t = 0;
  let calls = 0;
  const cache = createCache({ ttlMs: 1000, now: () => t });
  const compute = () => ++calls;
  assert.equal(await cache.get('k', compute), 1);
  t = 999;
  assert.equal(await cache.get('k', compute), 1);
  t = 1000;
  assert.equal(await cache.get('k', compute), 2);
});

test('failures are not cached', async () => {
  const cache = createCache();
  await assert.rejects(cache.get('k', () => { throw new Error('boom'); }), /boom/);
  assert.equal(await cache.get('k', () => 'ok'), 'ok');
});
