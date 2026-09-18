import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlugins, resolveToolsVia, callHook } from '../src/plugins.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-plugins-'));
const write = (name, src) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, src);
  return file;
};

test('loadPlugins imports default exports and validates them', async () => {
  const good = write('good.mjs', "export default { name: 'good', capabilities: [] };");
  const bad = write('bad.mjs', 'export default 42;');
  assert.equal((await loadPlugins([good]))[0].name, 'good');
  await assert.rejects(loadPlugins([bad]), /must default-export/);
});

test('resolveToolsVia: first array wins, throwing hooks are skipped', () => {
  const logs = [];
  const plugins = [
    { name: 'thrower', resolveTools() { throw new Error('boom'); } },
    { name: 'none', resolveTools() { return undefined; } },
    { name: 'allow', resolveTools: (name, cfg) => cfg.env.ALLOW.split(',') },
  ];
  assert.deepEqual(resolveToolsVia(plugins, 's', { env: { ALLOW: 'a,b' } }, (m) => logs.push(m)), ['a', 'b']);
  assert.match(logs[0], /thrower resolveTools failed: boom/);
  assert.equal(resolveToolsVia([], 's', {}), null);
});

test('callHook: first non-null result, timeouts and throws fall through', async () => {
  const logs = [];
  const plugins = [
    { name: 'slow', cost: () => new Promise(() => {}) },
    { name: 'thrower', async cost() { throw new Error('nope'); } },
    { name: 'null', cost: () => null },
    { name: 'real', cost: (agent, opts) => ({ byMonth: [{ month: opts.months[0], usd: 1 }] }) },
  ];
  const r = await callHook(plugins, 'cost', [{ id: 'a' }, { months: ['2026-09'] }], { timeoutMs: 20, log: (m) => logs.push(m) });
  assert.deepEqual(r, { byMonth: [{ month: '2026-09', usd: 1 }] });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /slow cost failed: timed out/);
  assert.equal(await callHook([], 'cost', []), undefined);
});
