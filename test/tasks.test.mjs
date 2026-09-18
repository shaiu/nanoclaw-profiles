import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createInstall } from './helpers/install.mjs';
import { createTaskSource, lastLogLine } from '../src/sources/tasks.mjs';

const install = createInstall();
after(() => install.cleanup());
install.addGroup({ id: 'ag-1', name: 'A', folder: 'a' });
install.writeGroupFile('a', 'tasks/brief-ab12.md', '- 2026-09-01 sent brief\n- 2026-09-02 sent brief with 3 events\n\n');

const row = {
  series_id: 'brief-ab12', status: 'pending', schedule: '0 7 * * *', runs: 4, failed_runs: 1,
  last_run: '2026-09-02T04:00:00.000Z', next_run: '2026-09-03T04:00:00.000Z', log: 'tasks/brief-ab12.md',
  prompt: 'SECRET PROMPT',
};

function fakeExec(frame, seen = []) {
  return (file, args, opts, cb) => {
    seen.push({ file, args });
    cb(null, JSON.stringify(frame), '');
  };
}

test('lists tasks via ncl --json and drops prompts', async () => {
  const seen = [];
  const src = createTaskSource({ ncl: '/x/ncl', groupsDir: install.groupsDir, execFileImpl: fakeExec({ id: '1', ok: true, data: [row] }, seen) });
  const rows = await src.listForGroup('ag-1', 'a');
  assert.deepEqual(seen, [{ file: '/x/ncl', args: ['tasks', 'list', '--group', 'ag-1', '--json'] }]);
  assert.deepEqual(rows, [{
    series_id: 'brief-ab12', status: 'pending', schedule: '0 7 * * *', runs: 4, failed_runs: 1,
    last_run: '2026-09-02T04:00:00.000Z', next_run: '2026-09-03T04:00:00.000Z', lastLog: '2026-09-02 sent brief with 3 events',
  }]);
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
});

test('ncl error frame rejects', async () => {
  const src = createTaskSource({ ncl: 'ncl', groupsDir: install.groupsDir, execFileImpl: fakeExec({ ok: false, error: { code: 'x', message: 'no such group' } }) });
  await assert.rejects(src.listForGroup('ag-1', 'a'), /no such group/);
});

test('process failure without output rejects', async () => {
  const src = createTaskSource({ ncl: 'ncl', groupsDir: install.groupsDir, execFileImpl: (f, a, o, cb) => cb(new Error('ENOENT'), '', '') });
  await assert.rejects(src.listForGroup('ag-1', 'a'), /ENOENT/);
});

test('lastLogLine stays inside the group folder and truncates', () => {
  assert.equal(lastLogLine(install.groupsDir, 'a', '../../etc/passwd'), null);
  assert.equal(lastLogLine(install.groupsDir, 'a', 'tasks/missing.md'), null);
  install.writeGroupFile('a', 'tasks/long.md', `- ${'x'.repeat(200)}`);
  assert.equal(lastLogLine(install.groupsDir, 'a', 'tasks/long.md').length, 138);
});
