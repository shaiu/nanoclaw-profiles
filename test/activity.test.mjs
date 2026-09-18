import fs from 'node:fs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createInstall } from './helpers/install.mjs';
import { createActivitySource, lastNDays } from '../src/sources/activity.mjs';

const install = createInstall();
after(() => install.cleanup());
install.addGroup({ id: 'ag-1', name: 'A', folder: 'a' });
const now = new Date('2026-09-15T12:00:00Z');

const chat = install.addSession({ id: 's-chat', agentGroupId: 'ag-1', lastActive: '2026-09-15T10:00:00.000Z' });
chat.inbound({ timestamp: '2026-09-15T09:00:00.000Z' }).inbound({ timestamp: '2026-09-15T09:05:00.000Z' }).inbound({ kind: 'chat-sdk', timestamp: '2026-09-14T08:00:00.000Z' })
  .inbound({ timestamp: '2026-09-01T08:00:00.000Z' });
chat.outbound({ timestamp: '2026-09-15T09:01:00.000Z' }).outbound({ kind: 'system', timestamp: '2026-09-15T09:02:00.000Z' });
chat.close();

const tasks = install.addSession({ id: 's-task', agentGroupId: 'ag-1', lastActive: '2026-09-15T04:00:00.000Z' });
tasks.inbound({ kind: 'task', timestamp: '2026-09-10T00:00:00.000Z', status: 'completed', processAfter: '2026-09-15T04:00:00.000Z' })
  .inbound({ kind: 'task', timestamp: '2026-09-10T00:00:00.000Z', status: 'failed', processAfter: '2026-09-14T04:00:00.000Z' })
  .inbound({ kind: 'task', timestamp: '2026-09-10T00:00:00.000Z', status: 'pending', processAfter: '2026-09-16T04:00:00.000Z' });
tasks.close();

install.addSession({ id: 's-old', agentGroupId: 'ag-1', lastActive: '2026-08-01T00:00:00.000Z' }).inbound({ timestamp: '2026-09-15T01:00:00.000Z' }).close();

test('lastNDays', () => {
  assert.deepEqual(lastNDays(3, 'UTC', now), ['2026-09-13', '2026-09-14', '2026-09-15']);
});

test('dailyCounts buckets chat, replies and routine runs; skips stale sessions', () => {
  const src = createActivitySource({ sessionsDir: install.sessionsDir });
  const sessions = [
    { id: 's-chat', lastActive: '2026-09-15T10:00:00.000Z' },
    { id: 's-task', lastActive: '2026-09-15T04:00:00.000Z' },
    { id: 's-old', lastActive: '2026-08-01T00:00:00.000Z' },
    { id: 's-missing', lastActive: '2026-09-15T00:00:00.000Z' },
  ];
  const days = src.dailyCounts('ag-1', sessions, { days: 2, timezone: 'UTC', now });
  assert.deepEqual(days, [
    { date: '2026-09-14', conversations: 1, messagesIn: 1, messagesOut: 0, routineRuns: 1, routineFailures: 1 },
    { date: '2026-09-15', conversations: 1, messagesIn: 2, messagesOut: 1, routineRuns: 1, routineFailures: 0 },
  ]);
});

test('skips sessions with corrupt databases and logs them', () => {
  const corruptDir = `${install.sessionsDir}/ag-1/s-corrupt`;
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(`${corruptDir}/inbound.db`, 'not a database');

  const logs = [];
  const src = createActivitySource({ sessionsDir: install.sessionsDir, log: (msg) => logs.push(msg) });
  const sessions = [
    { id: 's-chat', lastActive: '2026-09-15T10:00:00.000Z' },
    { id: 's-corrupt', lastActive: '2026-09-15T10:00:00.000Z' },
  ];
  const days = src.dailyCounts('ag-1', sessions, { days: 2, timezone: 'UTC', now });

  assert.deepEqual(days, [
    { date: '2026-09-14', conversations: 1, messagesIn: 1, messagesOut: 0, routineRuns: 0, routineFailures: 0 },
    { date: '2026-09-15', conversations: 1, messagesIn: 2, messagesOut: 1, routineRuns: 0, routineFailures: 0 },
  ]);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('s-corrupt'));
});
