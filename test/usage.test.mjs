import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createInstall } from './helpers/install.mjs';
import { createUsageSource, priceFor, costUsd, lastNMonths } from '../src/sources/usage.mjs';

const install = createInstall();
after(() => install.cleanup());
const now = new Date('2026-09-15T12:00:00Z');
const prices = { 'claude-haiku-4-5': { input: 1, output: 5 }, 'claude-opus-5': { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 } };
const currency = { code: 'ILS', symbol: '₪', rate: 4 };

const assistant = (id, model, timestamp, usage) => ({ type: 'assistant', timestamp, message: { id, model, usage, content: [{ type: 'text', text: 'PRIVATE' }] } });

install.writeTranscript('ag-1', '-workspace-agent/a.jsonl', [
  { type: 'user', timestamp: '2026-09-01T00:00:00Z', message: { content: 'hi' } },
  assistant('m1', 'claude-haiku-4-5-20251001', '2026-09-02T10:00:00Z', { input_tokens: 100000, output_tokens: 10 }),
  assistant('m1', 'claude-haiku-4-5-20251001', '2026-09-02T10:00:01Z', { input_tokens: 1000000, output_tokens: 100000 }),
  assistant('m2', 'claude-opus-5', '2026-08-20T10:00:00Z', {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 2000000,
    cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 },
  }),
  assistant('m3', 'mystery-model', '2026-09-03T10:00:00Z', { input_tokens: 5, output_tokens: 5 }),
  assistant('m4', 'claude-haiku-4-5', '2025-01-01T00:00:00Z', { input_tokens: 999999999, output_tokens: 0 }),
]);
install.writeTranscript('ag-1', '-workspace-agent/sub/agent-1.jsonl', [
  assistant('m5', 'claude-haiku-4-5', '2026-09-04T10:00:00Z', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000000 }),
]);

test('priceFor matches exact or longest prefix', () => {
  assert.equal(priceFor('claude-haiku-4-5-20251001', prices).input, 1);
  assert.equal(priceFor('other', prices), null);
});

test('costUsd defaults cache prices from input', () => {
  assert.equal(costUsd({ model: 'claude-haiku-4-5', input: 0, output: 0, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }, prices), 0.1 + 1.25 + 2);
});

test('lastNMonths crosses year boundaries', () => {
  assert.deepEqual(lastNMonths(3, 'UTC', new Date('2026-02-10T00:00:00Z')), ['2025-12', '2026-01', '2026-02']);
});

test('monthlyCost dedupes by message id (last line wins) and flags unpriced models', () => {
  const src = createUsageSource({ sessionsDir: install.sessionsDir });
  const r = src.monthlyCost('ag-1', { months: 2, timezone: 'UTC', now, prices, currency });
  // Sep: m1 final = 1M in * $1 + 100k out * $5 = $1.5 ; m5 = 1M cache write 5m * 1.25 = $1.25  → $2.75 * 4
  // Aug: m2 = 1M read * $1 + 1M 5m * $12.5 + 1M 1h * $20 = $33.5 * 4
  assert.deepEqual(r.months, [{ month: '2026-08', amount: 134 }, { month: '2026-09', amount: 11 }]);
  assert.equal(r.estimate, true);
  assert.equal(r.unpriced, true);
  assert.deepEqual(r.currency, currency);
});

test('unchanged files are served from cache', () => {
  const src = createUsageSource({ sessionsDir: install.sessionsDir });
  src.monthlyCost('ag-1', { months: 1, timezone: 'UTC', now, prices, currency });
  const first = src._parsedCount();
  src.monthlyCost('ag-1', { months: 1, timezone: 'UTC', now, prices, currency });
  assert.equal(src._parsedCount(), first);
});

test('agent with no transcripts costs zero', () => {
  const src = createUsageSource({ sessionsDir: install.sessionsDir });
  assert.deepEqual(src.monthlyCost('ag-none', { months: 1, timezone: 'UTC', now, prices, currency }).months, [{ month: '2026-09', amount: 0 }]);
});
