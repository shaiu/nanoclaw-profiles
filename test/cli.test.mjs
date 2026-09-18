import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

test('serve reports the db path when the NanoClaw database cannot be opened', () => {
  const nanoclawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-cli-'));
  // No data/v2.db written: the install has never been initialised.
  const configPath = path.join(nanoclawDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    nanoclawDir,
    access: { teamDomain: 'team.cloudflareaccess.com', aud: 'aud-tag' },
    users: { 'owner@example.com': 'whatsapp:1' },
  }));
  after(() => fs.rmSync(nanoclawDir, { recursive: true, force: true }));

  const dbPath = path.join(nanoclawDir, 'data', 'v2.db');
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'serve', '--config', configPath], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(dbPath), `expected stderr to mention ${dbPath}, got: ${result.stderr}`);
});
