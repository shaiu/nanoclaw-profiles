import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, loadConfig, ConfigError, isValidTimezone } from '../src/config.mjs';

const minimal = {
  nanoclawDir: '/srv/nanoclaw',
  access: { teamDomain: 'team.cloudflareaccess.com', aud: 'aud-tag' },
  users: { 'Person@Example.com': 'whatsapp:1' },
};

test('minimal config gets defaults and derived paths', () => {
  const c = validateConfig(minimal, '/etc/profiles');
  assert.equal(c.port, 3200);
  assert.equal(c.dbPath, '/srv/nanoclaw/data/v2.db');
  assert.equal(c.sessionsDir, '/srv/nanoclaw/data/v2-sessions');
  assert.equal(c.groupsDir, '/srv/nanoclaw/groups');
  assert.equal(c.ncl, '/srv/nanoclaw/bin/ncl');
  assert.equal(c.timezone, 'UTC');
  assert.deepEqual(c.users, { 'person@example.com': 'whatsapp:1' });
  assert.deepEqual(c.currency, { code: 'USD', symbol: '$', rate: 1 });
  assert.equal(c.showCostToMembers, false);
  assert.deepEqual(c.hiddenGroups, []);
  assert.deepEqual(c.plugins, []);
});

test('relative paths resolve against the config directory', () => {
  const c = validateConfig({ ...minimal, nanoclawDir: '../nc', plugins: ['./p.mjs'] }, '/etc/profiles');
  assert.equal(c.nanoclawDir, '/etc/nc');
  assert.deepEqual(c.plugins, ['/etc/profiles/p.mjs']);
});

test('teamDomain is normalised', () => {
  const c = validateConfig({ ...minimal, access: { teamDomain: 'https://team.cloudflareaccess.com/', aud: 'a' } }, '/');
  assert.equal(c.access.teamDomain, 'team.cloudflareaccess.com');
});

test('all problems are reported together', () => {
  assert.throws(() => validateConfig({ users: { 'not-an-email': 'x' }, timezone: 'Mars/Base', port: 0 }, '/'), (err) => {
    assert.ok(err instanceof ConfigError);
    for (const part of ['nanoclawDir', 'access.teamDomain', 'access.aud', 'not-an-email', 'Mars/Base', 'port']) {
      assert.match(err.message, new RegExp(part.replace('.', '\\.')));
    }
    return true;
  });
});

test('prices must have numeric input and output', () => {
  assert.throws(() => validateConfig({ ...minimal, prices: { m: { input: 1 } } }, '/'), /prices\.m\.output/);
});

test('loadConfig reads a file and reports unreadable files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(minimal));
  assert.equal(loadConfig(file).port, 3200);
  assert.throws(() => loadConfig(path.join(dir, 'missing.json')), ConfigError);
});

test('isValidTimezone', () => {
  assert.equal(isValidTimezone('Asia/Jerusalem'), true);
  assert.equal(isValidTimezone('Nope/Nope'), false);
});
