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

test('direct card wins; otherwise the first plugin alphabetically', () => {
  assert.equal(findCardFile(install.groupsDir, 'direct'), path.join(install.groupsDir, 'direct', 'agent-card.json'));
  assert.equal(readAgentCard(install.groupsDir, 'templated').card.name, 'Alpha');
  assert.equal(readAgentCard(install.groupsDir, 'none'), null);
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

test('invalid card throws CardError', () => {
  fs.writeFileSync(path.join(install.groupsDir, 'none', 'agent-card.json'), '{oops');
  assert.throws(() => readAgentCard(install.groupsDir, 'none'), CardError);
});
