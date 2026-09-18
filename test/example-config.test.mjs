import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateConfig } from '../src/config.mjs';

test('config.example.json is valid and contains no real data', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const c = validateConfig(raw, '/etc/nanoclaw-profiles');
  assert.ok(Object.keys(c.users).every((e) => e.endsWith('@example.com')));
  assert.equal(c.access.teamDomain, 'your-team.cloudflareaccess.com');
});
