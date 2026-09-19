import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { householdInstall } from './helpers/install.mjs';
import { createNanoclawSource } from '../src/sources/nanoclaw.mjs';
import { resolveViewer } from '../src/identity.mjs';

const install = householdInstall();
install.addUser('wa:gadmin').addRole('wa:gadmin', 'admin');
install.addUser('wa:sadmin').addRole('wa:sadmin', 'admin', 'ag-personal');
install.addUser('wa:evalmember').addMember('wa:evalmember', 'ag-eval');
install.close();
const nanoclaw = createNanoclawSource(install.dbPath);
after(() => {
  nanoclaw.close();
  fs.rmSync(install.dir, { recursive: true, force: true });
});

const users = {
  'owner@x.com': 'wa:owner',
  'spouse@x.com': 'wa:spouse',
  'stranger@x.com': 'wa:stranger',
  'gadmin@x.com': 'wa:gadmin',
  'sadmin@x.com': 'wa:sadmin',
  'evalmember@x.com': 'wa:evalmember',
};
const ctx = { users, hiddenGroups: ['eval'], nanoclaw };
const folders = (email) => resolveViewer(email, ctx)?.groups.map((g) => g.folder);
const reachableFolders = (email) => resolveViewer(email, ctx)?.reachable.map((g) => g.folder);

test('owner list excludes hidden groups, but hidden groups stay reachable', () => {
  const v = resolveViewer('OWNER@x.com', ctx);
  assert.equal(v.isOwner, true);
  assert.equal(v.email, 'owner@x.com');
  assert.deepEqual(v.groups.map((g) => g.folder).sort(), ['home', 'personal']);
  assert.deepEqual(v.reachable.map((g) => g.folder).sort(), ['eval', 'home', 'personal']);
});

test('member sees only their groups', () => {
  assert.deepEqual(folders('spouse@x.com'), ['home']);
});

test('member of a hidden group does not see it in their list or reachable set', () => {
  assert.deepEqual(folders('evalmember@x.com'), []);
  assert.deepEqual(reachableFolders('evalmember@x.com'), []);
});

test('non-owner reachable set matches their visible groups', () => {
  assert.deepEqual(reachableFolders('spouse@x.com'), folders('spouse@x.com'));
  assert.deepEqual(reachableFolders('gadmin@x.com').sort(), folders('gadmin@x.com').sort());
});

test('global admin sees everything except hidden groups', () => {
  assert.deepEqual(folders('gadmin@x.com').sort(), ['home', 'personal']);
});

test('scoped admin sees their group', () => {
  assert.deepEqual(folders('sadmin@x.com'), ['personal']);
});

test('known user with no groups sees nothing', () => {
  assert.deepEqual(folders('stranger@x.com'), []);
});

test('unknown email is null', () => {
  assert.equal(resolveViewer('nobody@x.com', ctx), null);
});

test('container config parsing', () => {
  assert.deepEqual(nanoclaw.getContainerConfig('ag-home'), { assistantName: null, timezone: null, mcpServers: {} });
  assert.equal(nanoclaw.getContainerConfig('missing'), null);
});
