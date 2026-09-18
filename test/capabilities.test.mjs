import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, serversOf, describeCapabilities } from '../src/present/capabilities.mjs';
import { loadCatalogue } from '../src/catalogue.mjs';

const catalogue = [
  { match: 'gmail_search', service: 'Email', sentence: 'Searches and reads your email' },
  { match: 'gmail_get_*', service: 'Email', sentence: 'Searches and reads your email' },
  { match: 'gmail_send', service: 'Email', sentence: 'Sends email for you', cannot: 'Cannot send or reply to email' },
  { match: 'gcal_*', service: 'Calendar', sentence: 'Reads and changes events on your calendar' },
  { match: 'ynab_*', service: 'Budget', sentence: 'Checks your budget' },
  { server: 'notion*', service: 'Notion', sentence: 'Reads and edits your Notion' },
];

test('globToRegExp', () => {
  assert.ok(globToRegExp('gcal_*').test('gcal_list_events'));
  assert.ok(!globToRegExp('gcal_*').test('xgcal_list'));
  assert.ok(globToRegExp('*drive*').test('google-drive'));
  assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'));
});

test('serversOf uses the resolver per server', () => {
  const servers = serversOf({ a: { env: { X: '1' } }, b: {} }, (name) => (name === 'a' ? ['t1'] : null));
  assert.deepEqual(servers, [{ name: 'a', tools: ['t1'] }, { name: 'b', tools: null }]);
});

test('tool-level can, cannot, noAccess and unknown', () => {
  const servers = [
    { name: 'google-mcp', tools: ['gmail_search', 'gmail_get_message', 'gcal_list_events', 'mystery_tool'] },
    { name: 'notion', tools: null },
    { name: 'weird-server', tools: null },
  ];
  const r = describeCapabilities(servers, catalogue, new Set(['Email', 'Calendar', 'Budget', 'Notion']));
  assert.deepEqual(r.can, [
    { service: 'Email', sentences: ['Searches and reads your email'] },
    { service: 'Calendar', sentences: ['Reads and changes events on your calendar'] },
    { service: 'Notion', sentences: ['Reads and edits your Notion'] },
  ]);
  assert.deepEqual(r.cannot, ['Cannot send or reply to email']);
  assert.deepEqual(r.noAccess, ['Budget']);
  assert.deepEqual(r.unknown, [
    { server: 'google-mcp', tool: 'mystery_tool' },
    { server: 'weird-server', tool: null },
  ]);
});

test('a tool list falls back to a server-level entry', () => {
  const r = describeCapabilities([{ name: 'notion', tools: ['notion_query'] }], catalogue);
  assert.deepEqual(r.can, [{ service: 'Notion', sentences: ['Reads and edits your Notion'] }]);
  assert.deepEqual(r.unknown, []);
});

test('first matching entry wins (plugin entries come first)', () => {
  const r = describeCapabilities([{ name: 's', tools: ['gcal_x'] }], [{ match: 'gcal_*', service: 'Family calendar', sentence: 'Custom' }, ...catalogue]);
  assert.deepEqual(r.can, [{ service: 'Family calendar', sentences: ['Custom'] }]);
});

test('loadCatalogue puts plugin entries before built-ins', () => {
  const merged = loadCatalogue([{ name: 'p', capabilities: [{ match: 'x_*', service: 'X', sentence: 'Does X' }] }]);
  assert.equal(merged[0].service, 'X');
  assert.ok(merged.some((e) => e.service === 'Notion'));
});
