import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeSlug, pluralize, formatMoney, monthLabel, dayLabel, activityLine } from '../src/present/format.mjs';

test('humanizeSlug', () => {
  assert.equal(humanizeSlug('school-contacts.md'), 'School contacts');
  assert.equal(humanizeSlug('kids_after_school'), 'Kids after school');
  assert.equal(humanizeSlug(''), '');
});

test('pluralize', () => {
  assert.equal(pluralize(1, 'run'), '1 run');
  assert.equal(pluralize(0, 'run'), '0 runs');
});

test('formatMoney', () => {
  assert.equal(formatMoney(12.4, { symbol: '₪' }), '₪12.40');
  assert.equal(formatMoney(1234.5, { symbol: '$' }), '$1,235');
  assert.equal(formatMoney(0, { symbol: '$' }), '$0.00');
});

test('month and day labels', () => {
  assert.equal(monthLabel('2026-09'), 'Sep');
  assert.equal(dayLabel('2026-09-15'), 'Tue 15 Sep');
});

test('activityLine', () => {
  const base = { conversations: 0, messagesIn: 0, messagesOut: 0, routineRuns: 0, routineFailures: 0, services: null };
  assert.equal(activityLine(base), 'Quiet day');
  assert.equal(
    activityLine({ ...base, conversations: 2, messagesIn: 5, messagesOut: 7, routineRuns: 3, routineFailures: 1, services: { Calendar: 3, Notion: 1 } }),
    '2 conversations · 12 messages · 3 routine runs (1 failed) · used Calendar ×3, Notion ×1',
  );
});
