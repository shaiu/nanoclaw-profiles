import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInstall } from './helpers/install.mjs';
import { findCardFile, validateCard, readAgentCard, resolveIconPath, CardError } from '../src/sources/card.mjs';

const install = createInstall();
after(() => install.cleanup());
install.addGroup({ id: 'a', name: 'A', folder: 'direct' }).addGroup({ id: 'b', name: 'B', folder: 'templated' }).addGroup({ id: 'c', name: 'C', folder: 'none' });
install.writeGroupFile('direct', 'agent-card.json', JSON.stringify({ name: 'Direct', iconUrl: 'avatar.png' }));
install.writeGroupFile('direct', 'avatar.png', 'PNG');
install.writeGroupFile('templated', 'plugins/zeta/agent-card.json', JSON.stringify({ name: 'Zeta' }));
install.writeGroupFile('templated', 'plugins/alpha/agent-card.json', JSON.stringify({ name: 'Alpha' }));

test('the first plugin card alphabetically wins; direct card is the fallback', () => {
  assert.equal(findCardFile(install.groupsDir, 'direct'), fs.realpathSync(path.join(install.groupsDir, 'direct', 'agent-card.json')));
  assert.equal(readAgentCard(install.groupsDir, 'templated').card.name, 'Alpha');
  assert.equal(readAgentCard(install.groupsDir, 'none'), null);
});

test('a template card takes precedence over a direct card in the same group', () => {
  install.addGroup({ id: 'd', name: 'D', folder: 'both' });
  install.writeGroupFile('both', 'agent-card.json', JSON.stringify({ name: 'Direct card' }));
  install.writeGroupFile('both', 'plugins/only/agent-card.json', JSON.stringify({ name: 'Template card' }));
  assert.equal(readAgentCard(install.groupsDir, 'both').card.name, 'Template card');
});

test('icon path resolves inside the card folder only', () => {
  const info = readAgentCard(install.groupsDir, 'direct');
  const expectedPath = fs.realpathSync(path.join(install.groupsDir, 'direct', 'avatar.png'));
  assert.equal(resolveIconPath(info), expectedPath);
  assert.equal(resolveIconPath({ ...info, card: { iconUrl: 'missing.png' } }), null);
  assert.equal(resolveIconPath({ ...info, card: { iconUrl: '../templated/x.png' } }), null);
});

test('symlink escape attempts are blocked', () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-outside-'));
  try {
    fs.writeFileSync(path.join(outsideDir, 'secret.png'), 'SECRET');
    const symlinkPath = path.join(install.groupsDir, 'direct', 'assets');
    fs.symlinkSync(outsideDir, symlinkPath);
    const info = readAgentCard(install.groupsDir, 'direct');
    assert.equal(resolveIconPath({ ...info, card: { iconUrl: 'assets/secret.png' } }), null);
  } finally {
    try {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

test('validateCard reports every problem', () => {
  assert.deepEqual(validateCard({ name: 'ok', skills: [{ name: 's', examples: ['q'] }], 'x-profile': { emoji: '🏠', neverDoes: ['x'] } }), []);
  const errors = validateCard({
    name: 1,
    iconUrl: '../x.png',
    skills: [{ examples: Array(6).fill('q') }, { name: 's', examples: ['x'.repeat(121)] }],
    'x-profile': { voice: 3, neverDoes: 'nope' },
  });
  for (const part of ['name must be a string', 'iconUrl must be a relative path', 'skills[0].name', 'more than 5 examples', 'longer than 120', 'x-profile.voice', 'x-profile.neverDoes']) {
    assert.ok(errors.some((e) => e.includes(part)), part);
  }
  assert.deepEqual(validateCard([]), ['card must be a JSON object']);
  assert.ok(validateCard({ iconUrl: 'x.gif' })[0].includes('.png'));
});

test('invalid card throws CardError without leaking the parser message', () => {
  fs.writeFileSync(path.join(install.groupsDir, 'none', 'agent-card.json'), '{oops');
  assert.throws(() => readAgentCard(install.groupsDir, 'none'), CardError);
  try {
    readAgentCard(install.groupsDir, 'none');
    assert.fail('expected CardError');
  } catch (err) {
    assert.equal(err.message, `${fs.realpathSync(path.join(install.groupsDir, 'none', 'agent-card.json'))}: invalid JSON`);
  }
});

test('a card file symlinked to a host file outside the group is not read', () => {
  install.addGroup({ id: 'e', name: 'E', folder: 'attacker' });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-outside-'));
  try {
    fs.writeFileSync(path.join(outsideDir, 'secret.json'), JSON.stringify({ name: 'Leaked' }));
    fs.symlinkSync(path.join(outsideDir, 'secret.json'), path.join(install.groupsDir, 'attacker', 'agent-card.json'));
    assert.equal(findCardFile(install.groupsDir, 'attacker'), null);
    assert.equal(readAgentCard(install.groupsDir, 'attacker'), null);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('a plugin card dir symlinked outside the group is not read', () => {
  install.addGroup({ id: 'f', name: 'F', folder: 'attacker2' });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-outside-'));
  try {
    fs.mkdirSync(path.join(outsideDir, 'plugin'));
    fs.writeFileSync(path.join(outsideDir, 'plugin', 'agent-card.json'), JSON.stringify({ name: 'Leaked' }));
    fs.mkdirSync(path.join(install.groupsDir, 'attacker2', 'plugins'), { recursive: true });
    fs.symlinkSync(path.join(outsideDir, 'plugin'), path.join(install.groupsDir, 'attacker2', 'plugins', 'evil'));
    assert.equal(findCardFile(install.groupsDir, 'attacker2'), null);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
