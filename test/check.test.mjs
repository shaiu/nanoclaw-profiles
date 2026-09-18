import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkTemplates, checkInstall, runCheckCli } from '../src/check.mjs';
import { householdInstall } from './helpers/install.mjs';
import { createNanoclawSource } from '../src/sources/nanoclaw.mjs';

const catalogue = [{ match: 'gcal_*', service: 'Calendar', sentence: 'Reads your calendar' }];
const plugins = [{ name: 'allow', resolveTools: (n, cfg) => cfg.env?.ALLOW?.split(',') }];

function templates() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-tpl-'));
  const mk = (name, files) => {
    for (const [rel, content] of Object.entries(files)) {
      const f = path.join(dir, name, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
    }
  };
  mk('good', { 'plugin.json': {}, 'mcp.json': { mcpServers: { g: { env: { ALLOW: 'gcal_list' } } } }, 'agent-card.json': { name: 'Good' } });
  mk('nocard', { 'plugin.json': {}, 'mcp.json': { mcpServers: {} } });
  mk('bad', { 'plugin.json': {}, 'mcp.json': { mcpServers: { g: { env: { ALLOW: 'gcal_list,mystery' } }, raw: {} } }, 'agent-card.json': { skills: 'no' } });
  mk('not-a-template', { 'README.md': 'x' });
  return dir;
}

test('checkTemplates reports card and catalogue problems', () => {
  const r = checkTemplates(templates(), { plugins, catalogue });
  assert.deepEqual(r.warnings, ['nocard: no agent-card.json']);
  assert.ok(r.errors.some((e) => e.startsWith('bad: agent-card.json') && e.includes('skills must be an array')));
  assert.ok(r.errors.includes('bad: no catalogue sentence for g/mystery'));
  assert.ok(r.errors.includes('bad: no catalogue sentence for raw (whole server)'));
  assert.ok(!r.errors.some((e) => e.startsWith('good')));
});

test('checkInstall reads groups from v2.db', () => {
  const install = householdInstall();
  install.writeGroupFile('home', 'agent-card.json', '{bad');
  install.close();
  const nanoclaw = createNanoclawSource(install.dbPath);
  const r = checkInstall({ config: { groupsDir: install.groupsDir }, plugins, catalogue, nanoclaw });
  assert.ok(r.errors.some((e) => e.startsWith('home:') && e.includes('invalid JSON')));
  assert.ok(r.warnings.includes('ausie: no agent-card.json'));
  nanoclaw.close();
  fs.rmSync(install.dir, { recursive: true, force: true });
});

test('runCheckCli exit codes', async () => {
  const dir = templates();
  const pluginFile = path.join(dir, 'allow.mjs');
  fs.writeFileSync(pluginFile, "export default { name: 'allow', capabilities: [{ match: 'gcal_*', service: 'Calendar', sentence: 'x' }], resolveTools: (n, c) => c.env?.ALLOW?.split(',') };");
  assert.equal(await runCheckCli({ templates: dir, plugin: [pluginFile] }), 1);
  fs.rmSync(path.join(dir, 'bad'), { recursive: true });
  assert.equal(await runCheckCli({ templates: dir, plugin: [pluginFile] }), 0);
  assert.equal(await runCheckCli({}), 2);
});
