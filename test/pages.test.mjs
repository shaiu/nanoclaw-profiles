import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHome, renderProfile, renderMessage } from '../src/web/pages.mjs';

const ok = (data) => ({ ok: true, data });
const profile = {
  agent: { id: 'ag', name: 'Home', folder: 'home' },
  cardProblem: false,
  identity: { name: 'Home <b>', emoji: '🏠', description: 'Runs the house', serves: 'Both parents', voice: 'Warm', hasIcon: false, skills: [{ name: 'Calendar', examples: ['What is on tomorrow?'] }] },
  capabilities: ok({ can: [{ service: 'Calendar', sentences: ['Reads your calendar'] }], cannot: ['Cannot send email'], noAccess: ['Budget'], neverDoes: ['Take sides'], unknownCount: 1, unknown: [] }),
  routines: ok({ timezone: 'Asia/Jerusalem', items: [{ id: 'b', name: 'Morning brief', schedule: 'Every day at 07:00', paused: true, lastRun: 'Last ran today at 07:00', failures: '1 failed run', nextRun: null, lastLog: 'Sent brief' }] }),
  activity: ok({ days: [{ date: '2026-09-15', conversations: 1, messagesIn: 2, messagesOut: 1, routineRuns: 0, routineFailures: 0, services: null }] }),
  memory: ok({ core: '- Kids: Or', files: [{ folder: 'family', title: 'Or', type: 'person', description: 'Older kid' }] }),
  cost: null,
  instructions: null,
};

test('profile renders every section in plain language, escaped', () => {
  const html = renderProfile(profile, { isOwner: false });
  for (const text of ['Home &lt;b&gt;', '🏠', 'Runs the house', 'Both parents', 'What is on tomorrow?', 'Reads your calendar', 'Cannot send email', 'No access to: Budget', 'Take sides', '1 other tool', 'Morning brief', 'Paused', 'Every day at 07:00', '1 failed run', 'Sent brief', 'Asia/Jerusalem', 'Tue 15 Sep', '1 conversation · 3 messages', '<li>Kids: Or</li>', 'Older kid', 'person', 'forget that']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes('Home <b>'));
  assert.ok(!html.includes('Full instructions'));
  assert.ok(!html.includes('Cost'));
});

test('unavailable sections say so', () => {
  const html = renderProfile({ ...profile, routines: { ok: false } }, { isOwner: false });
  assert.ok(html.includes("Couldn't load right now"));
});

test('owner extras', () => {
  const html = renderProfile({
    ...profile,
    cardProblem: true,
    capabilities: ok({ ...profile.capabilities.data, unknown: [{ server: 'odd', tool: null }] }),
    cost: ok({ months: [{ month: '2026-08', amount: 10 }, { month: '2026-09', amount: 12.4 }], currency: { symbol: '₪' }, estimate: true, unpriced: false }),
    instructions: ok('# Persona <x>'),
  }, { isOwner: true });
  for (const text of ['Full instructions', '# Persona &lt;x&gt;', '₪12.40', 'This month', 'estimate', 'Aug', 'agent card has a problem', 'odd']) {
    assert.ok(html.includes(text), text);
  }
});

test('home lists agents with links', () => {
  const html = renderHome({ viewer: { email: 'a@b.c' }, agents: [{ folder: 'home', name: 'Home', emoji: '🏠', description: 'Runs the house', hasIcon: true, lastActive: 'today at 09:00' }] });
  assert.ok(html.includes('href="/agents/home"'));
  assert.ok(html.includes('src="/agents/home/icon"'));
  assert.ok(html.includes('Last active today at 09:00'));
});

test('message page', () => {
  const html = renderMessage({ title: 'No agents yet', message: 'Ask <someone>' });
  assert.ok(html.includes('<!doctype html>') && html.includes('Ask &lt;someone&gt;'));
});
