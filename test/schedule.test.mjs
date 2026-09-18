import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCron, formatWhen, dayKey, humanizeTaskId, describeRoutine } from '../src/present/schedule.mjs';

test('describeCron covers common shapes', () => {
  const cases = {
    '0 7,12,20 * * *': 'Every day at 07:00, 12:00 and 20:00',
    '30 7 * * 1-5': 'Every weekday at 07:30',
    '0 9 * * 1,4': 'Every Monday and Thursday at 09:00',
    '0 9 * * 0,6': 'Every Saturday and Sunday at 09:00',
    '0 9 * * 7': 'Every Sunday at 09:00',
    '0 8 1 * *': 'Monthly on the 1st at 08:00',
    '0 8 2,22 * *': 'Monthly on the 2nd and 22nd at 08:00',
    '*/15 * * * *': 'Every 15 minutes',
    '5 * * * *': 'Every hour at :05',
    '0 */2 * * *': 'Every 2 hours at :00',
  };
  for (const [expr, text] of Object.entries(cases)) assert.equal(describeCron(expr), text, expr);
});

test('describeCron falls back for shapes it does not phrase', () => {
  assert.equal(describeCron('0 9 * 12 *'), 'On a custom schedule (0 9 * 12 *)');
  assert.equal(describeCron('nonsense'), 'On a custom schedule (nonsense)');
  assert.equal(describeCron('0 9 1 * 1'), 'On a custom schedule (0 9 1 * 1)');
});

test('dayKey uses the timezone', () => {
  const d = new Date('2026-09-15T22:30:00Z');
  assert.equal(dayKey(d, 'UTC'), '2026-09-15');
  assert.equal(dayKey(d, 'Asia/Jerusalem'), '2026-09-16');
});

test('formatWhen is relative near today', () => {
  const now = new Date('2026-07-15T09:00:00Z');
  const tz = 'UTC';
  assert.equal(formatWhen('2026-07-15T07:30:00Z', { timezone: tz, now }), 'today at 07:30');
  assert.equal(formatWhen('2026-07-14T20:00:00Z', { timezone: tz, now }), 'yesterday at 20:00');
  assert.equal(formatWhen('2026-07-16T07:00:00Z', { timezone: tz, now }), 'tomorrow at 07:00');
  assert.equal(formatWhen('2026-07-21T18:00:00Z', { timezone: tz, now }), 'on Tue 21 Jul at 18:00');
  assert.equal(formatWhen(null, { timezone: tz, now }), null);
});

test('humanizeTaskId strips the random suffix', () => {
  assert.equal(humanizeTaskId('proactive-brief-dec7'), 'Proactive brief');
  assert.equal(humanizeTaskId('task-1788667289999-rz1e1r'), 'Unnamed routine');
});

test('describeRoutine', () => {
  const now = new Date('2026-07-15T09:00:00Z');
  const r = describeRoutine(
    { series_id: 'morning-brief-ab12', status: 'pending', schedule: '30 7 * * 1-5', runs: 10, failed_runs: 2, last_run: '2026-07-15T07:30:00Z', next_run: '2026-07-16T07:30:00Z', lastLog: 'Sent brief' },
    { timezone: 'UTC', now },
  );
  assert.deepEqual(r, {
    id: 'morning-brief-ab12',
    name: 'Morning brief',
    schedule: 'Every weekday at 07:30',
    paused: false,
    lastRun: 'Last ran today at 07:30',
    failures: '2 failed runs',
    nextRun: 'Next: tomorrow at 07:30',
    lastLog: 'Sent brief',
  });
  const once = describeRoutine(
    { series_id: 'call-dana-0f0f', status: 'paused', schedule: 'once', runs: 0, failed_runs: 0, last_run: null, next_run: '2026-07-21T18:00:00Z', lastLog: null },
    { timezone: 'UTC', now },
  );
  assert.equal(once.schedule, 'Once, on Tue 21 Jul at 18:00');
  assert.equal(once.lastRun, 'Has not run yet');
  assert.equal(once.nextRun, null);
  assert.equal(once.paused, true);
  assert.equal(once.failures, null);
});
