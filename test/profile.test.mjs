import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createInstall } from './helpers/install.mjs';
import { createNanoclawSource } from '../src/sources/nanoclaw.mjs';
import { readAgentCard } from '../src/sources/card.mjs';
import { readMemory } from '../src/sources/memory.mjs';
import { createActivitySource } from '../src/sources/activity.mjs';
import { createUsageSource } from '../src/sources/usage.mjs';
import { buildProfile, buildSummary, computeInstallServices } from '../src/profile.mjs';

const install = createInstall();
install
  .addGroup({ id: 'ag-home', name: 'Home', folder: 'home', timezone: 'Asia/Jerusalem', mcpServers: { 'google-mcp': { command: 'node', env: { ALLOW: 'gcal_list,gmail_search', SECRET: 'SECRET_VALUE_123' } }, 'odd-server': {} } })
  .addGroup({ id: 'ag-ausie', name: 'Ausie', folder: 'ausie', mcpServers: { budget: { env: { ALLOW: 'ynab_get' } } } });
install.addSession({ id: 's1', agentGroupId: 'ag-home', lastActive: '2026-09-15T09:00:00.000Z' }).inbound({ timestamp: '2026-09-15T09:00:00.000Z' }).close();
install.writeGroupFile('home', 'agent-card.json', JSON.stringify({ name: 'Home', description: 'Runs the house', 'x-profile': { emoji: '🏠', neverDoes: ['Take sides'] }, skills: [{ name: 'Calendar', examples: ['What is on tomorrow?'] }] }));
install.writeGroupFile('home', 'instructions.prepend.md', '# Home persona');
install.writeGroupFile('ausie', 'agent-card.json', '{broken');
install.close();

const now = new Date('2026-09-15T12:00:00Z');
const config = { timezone: 'UTC', groupsDir: install.groupsDir, prices: {}, currency: { code: 'USD', symbol: '$', rate: 1 }, showCostToMembers: false };
const nanoclaw = createNanoclawSource(install.dbPath);
after(() => {
  nanoclaw.close();
  fs.rmSync(install.dir, { recursive: true, force: true });
});
const sources = {
  nanoclaw,
  card: (f) => readAgentCard(install.groupsDir, f),
  memory: (f) => readMemory(install.groupsDir, f),
  tasks: { listForGroup: async () => [{ series_id: 'brief-ab12', status: 'pending', schedule: '0 7 * * *', runs: 1, failed_runs: 0, last_run: null, next_run: '2026-09-16T04:00:00.000Z', lastLog: null }] },
  activity: createActivitySource({ sessionsDir: install.sessionsDir }),
  usage: createUsageSource({ sessionsDir: install.sessionsDir }),
};
const plugins = [{ name: 'allow', resolveTools: (n, cfg) => cfg.env?.ALLOW?.split(',') ?? undefined, activity: async (a, { days }) => ({ byDay: [{ date: days.at(-1), services: { Calendar: 2 } }] }) }];
const catalogue = [
  { match: 'gcal_*', service: 'Calendar', sentence: 'Reads your calendar' },
  { match: 'gmail_search', service: 'Email', sentence: 'Searches your email' },
  { match: 'gmail_send', service: 'Email', sentence: 'Sends email', cannot: 'Cannot send email' },
  { match: 'ynab_*', service: 'Budget', sentence: 'Checks your budget' },
];
const logs = [];
const base = { config, sources, plugins, catalogue, now, log: (m) => logs.push(m) };
const home = { id: 'ag-home', name: 'Home', folder: 'home' };

test('install services span every agent', () => {
  assert.deepEqual([...computeInstallServices(base)].sort(), ['Budget', 'Calendar', 'Email']);
});

test('member profile', async () => {
  const p = await buildProfile(home, { ...base, viewer: { isOwner: false }, installServices: computeInstallServices(base) });
  assert.equal(p.identity.name, 'Home');
  assert.equal(p.identity.emoji, '🏠');
  assert.deepEqual(p.capabilities.data.can.map((c) => c.service), ['Calendar', 'Email']);
  assert.deepEqual(p.capabilities.data.cannot, ['Cannot send email']);
  assert.deepEqual(p.capabilities.data.noAccess, ['Budget']);
  assert.deepEqual(p.capabilities.data.neverDoes, ['Take sides']);
  assert.equal(p.capabilities.data.unknownCount, 1);
  assert.deepEqual(p.capabilities.data.unknown, []);
  assert.equal(p.routines.data.timezone, 'Asia/Jerusalem');
  assert.equal(p.routines.data.items[0].schedule, 'Every day at 07:00');
  assert.equal(p.activity.data.days.length, 7);
  assert.deepEqual(p.activity.data.days[0].services, { Calendar: 2 });
  assert.equal(p.activity.data.days[0].messagesIn, 1);
  assert.equal(p.cost, null);
  assert.equal(p.instructions, null);
  assert.equal(p.cardProblem, false);
  assert.ok(!JSON.stringify(p).includes('SECRET_VALUE_123'));
});

test('owner profile adds cost, instructions and unknown names', async () => {
  const p = await buildProfile(home, { ...base, viewer: { isOwner: true }, installServices: new Set() });
  assert.equal(p.cost.ok, true);
  assert.equal(p.cost.data.months.length, 6);
  assert.equal(p.instructions.data, '# Home persona');
  assert.deepEqual(p.capabilities.data.unknown, [{ server: 'odd-server', tool: null }]);
});

test('a broken card still renders a profile with a fallback name', async () => {
  const p = await buildProfile({ id: 'ag-ausie', name: 'Ausie', folder: 'ausie' }, { ...base, viewer: { isOwner: true }, installServices: new Set() });
  assert.equal(p.identity.name, 'Ausie');
  assert.equal(p.cardProblem, true);
  assert.equal(p.capabilities.ok, true);
});

test('a failing source only fails its own section', async () => {
  const broken = { ...sources, tasks: { listForGroup: async () => { throw new Error('ncl down'); } } };
  const p = await buildProfile(home, { ...base, sources: broken, viewer: { isOwner: false }, installServices: new Set() });
  assert.deepEqual(p.routines, { ok: false });
  assert.equal(p.memory.ok, true);
  assert.ok(logs.some((l) => l.includes('ncl down')));
});

test('plugin cost replaces the estimate', async () => {
  const withCost = [...plugins, { name: 'ledger', cost: async (a, { months }) => ({ byMonth: [{ month: months.at(-1), usd: 2 }] }) }];
  const p = await buildProfile(home, { ...base, plugins: withCost, config: { ...config, currency: { code: 'ILS', symbol: '₪', rate: 4 } }, viewer: { isOwner: true }, installServices: new Set() });
  assert.equal(p.cost.data.estimate, false);
  assert.equal(p.cost.data.months.at(-1).amount, 8);
});

test('summary', async () => {
  const s = await buildSummary(home, { ...base, viewer: { isOwner: false } });
  assert.deepEqual(s, { folder: 'home', name: 'Home', emoji: '🏠', description: 'Runs the house', hasIcon: false, lastActive: 'today at 12:00' });
});
