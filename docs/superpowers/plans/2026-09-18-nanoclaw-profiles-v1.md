# nanoclaw-profiles v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only web app that shows each person the NanoClaw agents they belong to as friendly profile pages covering identity, can/can't do, routines, activity, memory and cost.

**Architecture:** A dependency-free Node ESM service that renders HTML on the server. It reads NanoClaw's `v2.db` read-only, the group folders, `ncl tasks --json` and the Claude transcripts. It sits behind Cloudflare Access and verifies the Access JWT on every request. Install-specific behaviour enters only through config and plugin modules.

**Tech Stack:** Node ≥ 22.13 (`node:sqlite`, `node:http`, `node:crypto`, `node:test`), plain `.mjs`, and no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-18-agent-profiles-dashboard-design.md`. Read it before starting any task.

## Global Constraints

- Node `>=22.13`. **Zero** runtime or dev dependencies: built-ins only (`node:sqlite`, `node:http`, `node:crypto`, `node:test`, `node:assert/strict`, `node:util`, `node:child_process`).
- ESM only (`"type": "module"`), `.mjs` files, 2-space indent, single quotes, semicolons.
- **Read-only everywhere:** SQLite is opened with `{ readOnly: true }`. Nothing ever writes to the NanoClaw dir.
- **Never render:** `mcp_servers` env values, message contents, task prompts, or tool arguments.
- All user-visible copy is English and plain language, with no jargon (no "MCP", "session", "token" on member-facing pages).
- The server binds to `127.0.0.1` only.
- Tests: `npm test`, which runs `node --disable-warning=ExperimentalWarning --test "test/**/*.test.mjs"`. Tests never touch a real install; they build fixtures in `os.tmpdir()`.
- Every commit message ends with the trailer:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Work in the worktree `.worktrees/v1` on branch `v1` (created in Task 1). Never commit to `main`.

## File Structure

```
package.json, LICENSE, README.md, config.example.json, .gitignore
catalogue/capabilities.json          generic server-level capability sentences
deploy/nanoclaw-profiles.service.example
src/escape.mjs                        esc()
src/config.mjs                        loadConfig / validateConfig / isValidTimezone
src/cache.mjs                         createCache (TTL memo)
src/db.mjs                            openReadOnly
src/auth.mjs                          createAccessVerifier, AuthError
src/identity.mjs                      resolveViewer
src/catalogue.mjs                     loadCatalogue
src/plugins.mjs                       loadPlugins, resolveToolsVia, callHook
src/present/format.mjs                humanizeSlug, pluralize, formatMoney, activityLine, monthLabel
src/present/schedule.mjs              describeCron, formatWhen, dayKey, humanizeTaskId, describeRoutine
src/present/capabilities.mjs          globToRegExp, serversOf, describeCapabilities
src/present/markdown.mjs              renderMarkdown
src/sources/nanoclaw.mjs              createNanoclawSource
src/sources/card.mjs                  findCardFile, validateCard, readAgentCard, resolveIconPath, CardError
src/sources/memory.mjs                extractCoreMemory, parseFrontmatter, readMemory
src/sources/tasks.mjs                 createTaskSource, lastLogLine
src/sources/activity.mjs              lastNDays, createActivitySource
src/sources/usage.mjs                 createUsageSource, priceFor, costUsd, lastNMonths
src/sources/index.mjs                 createSources(config)
src/profile.mjs                       buildProfile, buildSummary, computeInstallServices
src/web/layout.mjs                    page(), CSS
src/web/pages.mjs                     renderHome, renderProfile, renderMessage
src/server.mjs                        createApp
src/check.mjs                         runCheck
src/cli.mjs                           serve | check
test/helpers/install.mjs              fixture NanoClaw install builder
test/helpers/jwt.mjs                  test RSA keys + JWT signing + fake fetch
test/*.test.mjs
```

---

### Task 1: Scaffold, config, cache

**Files:**
- Create: `package.json`, `LICENSE`, `.gitignore` (update), `src/escape.mjs`, `src/config.mjs`, `src/cache.mjs`
- Test: `test/config.test.mjs`, `test/cache.test.mjs`

**Interfaces:**
- Produces:
  - `esc(value) → string`: HTML-escapes `& < > " '`.
  - `validateConfig(raw, baseDir) → Config` (throws `ConfigError`) and `loadConfig(file) → Config`.
  - `Config = { port, nanoclawDir, dbPath, sessionsDir, groupsDir, ncl, timezone, access:{teamDomain, aud}, users:{[lowercasedEmail]: userId}, hiddenGroups: string[], showCostToMembers: boolean, currency:{code, symbol, rate}, prices:{[model]: {input, output, cacheRead?, cacheWrite?, cacheWrite5m?, cacheWrite1h?}}, plugins: string[] /*absolute*/ }`
  - `isValidTimezone(tz) → boolean`
  - `createCache({ttlMs, now}) → { get(key, computeAsyncOrSync) → Promise<value>, clear() }`. Rejections are not cached.

- [ ] **Step 1: Create the worktree and scaffold**

```bash
cd /Users/shaiungar/git/nanoclaw-profiles
git worktree add .worktrees/v1 -b v1 design-spec
cd .worktrees/v1
```

Write `package.json`:

```json
{
  "name": "nanoclaw-profiles",
  "version": "0.1.0",
  "description": "Friendly, read-only agent profile pages for NanoClaw installs",
  "license": "MIT",
  "type": "module",
  "bin": { "nanoclaw-profiles": "src/cli.mjs" },
  "engines": { "node": ">=22.13" },
  "files": ["src", "catalogue", "config.example.json", "deploy", "README.md", "LICENSE"],
  "scripts": {
    "test": "node --disable-warning=ExperimentalWarning --test \"test/**/*.test.mjs\""
  }
}
```

Write `LICENSE` with the standard MIT text, `Copyright (c) 2026 Shai Ungar`.

Make `.gitignore` contain exactly:

```
.worktrees/
node_modules/
config.json
```

Write `src/escape.mjs`:

```js
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
}
```

- [ ] **Step 2: Write the failing tests**

`test/config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, loadConfig, ConfigError, isValidTimezone } from '../src/config.mjs';

const minimal = {
  nanoclawDir: '/srv/nanoclaw',
  access: { teamDomain: 'team.cloudflareaccess.com', aud: 'aud-tag' },
  users: { 'Person@Example.com': 'whatsapp:1' },
};

test('minimal config gets defaults and derived paths', () => {
  const c = validateConfig(minimal, '/etc/profiles');
  assert.equal(c.port, 3200);
  assert.equal(c.dbPath, '/srv/nanoclaw/data/v2.db');
  assert.equal(c.sessionsDir, '/srv/nanoclaw/data/v2-sessions');
  assert.equal(c.groupsDir, '/srv/nanoclaw/groups');
  assert.equal(c.ncl, '/srv/nanoclaw/bin/ncl');
  assert.equal(c.timezone, 'UTC');
  assert.deepEqual(c.users, { 'person@example.com': 'whatsapp:1' });
  assert.deepEqual(c.currency, { code: 'USD', symbol: '$', rate: 1 });
  assert.equal(c.showCostToMembers, false);
  assert.deepEqual(c.hiddenGroups, []);
  assert.deepEqual(c.plugins, []);
});

test('relative paths resolve against the config directory', () => {
  const c = validateConfig({ ...minimal, nanoclawDir: '../nc', plugins: ['./p.mjs'] }, '/etc/profiles');
  assert.equal(c.nanoclawDir, '/etc/nc');
  assert.deepEqual(c.plugins, ['/etc/profiles/p.mjs']);
});

test('teamDomain is normalised', () => {
  const c = validateConfig({ ...minimal, access: { teamDomain: 'https://team.cloudflareaccess.com/', aud: 'a' } }, '/');
  assert.equal(c.access.teamDomain, 'team.cloudflareaccess.com');
});

test('all problems are reported together', () => {
  assert.throws(() => validateConfig({ users: { 'not-an-email': 'x' }, timezone: 'Mars/Base', port: 0 }, '/'), (err) => {
    assert.ok(err instanceof ConfigError);
    for (const part of ['nanoclawDir', 'access.teamDomain', 'access.aud', 'not-an-email', 'Mars/Base', 'port']) {
      assert.match(err.message, new RegExp(part.replace('.', '\\.')));
    }
    return true;
  });
});

test('prices must have numeric input and output', () => {
  assert.throws(() => validateConfig({ ...minimal, prices: { m: { input: 1 } } }, '/'), /prices\.m\.output/);
});

test('loadConfig reads a file and reports unreadable files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(minimal));
  assert.equal(loadConfig(file).port, 3200);
  assert.throws(() => loadConfig(path.join(dir, 'missing.json')), ConfigError);
});

test('isValidTimezone', () => {
  assert.equal(isValidTimezone('Asia/Jerusalem'), true);
  assert.equal(isValidTimezone('Nope/Nope'), false);
});
```

`test/cache.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/cache.mjs';

test('caches within the TTL and recomputes after it', async () => {
  let t = 0;
  let calls = 0;
  const cache = createCache({ ttlMs: 1000, now: () => t });
  const compute = () => ++calls;
  assert.equal(await cache.get('k', compute), 1);
  t = 999;
  assert.equal(await cache.get('k', compute), 1);
  t = 1000;
  assert.equal(await cache.get('k', compute), 2);
});

test('failures are not cached', async () => {
  const cache = createCache();
  await assert.rejects(cache.get('k', () => { throw new Error('boom'); }), /boom/);
  assert.equal(await cache.get('k', () => 'ok'), 'ok');
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/config.mjs'`, and the same for `cache.mjs`.

- [ ] **Step 4: Implement**

`src/config.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateConfig(raw, baseDir) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const errors = [];

  if (typeof cfg.nanoclawDir !== 'string' || !cfg.nanoclawDir) errors.push('nanoclawDir is required');

  const access = cfg.access ?? {};
  if (typeof access.teamDomain !== 'string' || !access.teamDomain) errors.push('access.teamDomain is required');
  if (typeof access.aud !== 'string' || !access.aud) errors.push('access.aud is required');

  const users = cfg.users ?? {};
  if (typeof users !== 'object' || Array.isArray(users) || Object.keys(users).length === 0) {
    errors.push('users must map at least one email to a NanoClaw user id');
  } else {
    for (const [email, id] of Object.entries(users)) {
      if (!EMAIL_RE.test(email)) errors.push(`users: "${email}" is not an email address`);
      if (typeof id !== 'string' || !id) errors.push(`users: "${email}" must map to a user id string`);
    }
  }

  const port = cfg.port ?? 3200;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('port must be an integer 1-65535');

  const timezone = cfg.timezone ?? 'UTC';
  if (!isValidTimezone(timezone)) errors.push(`timezone "${timezone}" is not a valid IANA timezone`);

  const currency = { code: 'USD', symbol: '$', rate: 1, ...(cfg.currency ?? {}) };
  if (typeof currency.rate !== 'number' || !(currency.rate > 0)) errors.push('currency.rate must be a positive number');

  const prices = cfg.prices ?? {};
  for (const [model, p] of Object.entries(prices)) {
    for (const k of ['input', 'output']) {
      if (typeof p?.[k] !== 'number') errors.push(`prices.${model}.${k} must be a number`);
    }
  }

  const plugins = cfg.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.some((p) => typeof p !== 'string')) errors.push('plugins must be an array of paths');

  const hiddenGroups = cfg.hiddenGroups ?? [];
  if (!Array.isArray(hiddenGroups) || hiddenGroups.some((g) => typeof g !== 'string')) {
    errors.push('hiddenGroups must be an array of group folders');
  }

  if (errors.length) throw new ConfigError(`Invalid config:\n- ${errors.join('\n- ')}`);

  const nanoclawDir = path.resolve(baseDir, cfg.nanoclawDir);
  return {
    port,
    nanoclawDir,
    dbPath: path.join(nanoclawDir, 'data', 'v2.db'),
    sessionsDir: path.join(nanoclawDir, 'data', 'v2-sessions'),
    groupsDir: path.join(nanoclawDir, 'groups'),
    ncl: cfg.ncl ? path.resolve(baseDir, cfg.ncl) : path.join(nanoclawDir, 'bin', 'ncl'),
    timezone,
    access: {
      teamDomain: access.teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      aud: access.aud,
    },
    users: Object.fromEntries(Object.entries(users).map(([e, id]) => [e.toLowerCase(), id])),
    hiddenGroups,
    showCostToMembers: cfg.showCostToMembers === true,
    currency,
    prices,
    plugins: plugins.map((p) => path.resolve(baseDir, p)),
  };
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read config ${abs}: ${err.message}`);
  }
  return validateConfig(raw, path.dirname(abs));
}
```

`src/cache.mjs`:

```js
export function createCache({ ttlMs = 30_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    async get(key, compute) {
      const hit = entries.get(key);
      if (hit && hit.expires > now()) return hit.value;
      const value = await compute();
      entries.set(key, { value, expires: now() + ttlMs });
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold package, config loader and TTL cache

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Plain-language formatting and schedules

**Files:**
- Create: `src/present/format.mjs`, `src/present/schedule.mjs`
- Test: `test/format.test.mjs`, `test/schedule.test.mjs`

**Interfaces:**
- Produces (format.mjs):
  - `humanizeSlug(s) → string`: `"school-contacts.md"` becomes `"School contacts"`.
  - `pluralize(n, word) → "1 run" | "2 runs"`
  - `formatMoney(amount, {symbol}) → "₪12.40"`. Two decimals below 100; no decimals and thousands separators at 100 and above.
  - `monthLabel("2026-09") → "Sep"`
  - `dayLabel("2026-09-15") → "Tue 15 Sep"`
  - `activityLine(day) → string`, where `day = {conversations, messagesIn, messagesOut, routineRuns, routineFailures, services: {[service]: count} | null}`.
- Produces (schedule.mjs):
  - `dayKey(date, timezone) → "YYYY-MM-DD"`
  - `describeCron(expr) → string`
  - `formatWhen(iso, {timezone, now}) → "today at 07:30" | "yesterday at …" | "tomorrow at …" | "on Tue 14 Jul at 18:00" | null`
  - `humanizeTaskId(seriesId) → string`
  - `describeRoutine(row, {timezone, now}) → { id, name, schedule, paused, lastRun, failures, nextRun, lastLog }`, where `row = { series_id, status, schedule, runs, failed_runs, last_run, next_run, lastLog }`.

- [ ] **Step 1: Write the failing tests**

`test/format.test.mjs`:

```js
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
```

`test/schedule.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test`
Expected: FAIL with "Cannot find module" for `format.mjs` and `schedule.mjs`.

- [ ] **Step 3: Implement**

`src/present/format.mjs`:

```js
export function humanizeSlug(s) {
  const text = String(s ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

export function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatMoney(amount, { symbol }) {
  const digits = amount < 100 ? 2 : 0;
  return symbol + new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
}

export function monthLabel(month) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' }).format(new Date(`${month}-15T12:00:00Z`)).slice(0, 3);
}

export function dayLabel(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(d);
  return `${weekday} ${d.getUTCDate()} ${monthLabel(date.slice(0, 7))}`;
}

export function activityLine(day) {
  const parts = [];
  if (day.conversations) parts.push(pluralize(day.conversations, 'conversation'));
  const messages = day.messagesIn + day.messagesOut;
  if (messages) parts.push(pluralize(messages, 'message'));
  if (day.routineRuns) {
    const failed = day.routineFailures ? ` (${day.routineFailures} failed)` : '';
    parts.push(`${pluralize(day.routineRuns, 'routine run')}${failed}`);
  }
  const services = Object.entries(day.services ?? {}).filter(([, n]) => n > 0);
  if (services.length) parts.push(`used ${services.map(([s, n]) => `${s} ×${n}`).join(', ')}`);
  return parts.length ? parts.join(' · ') : 'Quiet day';
}
```

Note: `monthLabel` slices to 3 characters because newer ICU versions render September as "Sept".

`src/present/schedule.mjs`:

```js
import { humanizeSlug, pluralize } from './format.mjs';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayKey(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function parseField(field, min, max) {
  if (field === '*') return null;
  const out = new Set();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad cron field ${field}`);
    const start = m[1] === '*' ? min : Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : m[1] === '*' || m[3] ? max : start;
    const step = m[3] ? Number(m[3]) : 1;
    if (start < min || end > max || start > end || step < 1) throw new Error(`bad cron field ${field}`);
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function describeCron(expr) {
  const custom = `On a custom schedule (${expr})`;
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return custom;
  try {
    const [mi, ho, dom, mon, dow] = parts;
    const minutes = parseField(mi, 0, 59);
    const hours = parseField(ho, 0, 23);
    const doms = parseField(dom, 1, 31);
    const months = parseField(mon, 1, 12);
    const dowsRaw = parseField(dow, 0, 7);
    const dows = dowsRaw ? [...new Set(dowsRaw.map((d) => d % 7))].sort((a, b) => a - b) : null;
    if (months || (doms && dows)) return custom;

    const minuteStep = /^\*\/(\d+)$/.exec(mi);
    const hourStep = /^\*\/(\d+)$/.exec(ho);
    const dayRestricted = Boolean(doms || dows);

    if (minuteStep && !hours) return dayRestricted ? custom : `Every ${pluralize(Number(minuteStep[1]), 'minute')}`;
    if (minutes?.length === 1 && !hours) return dayRestricted ? custom : `Every hour at :${pad(minutes[0])}`;
    if (minutes?.length === 1 && hourStep) return dayRestricted ? custom : `Every ${pluralize(Number(hourStep[1]), 'hour')} at :${pad(minutes[0])}`;
    if (!minutes || !hours || minutes.length * hours.length > 6) return custom;

    const times = joinList(hours.flatMap((h) => minutes.map((m) => `${pad(h)}:${pad(m)}`)));
    let days;
    if (doms) days = `Monthly on the ${joinList(doms.map(ordinal))}`;
    else if (!dows) days = 'Every day';
    else if (dows.join() === '1,2,3,4,5') days = 'Every weekday';
    else if (dows.join() === '0,6') days = 'Every Saturday and Sunday';
    else days = `Every ${joinList(dows.map((d) => DAY_NAMES[d]))}`;
    return `${days} at ${times}`;
  } catch {
    return custom;
  }
}

function daysBetween(fromKey, toKey) {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86_400_000);
}

export function formatWhen(iso, { timezone, now = new Date() }) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const diff = daysBetween(dayKey(now, timezone), dayKey(d, timezone));
  if (diff === 0) return `today at ${time}`;
  if (diff === -1) return `yesterday at ${time}`;
  if (diff === 1) return `tomorrow at ${time}`;
  const key = dayKey(d, timezone);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${key}T12:00:00Z`));
  const month = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' }).format(new Date(`${key}T12:00:00Z`)).slice(0, 3);
  return `on ${weekday} ${Number(key.slice(8, 10))} ${month} at ${time}`;
}

export function humanizeTaskId(seriesId) {
  const id = String(seriesId ?? '');
  if (/^task-\d+/.test(id) || !id) return 'Unnamed routine';
  return humanizeSlug(id.replace(/-[0-9a-f]{4}$/i, '')) || 'Unnamed routine';
}

export function describeRoutine(row, { timezone, now }) {
  const once = !row.schedule || row.schedule === 'once';
  const paused = row.status === 'paused';
  const nextWhen = formatWhen(row.next_run, { timezone, now });
  const failed = row.failed_runs ?? 0;
  return {
    id: row.series_id,
    name: humanizeTaskId(row.series_id),
    schedule: once ? (nextWhen ? `Once, ${nextWhen}` : 'Once') : describeCron(row.schedule),
    paused,
    lastRun: row.last_run ? `Last ran ${formatWhen(row.last_run, { timezone, now })}` : 'Has not run yet',
    failures: failed > 0 ? `${pluralize(failed, 'failed run')}` : null,
    nextRun: !paused && nextWhen ? `Next: ${nextWhen}` : null,
    lastLog: row.lastLog ?? null,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS. If `dayLabel` or `formatWhen` fails only on the month name, check whether the local ICU renders "Sept"; the `.slice(0, 3)` above exists to normalise that.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: plain-language formatting for schedules, money and activity

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Safe Markdown rendering

**Files:**
- Create: `src/present/markdown.mjs`
- Test: `test/markdown.test.mjs`

**Interfaces:**
- Consumes: `esc` from `src/escape.mjs`
- Produces: `renderMarkdown(md) → string` (HTML). It supports headings (shifted down two levels, `#` → `<h3>`), bulleted and numbered lists, paragraphs, `**bold**`, `*em*`, `` `code` ``, and `[text](https://…)` links. Links with any other scheme are rendered as plain text. Raw HTML is always escaped.

- [ ] **Step 1: Write the failing test**

`test/markdown.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/present/markdown.mjs';

test('headings shift down two levels', () => {
  assert.equal(renderMarkdown('# Family'), '<h3>Family</h3>');
  assert.equal(renderMarkdown('###### Deep'), '<h6>Deep</h6>');
});

test('lists and paragraphs', () => {
  assert.equal(renderMarkdown('- a\n- **b**\n\nText *here*\nmore'), '<ul><li>a</li><li><strong>b</strong></li></ul>\n<p>Text <em>here</em> more</p>');
  assert.equal(renderMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('html is escaped', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('only http(s) links become anchors', () => {
  assert.equal(renderMarkdown('[site](https://example.com/a?b=1&c=2)'), '<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">site</a></p>');
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>x</p>');
  assert.equal(renderMarkdown('[kids](family/kids.md)'), '<p>kids</p>');
});

test('inline code', () => {
  assert.equal(renderMarkdown('use `ncl`'), '<p>use <code>ncl</code></p>');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`src/present/markdown.mjs`:

```js
import { esc } from '../escape.mjs';

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)+/g, '$1');
  return s;
}

export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  for (const line of lines) {
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = Math.min(6, h[1].length + 2);
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push((ul ?? ol)[1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('\n');
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: minimal escaped Markdown renderer for memory

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Capability catalogue and can/can't derivation

**Files:**
- Create: `catalogue/capabilities.json`, `src/catalogue.mjs`, `src/present/capabilities.mjs`
- Test: `test/capabilities.test.mjs`

**Interfaces:**
- Produces:
  - `CatalogueEntry = { match?: string /*tool glob*/, server?: string /*server glob*/, service: string, sentence: string, cannot?: string }`
  - `loadCatalogue(plugins) → CatalogueEntry[]`: plugin entries first, then the built-in ones. The first match wins.
  - `globToRegExp(glob) → RegExp` (case-insensitive, `*` = any run).
  - `serversOf(mcpServers, resolve) → [{ name, tools: string[] | null }]`, where `resolve(name, cfg) → string[] | null`.
  - `describeCapabilities(servers, catalogue, installServices = new Set()) → { can: [{service, sentences: string[]}], cannot: string[], noAccess: string[], unknown: [{server, tool: string|null}] }`

- [ ] **Step 1: Write the catalogue**

`catalogue/capabilities.json`:

```json
[
  { "server": "notion*", "service": "Notion", "sentence": "Reads and edits pages and databases in your Notion workspace" },
  { "server": "*github*", "service": "GitHub", "sentence": "Works with your GitHub repositories, issues and pull requests" },
  { "server": "*gmail*", "service": "Email", "sentence": "Reads and manages your Gmail" },
  { "server": "*calendar*", "service": "Calendar", "sentence": "Reads and changes events on your calendar" },
  { "server": "*drive*", "service": "Files", "sentence": "Finds and reads files in your Google Drive" },
  { "server": "*slack*", "service": "Slack", "sentence": "Reads and posts messages in Slack" },
  { "server": "*home-assistant*", "service": "Smart home", "sentence": "Checks and controls devices in your home" },
  { "server": "*filesystem*", "service": "Files", "sentence": "Reads and writes files in its workspace" },
  { "server": "*brave*", "service": "Web", "sentence": "Searches the web" },
  { "server": "*fetch*", "service": "Web", "sentence": "Opens and reads web pages" },
  { "server": "*playwright*", "service": "Web", "sentence": "Uses a web browser to visit and interact with sites" }
]
```

- [ ] **Step 2: Write the failing test**

`test/capabilities.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, serversOf, describeCapabilities } from '../src/present/capabilities.mjs';
import { loadCatalogue } from '../src/catalogue.mjs';

const catalogue = [
  { match: 'gmail_search', service: 'Email', sentence: 'Searches and reads your email' },
  { match: 'gmail_get_*', service: 'Email', sentence: 'Searches and reads your email' },
  { match: 'gmail_send', service: 'Email', sentence: 'Sends email for you', cannot: 'Cannot send or reply to email' },
  { match: 'gcal_*', service: 'Calendar', sentence: 'Reads and changes events on your calendar' },
  { match: 'ynab_*', service: 'Budget', sentence: 'Checks your budget' },
  { server: 'notion*', service: 'Notion', sentence: 'Reads and edits your Notion' },
];

test('globToRegExp', () => {
  assert.ok(globToRegExp('gcal_*').test('gcal_list_events'));
  assert.ok(!globToRegExp('gcal_*').test('xgcal_list'));
  assert.ok(globToRegExp('*drive*').test('google-drive'));
  assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'));
});

test('serversOf uses the resolver per server', () => {
  const servers = serversOf({ a: { env: { X: '1' } }, b: {} }, (name) => (name === 'a' ? ['t1'] : null));
  assert.deepEqual(servers, [{ name: 'a', tools: ['t1'] }, { name: 'b', tools: null }]);
});

test('tool-level can, cannot, noAccess and unknown', () => {
  const servers = [
    { name: 'google-mcp', tools: ['gmail_search', 'gmail_get_message', 'gcal_list_events', 'mystery_tool'] },
    { name: 'notion', tools: null },
    { name: 'weird-server', tools: null },
  ];
  const r = describeCapabilities(servers, catalogue, new Set(['Email', 'Calendar', 'Budget', 'Notion']));
  assert.deepEqual(r.can, [
    { service: 'Email', sentences: ['Searches and reads your email'] },
    { service: 'Calendar', sentences: ['Reads and changes events on your calendar'] },
    { service: 'Notion', sentences: ['Reads and edits your Notion'] },
  ]);
  assert.deepEqual(r.cannot, ['Cannot send or reply to email']);
  assert.deepEqual(r.noAccess, ['Budget']);
  assert.deepEqual(r.unknown, [
    { server: 'google-mcp', tool: 'mystery_tool' },
    { server: 'weird-server', tool: null },
  ]);
});

test('a tool list falls back to a server-level entry', () => {
  const r = describeCapabilities([{ name: 'notion', tools: ['notion_query'] }], catalogue);
  assert.deepEqual(r.can, [{ service: 'Notion', sentences: ['Reads and edits your Notion'] }]);
  assert.deepEqual(r.unknown, []);
});

test('first matching entry wins (plugin entries come first)', () => {
  const r = describeCapabilities([{ name: 's', tools: ['gcal_x'] }], [{ match: 'gcal_*', service: 'Family calendar', sentence: 'Custom' }, ...catalogue]);
  assert.deepEqual(r.can, [{ service: 'Family calendar', sentences: ['Custom'] }]);
});

test('loadCatalogue puts plugin entries before built-ins', () => {
  const merged = loadCatalogue([{ name: 'p', capabilities: [{ match: 'x_*', service: 'X', sentence: 'Does X' }] }]);
  assert.equal(merged[0].service, 'X');
  assert.ok(merged.some((e) => e.service === 'Notion'));
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module".

- [ ] **Step 4: Implement**

`src/catalogue.mjs`:

```js
import fs from 'node:fs';

const BUILTIN = JSON.parse(fs.readFileSync(new URL('../catalogue/capabilities.json', import.meta.url), 'utf8'));

export function loadCatalogue(plugins) {
  return [...plugins.flatMap((p) => p.capabilities ?? []), ...BUILTIN];
}
```

`src/present/capabilities.mjs`:

```js
export function globToRegExp(glob) {
  const src = String(glob).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${src}$`, 'i');
}

export function serversOf(mcpServers, resolve) {
  return Object.entries(mcpServers ?? {}).map(([name, cfg]) => ({ name, tools: resolve(name, cfg) ?? null }));
}

export function describeCapabilities(servers, catalogue, installServices = new Set()) {
  const entries = catalogue.map((e, i) => ({
    ...e,
    i,
    toolRe: e.match ? globToRegExp(e.match) : null,
    serverRe: e.server ? globToRegExp(e.server) : null,
  }));
  const serverEntry = (name) => entries.find((e) => !e.toolRe && e.serverRe?.test(name));
  const allowed = new Set();
  const unknown = [];

  for (const server of servers) {
    if (server.tools === null) {
      const hit = serverEntry(server.name);
      if (hit) allowed.add(hit.i);
      else unknown.push({ server: server.name, tool: null });
      continue;
    }
    for (const tool of server.tools) {
      const hit = entries.find((e) => e.toolRe?.test(tool) && (!e.serverRe || e.serverRe.test(server.name))) ?? serverEntry(server.name);
      if (hit) allowed.add(hit.i);
      else unknown.push({ server: server.name, tool });
    }
  }

  const services = new Map();
  for (const e of entries) {
    if (!allowed.has(e.i)) continue;
    const list = services.get(e.service) ?? [];
    if (!list.includes(e.sentence)) list.push(e.sentence);
    services.set(e.service, list);
  }

  const cannot = [];
  for (const e of entries) {
    if (!allowed.has(e.i) && e.cannot && services.has(e.service) && !cannot.includes(e.cannot)) cannot.push(e.cannot);
  }

  const noAccess = [...installServices].filter((s) => !services.has(s)).sort();
  return { can: [...services].map(([service, sentences]) => ({ service, sentences })), cannot, noAccess, unknown };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: capability catalogue and can/can't derivation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: NanoClaw DB source, fixture install, and who-sees-what

**Files:**
- Create: `src/db.mjs`, `src/sources/nanoclaw.mjs`, `src/identity.mjs`, `test/helpers/install.mjs`
- Test: `test/identity.test.mjs`

**Interfaces:**
- Produces:
  - `openReadOnly(file) → DatabaseSync`
  - `createNanoclawSource(dbPath) → { listAgentGroups() → [{id,name,folder}], getContainerConfig(agId) → {assistantName, timezone, mcpServers} | null, getRoles(userId) → [{role, agentGroupId}], getMemberships(userId) → string[], listSessions(agId) → [{id,lastActive,createdAt}], close() }`
  - `resolveViewer(email, {users, hiddenGroups, nanoclaw}) → { email, userId, isOwner, groups: [{id,name,folder}] } | null`
  - Test helper `createInstall() → Install` (API in the code below). Later tasks use it.

- [ ] **Step 1: Write the fixture helper**

`test/helpers/install.mjs`. The DDL is the subset of NanoClaw's schema that we read, copied from `nanoclaw/src/db/schema.ts`, migration `014` and later migrations, and `docs/db-session.md`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CENTRAL_DDL = `
CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, agent_provider TEXT, created_at TEXT NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL, agent_group_id TEXT, granted_by TEXT, granted_at TEXT NOT NULL, PRIMARY KEY (user_id, role, agent_group_id));
CREATE TABLE agent_group_members (user_id TEXT NOT NULL, agent_group_id TEXT NOT NULL, added_by TEXT, added_at TEXT NOT NULL, PRIMARY KEY (user_id, agent_group_id));
CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT, thread_id TEXT, agent_provider TEXT, status TEXT DEFAULT 'active', container_status TEXT DEFAULT 'stopped', last_active TEXT, created_at TEXT NOT NULL);
CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, provider TEXT, model TEXT, effort TEXT, image_tag TEXT, assistant_name TEXT, max_messages_per_prompt INTEGER, skills TEXT NOT NULL DEFAULT '"all"', mcp_servers TEXT NOT NULL DEFAULT '{}', packages_apt TEXT NOT NULL DEFAULT '[]', packages_npm TEXT NOT NULL DEFAULT '[]', additional_mounts TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL, cli_scope TEXT NOT NULL DEFAULT 'group', timezone TEXT);
`;

const INBOUND_DDL = `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, series_id TEXT, tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL, source_session_id TEXT, on_wake INTEGER NOT NULL DEFAULT 0);`;
const OUTBOUND_DDL = `CREATE TABLE messages_out (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT, timestamp TEXT NOT NULL, deliver_after TEXT, recurrence TEXT, kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL);`;

const NOW = '2026-09-01T00:00:00.000Z';

export function createInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-install-'));
  fs.mkdirSync(path.join(dir, 'data', 'v2-sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'groups'), { recursive: true });
  const dbPath = path.join(dir, 'data', 'v2.db');
  const db = new DatabaseSync(dbPath);
  db.exec(CENTRAL_DDL);
  let seq = 0;

  const install = {
    dir,
    dbPath,
    sessionsDir: path.join(dir, 'data', 'v2-sessions'),
    groupsDir: path.join(dir, 'groups'),
    addGroup({ id, name, folder, mcpServers = {}, timezone = null, assistantName = null }) {
      db.prepare('INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(id, name, folder, NOW);
      db.prepare('INSERT INTO container_configs (agent_group_id, assistant_name, mcp_servers, updated_at, timezone) VALUES (?, ?, ?, ?, ?)')
        .run(id, assistantName, JSON.stringify(mcpServers), NOW, timezone);
      fs.mkdirSync(path.join(install.groupsDir, folder), { recursive: true });
      return install;
    },
    addUser(id, displayName = id) {
      db.prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(id, 'whatsapp', displayName, NOW);
      return install;
    },
    addRole(userId, role, agentGroupId = null) {
      db.prepare('INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES (?, ?, ?, ?)').run(userId, role, agentGroupId, NOW);
      return install;
    },
    addMember(userId, agentGroupId) {
      db.prepare('INSERT INTO agent_group_members (user_id, agent_group_id, added_at) VALUES (?, ?, ?)').run(userId, agentGroupId, NOW);
      return install;
    },
    addSession({ id, agentGroupId, lastActive }) {
      db.prepare('INSERT INTO sessions (id, agent_group_id, last_active, created_at) VALUES (?, ?, ?, ?)').run(id, agentGroupId, lastActive, NOW);
      const sdir = path.join(install.sessionsDir, agentGroupId, id);
      fs.mkdirSync(sdir, { recursive: true });
      const inbound = new DatabaseSync(path.join(sdir, 'inbound.db'));
      inbound.exec(INBOUND_DDL);
      const outbound = new DatabaseSync(path.join(sdir, 'outbound.db'));
      outbound.exec(OUTBOUND_DDL);
      const session = {
        inbound({ kind = 'chat', timestamp, status = 'completed', processAfter = null, seriesId = null }) {
          seq += 2;
          inbound.prepare('INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, series_id, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(`in-${seq}`, seq, kind, timestamp, status, processAfter, seriesId, '{"text":"PRIVATE MESSAGE TEXT"}');
          return session;
        },
        outbound({ kind = 'chat', timestamp }) {
          seq += 2;
          outbound.prepare('INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)')
            .run(`out-${seq}`, seq + 1, kind, timestamp, '{"text":"PRIVATE REPLY TEXT"}');
          return session;
        },
        close() {
          inbound.close();
          outbound.close();
        },
      };
      return session;
    },
    writeGroupFile(folder, rel, content) {
      const file = path.join(install.groupsDir, folder, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
    writeTranscript(agentGroupId, rel, lines) {
      const file = path.join(install.sessionsDir, agentGroupId, '.claude-shared', 'projects', rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return file;
    },
    close() {
      db.close();
    },
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return install;
}

export function householdInstall() {
  const install = createInstall();
  install
    .addGroup({ id: 'ag-personal', name: 'Ausie', folder: 'ausie' })
    .addGroup({ id: 'ag-home', name: 'Home', folder: 'home' })
    .addGroup({ id: 'ag-eval', name: 'Eval', folder: 'eval' })
    .addUser('wa:owner')
    .addUser('wa:spouse')
    .addUser('wa:stranger')
    .addRole('wa:owner', 'owner')
    .addMember('wa:spouse', 'ag-home');
  return install;
}
```

- [ ] **Step 2: Write the failing test**

`test/identity.test.mjs`:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { householdInstall } from './helpers/install.mjs';
import { createNanoclawSource } from '../src/sources/nanoclaw.mjs';
import { resolveViewer } from '../src/identity.mjs';

const install = householdInstall();
install.addUser('wa:gadmin').addRole('wa:gadmin', 'admin');
install.addUser('wa:sadmin').addRole('wa:sadmin', 'admin', 'ag-personal');
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
};
const ctx = { users, hiddenGroups: ['eval'], nanoclaw };
const folders = (email) => resolveViewer(email, ctx)?.groups.map((g) => g.folder);

test('owner sees everything, including hidden groups', () => {
  const v = resolveViewer('OWNER@x.com', ctx);
  assert.equal(v.isOwner, true);
  assert.equal(v.email, 'owner@x.com');
  assert.deepEqual(v.groups.map((g) => g.folder).sort(), ['ausie', 'eval', 'home']);
});

test('member sees only their groups', () => {
  assert.deepEqual(folders('spouse@x.com'), ['home']);
});

test('global admin sees everything except hidden groups', () => {
  assert.deepEqual(folders('gadmin@x.com').sort(), ['ausie', 'home']);
});

test('scoped admin sees their group', () => {
  assert.deepEqual(folders('sadmin@x.com'), ['ausie']);
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
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/sources/nanoclaw.mjs'".

- [ ] **Step 4: Implement**

`src/db.mjs`:

```js
import { DatabaseSync } from 'node:sqlite';

export function openReadOnly(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 2000');
  return db;
}
```

`src/sources/nanoclaw.mjs`:

```js
import { openReadOnly } from '../db.mjs';

export function createNanoclawSource(dbPath) {
  let db = null;
  const all = (sql, ...params) => {
    try {
      db ??= openReadOnly(dbPath);
      return db.prepare(sql).all(...params);
    } catch (err) {
      try { db?.close(); } catch {}
      db = null;
      throw err;
    }
  };
  return {
    listAgentGroups() {
      return all('SELECT id, name, folder FROM agent_groups ORDER BY name').map((r) => ({ id: r.id, name: r.name, folder: r.folder }));
    },
    getContainerConfig(agentGroupId) {
      const [row] = all('SELECT * FROM container_configs WHERE agent_group_id = ?', agentGroupId);
      if (!row) return null;
      let mcpServers = {};
      try {
        const parsed = JSON.parse(row.mcp_servers);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) mcpServers = parsed;
      } catch {}
      return { assistantName: row.assistant_name ?? null, timezone: row.timezone ?? null, mcpServers };
    },
    getRoles(userId) {
      return all('SELECT role, agent_group_id FROM user_roles WHERE user_id = ?', userId).map((r) => ({ role: r.role, agentGroupId: r.agent_group_id ?? null }));
    },
    getMemberships(userId) {
      return all('SELECT agent_group_id FROM agent_group_members WHERE user_id = ?', userId).map((r) => r.agent_group_id);
    },
    listSessions(agentGroupId) {
      return all('SELECT id, last_active, created_at FROM sessions WHERE agent_group_id = ?', agentGroupId)
        .map((r) => ({ id: r.id, lastActive: r.last_active ?? null, createdAt: r.created_at }));
    },
    close() {
      try { db?.close(); } catch {}
      db = null;
    },
  };
}
```

`src/identity.mjs`:

```js
export function resolveViewer(email, { users, hiddenGroups, nanoclaw }) {
  const normalized = String(email ?? '').toLowerCase();
  const userId = users[normalized];
  if (!userId) return null;
  const groups = nanoclaw.listAgentGroups();
  const roles = nanoclaw.getRoles(userId);
  const isOwner = roles.some((r) => r.role === 'owner');
  let visible;
  if (isOwner) {
    visible = groups;
  } else {
    const hidden = new Set(hiddenGroups);
    const globalAdmin = roles.some((r) => r.role === 'admin' && r.agentGroupId === null);
    const ids = new Set([
      ...roles.filter((r) => r.role === 'admin' && r.agentGroupId).map((r) => r.agentGroupId),
      ...nanoclaw.getMemberships(userId),
    ]);
    visible = groups.filter((g) => !hidden.has(g.folder) && (globalAdmin || ids.has(g.id)));
  }
  return { email: normalized, userId, isOwner, groups: visible };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: read-only NanoClaw source and per-person visibility

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Cloudflare Access JWT verification

**Files:**
- Create: `src/auth.mjs`, `test/helpers/jwt.mjs`
- Test: `test/auth.test.mjs`

**Interfaces:**
- Produces:
  - `class AuthError extends Error`
  - `createAccessVerifier({ teamDomain, aud, fetchImpl?, now?, refetchIntervalMs? }) → { init() → Promise<void>, verify(token) → Promise<{email}> }`. It throws `AuthError` for any bad token and a plain `Error` if the key set cannot be fetched.
  - Test helpers `makeKeyPair(kid)`, `signJwt(payload, key, headerOverrides?)` and `fakeFetch(jwks, calls)`.

- [ ] **Step 1: Write the helpers and the failing test**

`test/helpers/jwt.mjs`:

```js
import crypto from 'node:crypto';

export function makeKeyPair(kid = 'k1') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

export function signJwt(payload, { privateKey, kid }, header = {}) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

export function fakeFetch(jwks, calls = []) {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => (typeof jwks === 'function' ? jwks() : jwks) };
  };
}
```

`test/auth.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessVerifier, AuthError } from '../src/auth.mjs';
import { makeKeyPair, signJwt, fakeFetch } from './helpers/jwt.mjs';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-tag';
const key = makeKeyPair('k1');
const NOW_MS = 1_800_000_000_000;
const claims = (over = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], email: 'Person@X.com', exp: NOW_MS / 1000 + 300, iat: NOW_MS / 1000, ...over });

function verifier(calls = [], keys = [key.jwk]) {
  return createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: fakeFetch({ keys }, calls), now: () => NOW_MS });
}

test('valid token returns the lowercased email and fetches the certs URL', async () => {
  const calls = [];
  assert.deepEqual(await verifier(calls).verify(signJwt(claims(), key)), { email: 'person@x.com' });
  assert.deepEqual(calls, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

for (const [name, token, reason] of [
  ['missing', undefined, /missing/],
  ['malformed', 'a.b', /malformed/],
  ['expired', signJwt(claims({ exp: NOW_MS / 1000 - 120 }), key), /expired/],
  ['wrong aud', signJwt(claims({ aud: ['other'] }), key), /audience/],
  ['wrong iss', signJwt(claims({ iss: 'https://evil.example' }), key), /issuer/],
  ['no email', signJwt(claims({ email: undefined }), key), /email/],
  ['alg none', signJwt(claims(), key, { alg: 'none' }), /alg/],
  ['bad signature', signJwt(claims(), key).slice(0, -4) + 'AAAA', /signature/],
  ['foreign key', signJwt(claims(), makeKeyPair('k1')), /signature/],
  ['unknown kid', signJwt(claims(), { ...key, kid: 'k9' }), /unknown signing key/],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(verifier().verify(token), (err) => err instanceof AuthError && reason.test(err.message));
  });
}

test('unknown kid refetches at most once per interval', async () => {
  const calls = [];
  const v = verifier(calls);
  await v.init();
  const bad = signJwt(claims(), { ...key, kid: 'k9' });
  await assert.rejects(v.verify(bad), AuthError);
  await assert.rejects(v.verify(bad), AuthError);
  assert.equal(calls.length, 1);
});

test('rotated key is picked up on refetch', async () => {
  const rotated = makeKeyPair('k2');
  let keys = [key.jwk];
  let t = NOW_MS;
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: fakeFetch(() => ({ keys })), now: () => t });
  await v.init();
  keys = [key.jwk, rotated.jwk];
  t += 61_000;
  const token = signJwt(claims({ exp: t / 1000 + 300 }), rotated);
  assert.deepEqual(await v.verify(token), { email: 'person@x.com' });
});

test('JWKS fetch failure is not an AuthError', async () => {
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: async () => ({ ok: false, status: 500 }), now: () => NOW_MS });
  await assert.rejects(v.verify(signJwt(claims(), key)), (err) => !(err instanceof AuthError) && /HTTP 500/.test(err.message));
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/auth.mjs'".

- [ ] **Step 3: Implement**

`src/auth.mjs`:

```js
import crypto from 'node:crypto';

export class AuthError extends Error {}

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const LEEWAY_S = 60;

export function createAccessVerifier({ teamDomain, aud, fetchImpl = globalThis.fetch, now = () => Date.now(), refetchIntervalMs = 60_000 }) {
  const issuer = `https://${teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let keys = new Map();
  let lastFetch = -Infinity;

  async function refresh() {
    lastFetch = now();
    const res = await fetchImpl(certsUrl);
    if (!res.ok) throw new Error(`Access JWKS fetch failed: HTTP ${res.status}`);
    const body = await res.json();
    const next = new Map();
    for (const jwk of body.keys ?? []) {
      if (jwk.kid && jwk.kty === 'RSA') next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    keys = next;
  }

  async function keyFor(kid) {
    if (!keys.has(kid) && now() - lastFetch >= refetchIntervalMs) await refresh();
    return keys.get(kid);
  }

  return {
    init: refresh,
    async verify(token) {
      if (typeof token !== 'string' || !token) throw new AuthError('missing token');
      const parts = token.split('.');
      if (parts.length !== 3) throw new AuthError('malformed token');
      let header;
      let payload;
      try {
        header = decode(parts[0]);
        payload = decode(parts[1]);
      } catch {
        throw new AuthError('malformed token');
      }
      if (header.alg !== 'RS256') throw new AuthError('unsupported alg');
      const key = await keyFor(header.kid);
      if (!key) throw new AuthError('unknown signing key');
      const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
      if (!valid) throw new AuthError('bad signature');
      const t = now() / 1000;
      if (typeof payload.exp !== 'number' || payload.exp + LEEWAY_S < t) throw new AuthError('expired');
      if (typeof payload.nbf === 'number' && payload.nbf - LEEWAY_S > t) throw new AuthError('not yet valid');
      if (payload.iss !== issuer) throw new AuthError('wrong issuer');
      const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!auds.includes(aud)) throw new AuthError('wrong audience');
      if (typeof payload.email !== 'string' || !payload.email) throw new AuthError('no email claim');
      return { email: payload.email.toLowerCase() };
    },
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: verify Cloudflare Access JWTs against cached JWKS

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Agent card and memory sources

**Files:**
- Create: `src/sources/card.mjs`, `src/sources/memory.mjs`
- Test: `test/card.test.mjs`, `test/memory.test.mjs`

**Interfaces:**
- Consumes: `humanizeSlug` from `src/present/format.mjs`; `createInstall` from `test/helpers/install.mjs`
- Produces:
  - `class CardError extends Error`; `ICON_EXT: Set<string>`
  - `findCardFile(groupsDir, folder) → string | null`
  - `validateCard(card) → string[]`
  - `readAgentCard(groupsDir, folder) → { card, file, baseDir } | null`. Throws `CardError` if the card is invalid.
  - `resolveIconPath(cardInfo) → absolutePath | null`
  - `extractCoreMemory(indexMd) → string | null`
  - `parseFrontmatter(md) → { data: {[k]: string}, body }`
  - `readMemory(groupsDir, folder, {maxFiles = 200}) → { core: string|null, files: [{ folder, title, type, description }] }`

- [ ] **Step 1: Write the failing tests**

`test/card.test.mjs`:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  assert.equal(resolveIconPath(info), path.join(install.groupsDir, 'direct', 'avatar.png'));
  assert.equal(resolveIconPath({ ...info, card: { iconUrl: 'missing.png' } }), null);
  assert.equal(resolveIconPath({ ...info, card: { iconUrl: '../templated/x.png' } }), null);
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
```

`test/memory.test.mjs`:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createInstall } from './helpers/install.mjs';
import { extractCoreMemory, parseFrontmatter, readMemory } from '../src/sources/memory.mjs';

const install = createInstall();
after(() => install.cleanup());
install.addGroup({ id: 'h', name: 'Home', folder: 'home' });
install.writeGroupFile('home', 'memory/index.md', '# Index\n\n## Core Memory\n\n- Kids: Or and Noa\n\n### Detail\nsub\n\n## Map\n- [family](family/index.md)\n');
install.writeGroupFile('home', 'memory/family/index.md', '# Family index');
install.writeGroupFile('home', 'memory/family/or.md', '---\ntype: person\ndescription: "Older kid, class B2"\n---\n# Or\n\nDetails that must not be shown.');
install.writeGroupFile('home', 'memory/school-contacts.md', 'No frontmatter here.');
install.writeGroupFile('home', 'memory/log.md', '# Log');
install.writeGroupFile('home', 'memory/system/definition.md', '---\ntype: system\n---\n# How memory works');

test('extractCoreMemory takes the section including subsections', () => {
  assert.equal(extractCoreMemory('## Core Memory\n\n- a\n### Sub\nb\n## Next\nc'), '- a\n### Sub\nb');
  assert.equal(extractCoreMemory('# Nothing'), null);
});

test('parseFrontmatter', () => {
  assert.deepEqual(parseFrontmatter("---\ntype: person\ndescription: 'x: y'\n---\nbody"), { data: { type: 'person', description: 'x: y' }, body: 'body' });
  assert.deepEqual(parseFrontmatter('plain'), { data: {}, body: 'plain' });
});

test('readMemory lists titles and descriptions, never bodies', () => {
  const m = readMemory(install.groupsDir, 'home');
  assert.equal(m.core, '- Kids: Or and Noa\n\n### Detail\nsub');
  assert.deepEqual(m.files, [
    { folder: '', title: 'School contacts', type: null, description: null },
    { folder: 'family', title: 'Or', type: 'person', description: 'Older kid, class B2' },
  ]);
  assert.ok(!JSON.stringify(m).includes('must not be shown'));
});

test('missing memory folder is empty, not an error', () => {
  install.addGroup({ id: 'x', name: 'X', folder: 'empty' });
  assert.deepEqual(readMemory(install.groupsDir, 'empty'), { core: null, files: [] });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`src/sources/card.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';

export class CardError extends Error {}
export const ICON_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

export function findCardFile(groupsDir, folder) {
  const groupDir = path.join(groupsDir, folder);
  const direct = path.join(groupDir, 'agent-card.json');
  if (fs.existsSync(direct)) return direct;
  const pluginsDir = path.join(groupDir, 'plugins');
  if (!fs.existsSync(pluginsDir)) return null;
  for (const name of fs.readdirSync(pluginsDir).sort()) {
    const file = path.join(pluginsDir, name, 'agent-card.json');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function validateCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return ['card must be a JSON object'];
  const errors = [];
  for (const k of ['name', 'description', 'iconUrl']) {
    if (card[k] !== undefined && typeof card[k] !== 'string') errors.push(`${k} must be a string`);
  }
  if (typeof card.iconUrl === 'string') {
    if (card.iconUrl.includes('..') || path.isAbsolute(card.iconUrl) || /^[a-z][a-z0-9+.-]*:/i.test(card.iconUrl)) {
      errors.push('iconUrl must be a relative path inside the card folder');
    } else if (!ICON_EXT.has(path.extname(card.iconUrl).toLowerCase())) {
      errors.push('iconUrl must be a .png, .jpg, .jpeg, .webp or .svg file');
    }
  }
  if (card.skills !== undefined) {
    if (!Array.isArray(card.skills)) errors.push('skills must be an array');
    else {
      card.skills.forEach((s, i) => {
        if (!s || typeof s.name !== 'string') errors.push(`skills[${i}].name must be a string`);
        if (s?.description !== undefined && typeof s.description !== 'string') errors.push(`skills[${i}].description must be a string`);
        if (s?.examples !== undefined) {
          if (!isStringArray(s.examples)) errors.push(`skills[${i}].examples must be an array of strings`);
          else {
            if (s.examples.length > 5) errors.push(`skills[${i}] has more than 5 examples`);
            s.examples.forEach((e, j) => {
              if (e.length > 120) errors.push(`skills[${i}].examples[${j}] is longer than 120 characters`);
            });
          }
        }
      });
    }
  }
  const x = card['x-profile'];
  if (x !== undefined) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) errors.push('x-profile must be an object');
    else {
      for (const k of ['emoji', 'serves', 'voice']) {
        if (x[k] !== undefined && typeof x[k] !== 'string') errors.push(`x-profile.${k} must be a string`);
      }
      if (x.neverDoes !== undefined && !isStringArray(x.neverDoes)) errors.push('x-profile.neverDoes must be an array of strings');
    }
  }
  return errors;
}

export function readAgentCard(groupsDir, folder) {
  const file = findCardFile(groupsDir, folder);
  if (!file) return null;
  let card;
  try {
    card = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CardError(`${file}: invalid JSON (${err.message})`);
  }
  const errors = validateCard(card);
  if (errors.length) throw new CardError(`${file}: ${errors.join('; ')}`);
  return { card, file, baseDir: path.dirname(file) };
}

export function resolveIconPath(cardInfo) {
  const iconUrl = cardInfo?.card?.iconUrl;
  if (!iconUrl) return null;
  const abs = path.resolve(cardInfo.baseDir, iconUrl);
  if (!abs.startsWith(cardInfo.baseDir + path.sep)) return null;
  if (!ICON_EXT.has(path.extname(abs).toLowerCase())) return null;
  try {
    return fs.lstatSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}
```

`src/sources/memory.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { humanizeSlug } from '../present/format.mjs';

export function extractCoreMemory(indexMd) {
  const lines = String(indexMd).split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+core memory\b/i.test(l));
  if (start === -1) return null;
  const level = /^(#+)/.exec(lines[start])[1].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^(#+)\s/.exec(line);
    if (m && m[1].length <= level) break;
    body.push(line);
  }
  return body.join('\n').trim() || null;
}

export function parseFrontmatter(md) {
  const text = String(md);
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const data = {};
  for (const line of text.slice(text.indexOf('\n') + 1, end).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) data[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: text.slice(end + 4).replace(/^\r?\n/, '') };
}

const SKIP_FILES = new Set(['index.md', 'log.md']);

export function readMemory(groupsDir, folder, { maxFiles = 200 } = {}) {
  const root = path.join(groupsDir, folder, 'memory');
  if (!fs.existsSync(root)) return { core: null, files: [] };
  const indexFile = path.join(root, 'index.md');
  const core = fs.existsSync(indexFile) ? extractCoreMemory(fs.readFileSync(indexFile, 'utf8')) : null;
  const files = [];
  const walk = (rel, depth) => {
    if (depth > 6 || files.length >= maxFiles) return;
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!rel && entry.name === 'system') continue;
        walk(childRel, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
        const { data, body } = parseFrontmatter(fs.readFileSync(path.join(root, childRel), 'utf8'));
        const heading = /^#\s+(.+)$/m.exec(body)?.[1].trim();
        files.push({ folder: rel, title: heading || humanizeSlug(entry.name), type: data.type || null, description: data.description || null });
      }
    }
  };
  walk('', 0);
  files.sort((a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title));
  return { core, files };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: agent card lookup/validation and memory reader

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Routines (ncl) and activity (session DBs)

**Files:**
- Create: `src/sources/tasks.mjs`, `src/sources/activity.mjs`
- Test: `test/tasks.test.mjs`, `test/activity.test.mjs`

**Interfaces:**
- Consumes: `openReadOnly` (Task 5); `dayKey` (Task 2); `createInstall` (Task 5)
- Produces:
  - `createTaskSource({ ncl, groupsDir, execFileImpl?, timeoutMs? }) → { listForGroup(agentGroupId, folder) → Promise<TaskRow[]> }`, where `TaskRow = { series_id, status, schedule, runs, failed_runs, last_run, next_run, lastLog }`. There is **no `prompt`** field.
  - `lastLogLine(groupsDir, folder, rel) → string | null` (at most 140 characters)
  - `lastNDays(n, timezone, now) → string[]`, oldest first
  - `createActivitySource({ sessionsDir }) → { dailyCounts(agentGroupId, sessions, {days, timezone, now}) → DayCount[] }`, oldest first, where `DayCount = { date, conversations, messagesIn, messagesOut, routineRuns, routineFailures }`.

- [ ] **Step 1: Write the failing tests**

`test/tasks.test.mjs`:

```js
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
```

`test/activity.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`src/sources/tasks.mjs`:

```js
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function lastLogLine(groupsDir, folder, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const base = path.join(groupsDir, folder);
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  const clean = line.replace(/^[-*]\s+/, '');
  return clean.length > 140 ? `${clean.slice(0, 137)}…` : clean;
}

export function createTaskSource({ ncl, groupsDir, execFileImpl = execFile, timeoutMs = 5000 }) {
  const run = (args) =>
    new Promise((resolve, reject) => {
      execFileImpl(ncl, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(new Error(`ncl returned non-JSON output: ${parseErr.message}`));
        }
      });
    });

  return {
    async listForGroup(agentGroupId, folder) {
      const frame = await run(['tasks', 'list', '--group', agentGroupId, '--json']);
      if (!frame?.ok) throw new Error(`ncl tasks list failed: ${frame?.error?.message ?? 'unknown error'}`);
      return (frame.data ?? []).map((row) => ({
        series_id: row.series_id,
        status: row.status,
        schedule: row.schedule,
        runs: row.runs ?? 0,
        failed_runs: row.failed_runs ?? 0,
        last_run: row.last_run ?? null,
        next_run: row.next_run ?? null,
        lastLog: lastLogLine(groupsDir, folder, row.log),
      }));
    },
  };
}
```

`src/sources/activity.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { openReadOnly } from '../db.mjs';
import { dayKey } from '../present/schedule.mjs';

const DAY_MS = 86_400_000;
const CHAT_KINDS = new Set(['chat', 'chat-sdk']);

export function lastNDays(n, timezone, now) {
  const base = Date.parse(`${dayKey(now, timezone)}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(base - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

function readRows(file, sql, params) {
  if (!fs.existsSync(file)) return [];
  const db = openReadOnly(file);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export function createActivitySource({ sessionsDir }) {
  return {
    dailyCounts(agentGroupId, sessions, { days = 7, timezone, now = new Date() }) {
      const keys = lastNDays(days, timezone, now);
      const byDay = new Map(keys.map((date) => [date, { date, conversations: 0, messagesIn: 0, messagesOut: 0, routineRuns: 0, routineFailures: 0 }]));
      const since = new Date(Date.parse(`${keys[0]}T00:00:00Z`) - DAY_MS).toISOString();
      const bucket = (ts) => byDay.get(dayKey(new Date(ts), timezone));

      for (const session of sessions) {
        if (!session.lastActive || session.lastActive < since) continue;
        const dir = path.join(sessionsDir, agentGroupId, session.id);
        const active = new Set();
        const inbound = readRows(
          path.join(dir, 'inbound.db'),
          'SELECT kind, timestamp, status, process_after FROM messages_in WHERE timestamp >= ? OR process_after >= ?',
          [since, since],
        );
        for (const r of inbound) {
          if (CHAT_KINDS.has(r.kind)) {
            const d = bucket(r.timestamp);
            if (d) {
              d.messagesIn += 1;
              active.add(d);
            }
          } else if (r.kind === 'task' && (r.status === 'completed' || r.status === 'failed')) {
            const d = bucket(r.process_after ?? r.timestamp);
            if (d) {
              d.routineRuns += 1;
              if (r.status === 'failed') d.routineFailures += 1;
            }
          }
        }
        const outbound = readRows(path.join(dir, 'outbound.db'), 'SELECT kind, timestamp FROM messages_out WHERE timestamp >= ?', [since]);
        for (const r of outbound) {
          if (!CHAT_KINDS.has(r.kind)) continue;
          const d = bucket(r.timestamp);
          if (d) {
            d.messagesOut += 1;
            active.add(d);
          }
        }
        for (const d of active) d.conversations += 1;
      }
      return keys.map((k) => byDay.get(k));
    },
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: routines via ncl --json and per-day activity counts

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Cost estimate from transcripts

**Files:**
- Create: `src/sources/usage.mjs`
- Test: `test/usage.test.mjs`

**Interfaces:**
- Consumes: `dayKey` (Task 2); `createInstall` (Task 5)
- Produces:
  - `priceFor(model, prices) → price | null`: an exact key, or else the longest key that is a prefix of `model`.
  - `costUsd(record, prices) → number | null`
  - `lastNMonths(n, timezone, now) → ['YYYY-MM', …]`, oldest first
  - `createUsageSource({ sessionsDir }) → { monthlyCost(agentGroupId, { months = 6, timezone, now, prices, currency }) → { months: [{month, amount}], currency, estimate: true, unpriced: boolean } }`. `amount` is in the display currency (USD × `currency.rate`).

- [ ] **Step 1: Write the failing test**

`test/usage.test.mjs`:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createInstall } from './helpers/install.mjs';
import { createUsageSource, priceFor, costUsd, lastNMonths } from '../src/sources/usage.mjs';

const install = createInstall();
after(() => install.cleanup());
const now = new Date('2026-09-15T12:00:00Z');
const prices = { 'claude-haiku-4-5': { input: 1, output: 5 }, 'claude-opus-5': { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 } };
const currency = { code: 'ILS', symbol: '₪', rate: 4 };

const assistant = (id, model, timestamp, usage) => ({ type: 'assistant', timestamp, message: { id, model, usage, content: [{ type: 'text', text: 'PRIVATE' }] } });

install.writeTranscript('ag-1', '-workspace-agent/a.jsonl', [
  { type: 'user', timestamp: '2026-09-01T00:00:00Z', message: { content: 'hi' } },
  assistant('m1', 'claude-haiku-4-5-20251001', '2026-09-02T10:00:00Z', { input_tokens: 100000, output_tokens: 10 }),
  assistant('m1', 'claude-haiku-4-5-20251001', '2026-09-02T10:00:01Z', { input_tokens: 1000000, output_tokens: 100000 }),
  assistant('m2', 'claude-opus-5', '2026-08-20T10:00:00Z', {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 2000000,
    cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 },
  }),
  assistant('m3', 'mystery-model', '2026-09-03T10:00:00Z', { input_tokens: 5, output_tokens: 5 }),
  assistant('m4', 'claude-haiku-4-5', '2025-01-01T00:00:00Z', { input_tokens: 999999999, output_tokens: 0 }),
]);
install.writeTranscript('ag-1', '-workspace-agent/sub/agent-1.jsonl', [
  assistant('m5', 'claude-haiku-4-5', '2026-09-04T10:00:00Z', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000000 }),
]);

test('priceFor matches exact or longest prefix', () => {
  assert.equal(priceFor('claude-haiku-4-5-20251001', prices).input, 1);
  assert.equal(priceFor('other', prices), null);
});

test('costUsd defaults cache prices from input', () => {
  assert.equal(costUsd({ model: 'claude-haiku-4-5', input: 0, output: 0, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }, prices), 0.1 + 1.25 + 2);
});

test('lastNMonths crosses year boundaries', () => {
  assert.deepEqual(lastNMonths(3, 'UTC', new Date('2026-02-10T00:00:00Z')), ['2025-12', '2026-01', '2026-02']);
});

test('monthlyCost dedupes by message id (last line wins) and flags unpriced models', () => {
  const src = createUsageSource({ sessionsDir: install.sessionsDir });
  const r = src.monthlyCost('ag-1', { months: 2, timezone: 'UTC', now, prices, currency });
  // Sep: m1 final = 1M in * $1 + 100k out * $5 = $1.5 ; m5 = 1M cache write 5m * 1.25 = $1.25  → $2.75 * 4
  // Aug: m2 = 1M read * $1 + 1M 5m * $12.5 + 1M 1h * $20 = $33.5 * 4
  assert.deepEqual(r.months, [{ month: '2026-08', amount: 134 }, { month: '2026-09', amount: 11 }]);
  assert.equal(r.estimate, true);
  assert.equal(r.unpriced, true);
  assert.deepEqual(r.currency, currency);
});

test('unchanged files are served from cache', () => {
  const src = createUsageSource({ sessionsDir: install.sessionsDir });
  src.monthlyCost('ag-1', { months: 1, timezone: 'UTC', now, prices, currency });
  const first = src._parsedCount();
  src.monthlyCost('ag-1', { months: 1, timezone: 'UTC', now, prices, currency });
  assert.equal(src._parsedCount(), first);
});

test('agent with no transcripts costs zero', () => {
  const src = createUsageSource({ sessionsDir: install.sessionsDir });
  assert.deepEqual(src.monthlyCost('ag-none', { months: 1, timezone: 'UTC', now, prices, currency }).months, [{ month: '2026-09', amount: 0 }]);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`src/sources/usage.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { dayKey } from '../present/schedule.mjs';

export function priceFor(model, prices) {
  if (prices[model]) return prices[model];
  const key = Object.keys(prices).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? prices[key] : null;
}

export function costUsd(r, prices) {
  const p = priceFor(r.model, prices);
  if (!p) return null;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  const write5m = p.cacheWrite5m ?? p.cacheWrite ?? p.input * 1.25;
  const write1h = p.cacheWrite1h ?? p.cacheWrite ?? p.input * 2;
  return (r.input * p.input + r.output * p.output + r.cacheRead * cacheRead + r.cacheWrite5m * write5m + r.cacheWrite1h * write1h) / 1e6;
}

export function lastNMonths(n, timezone, now) {
  const [y, m] = dayKey(now, timezone).split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const idx = y * 12 + (m - 1) - (n - 1 - i);
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  });
}

function parseTranscript(file) {
  const byId = new Map();
  const anonymous = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o?.message?.usage;
    if (o.type !== 'assistant' || !u) continue;
    const cc = u.cache_creation;
    const record = {
      t: Date.parse(o.timestamp),
      model: o.message.model ?? 'unknown',
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite5m: cc ? cc.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0,
      cacheWrite1h: cc ? cc.ephemeral_1h_input_tokens ?? 0 : 0,
    };
    const id = o.message.id ?? o.requestId;
    if (id) byId.set(id, record);
    else anonymous.push(record);
  }
  return [...byId.values(), ...anonymous];
}

function listJsonl(root, depth = 0, out = []) {
  if (depth > 6 || !fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) listJsonl(abs, depth + 1, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(abs);
  }
  return out;
}

export function createUsageSource({ sessionsDir }) {
  const fileCache = new Map();
  let parsed = 0;

  function records(agentGroupId) {
    const root = path.join(sessionsDir, agentGroupId, '.claude-shared', 'projects');
    const files = listJsonl(root);
    const live = new Set(files);
    for (const key of fileCache.keys()) if (key.startsWith(root + path.sep) && !live.has(key)) fileCache.delete(key);
    const out = [];
    for (const file of files) {
      const st = fs.statSync(file);
      let entry = fileCache.get(file);
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        entry = { mtimeMs: st.mtimeMs, size: st.size, records: parseTranscript(file) };
        parsed += 1;
        fileCache.set(file, entry);
      }
      out.push(...entry.records);
    }
    return out;
  }

  return {
    monthlyCost(agentGroupId, { months = 6, timezone, now = new Date(), prices, currency }) {
      const keys = lastNMonths(months, timezone, now);
      const totals = new Map(keys.map((k) => [k, 0]));
      let unpriced = false;
      for (const r of records(agentGroupId)) {
        if (!Number.isFinite(r.t)) continue;
        const month = dayKey(new Date(r.t), timezone).slice(0, 7);
        if (!totals.has(month)) continue;
        const usd = costUsd(r, prices);
        if (usd === null) {
          if (r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h > 0) unpriced = true;
          continue;
        }
        totals.set(month, totals.get(month) + usd);
      }
      return {
        months: keys.map((month) => ({ month, amount: Math.round(totals.get(month) * currency.rate * 100) / 100 })),
        currency,
        estimate: true,
        unpriced,
      };
    },
    _parsedCount: () => parsed,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS. If an amount is off by floating-point rounding, keep the `Math.round(... * 100) / 100` in `monthlyCost`; do not loosen the test.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: monthly cost estimate from Claude transcripts

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Plugins

**Files:**
- Create: `src/plugins.mjs`
- Test: `test/plugins.test.mjs`

**Interfaces:**
- Produces:
  - `loadPlugins(paths) → Promise<Plugin[]>`. A `Plugin` is `{ name, capabilities?, resolveTools?, cost?, activity? }`. Throws if the default export is not an object with a `name`.
  - `resolveToolsVia(plugins, serverName, serverConfig, log?) → string[] | null`: the first array returned wins; a hook that throws is logged and skipped.
  - `callHook(plugins, hook, args, {timeoutMs = 5000, log}) → Promise<value | undefined>`: the first non-null result wins; a throw or timeout is logged and skipped.

- [ ] **Step 1: Write the failing test**

`test/plugins.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlugins, resolveToolsVia, callHook } from '../src/plugins.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-plugins-'));
const write = (name, src) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, src);
  return file;
};

test('loadPlugins imports default exports and validates them', async () => {
  const good = write('good.mjs', "export default { name: 'good', capabilities: [] };");
  const bad = write('bad.mjs', 'export default 42;');
  assert.equal((await loadPlugins([good]))[0].name, 'good');
  await assert.rejects(loadPlugins([bad]), /must default-export/);
});

test('resolveToolsVia: first array wins, throwing hooks are skipped', () => {
  const logs = [];
  const plugins = [
    { name: 'thrower', resolveTools() { throw new Error('boom'); } },
    { name: 'none', resolveTools() { return undefined; } },
    { name: 'allow', resolveTools: (name, cfg) => cfg.env.ALLOW.split(',') },
  ];
  assert.deepEqual(resolveToolsVia(plugins, 's', { env: { ALLOW: 'a,b' } }, (m) => logs.push(m)), ['a', 'b']);
  assert.match(logs[0], /thrower resolveTools failed: boom/);
  assert.equal(resolveToolsVia([], 's', {}), null);
});

test('callHook: first non-null result, timeouts and throws fall through', async () => {
  const logs = [];
  const plugins = [
    { name: 'slow', cost: () => new Promise(() => {}) },
    { name: 'thrower', async cost() { throw new Error('nope'); } },
    { name: 'null', cost: () => null },
    { name: 'real', cost: (agent, opts) => ({ byMonth: [{ month: opts.months[0], usd: 1 }] }) },
  ];
  const r = await callHook(plugins, 'cost', [{ id: 'a' }, { months: ['2026-09'] }], { timeoutMs: 20, log: (m) => logs.push(m) });
  assert.deepEqual(r, { byMonth: [{ month: '2026-09', usd: 1 }] });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /slow cost failed: timed out/);
  assert.equal(await callHook([], 'cost', []), undefined);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`src/plugins.mjs`:

```js
import { pathToFileURL } from 'node:url';

export async function loadPlugins(paths) {
  const plugins = [];
  for (const file of paths) {
    const mod = await import(pathToFileURL(file).href);
    const plugin = mod.default;
    if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string') {
      throw new Error(`Plugin ${file} must default-export an object with a string "name"`);
    }
    if (plugin.capabilities !== undefined && !Array.isArray(plugin.capabilities)) {
      throw new Error(`Plugin ${plugin.name}: capabilities must be an array`);
    }
    plugins.push(plugin);
  }
  return plugins;
}

export function resolveToolsVia(plugins, serverName, serverConfig, log = () => {}) {
  for (const p of plugins) {
    if (typeof p.resolveTools !== 'function') continue;
    try {
      const tools = p.resolveTools(serverName, serverConfig);
      if (Array.isArray(tools)) return tools.filter((t) => typeof t === 'string');
    } catch (err) {
      log(`plugin ${p.name} resolveTools failed: ${err.message}`);
    }
  }
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function callHook(plugins, hook, args, { timeoutMs = 5000, log = () => {} } = {}) {
  for (const p of plugins) {
    if (typeof p[hook] !== 'function') continue;
    try {
      const result = await withTimeout(Promise.resolve().then(() => p[hook](...args)), timeoutMs);
      if (result !== undefined && result !== null) return result;
    } catch (err) {
      log(`plugin ${p.name} ${hook} failed: ${err.message}`);
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: plugin loading and fault-isolated hooks

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Profile assembly

**Files:**
- Create: `src/sources/index.mjs`, `src/profile.mjs`
- Test: `test/profile.test.mjs`

**Interfaces:**
- Consumes: every source, `describeCapabilities` and `serversOf` (Task 4), `describeRoutine` (Task 2), `lastNMonths` (Task 9), `callHook` and `resolveToolsVia` (Task 10), `readAgentCard` and `resolveIconPath` (Task 7), `isValidTimezone` (Task 1).
- Produces:
  - `createSources(config) → Sources = { nanoclaw, card(folder), memory(folder), tasks, activity, usage }`
  - `computeInstallServices({ sources, catalogue, plugins, log }) → Set<string>`
  - `buildSummary(agent, ctx) → { folder, name, emoji, description, hasIcon, lastActive: string|null }`
  - `buildProfile(agent, ctx) → Profile`, where `ctx = { config, sources, plugins, catalogue, viewer: {isOwner}, installServices, now, log }` and:

```
Profile = {
  agent: {id, name, folder},
  cardProblem: boolean,                                 // owner only; false for members
  identity: { name, emoji, description, serves, voice, hasIcon, skills },
  capabilities: Section<{ can, cannot, noAccess, neverDoes, unknownCount, unknown /* [] for members */ }>,
  routines: Section<{ timezone, items: RoutineView[] }>,
  activity: Section<{ days: (DayCount & { services })[] /* newest first */ }>,
  memory: Section<{ core, files }>,
  cost: Section<{ months, currency, estimate, unpriced }> | null,   // null when hidden from this viewer
  instructions: Section<string|null> | null,                        // null for members
}
Section<T> = { ok: true, data: T } | { ok: false }
```

- [ ] **Step 1: Write the failing test**

`test/profile.test.mjs`:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createInstall } from './helpers/install.mjs';
import { createNanoclawSource } from '../src/sources/nanoclaw.mjs';
import { readAgentCard } from '../src/sources/card.mjs';
import { readMemory } from '../src/sources/memory.mjs';
import { createActivitySource } from '../src/sources/activity.mjs';
import { createUsageSource } from '../src/sources/usage.mjs';
import { buildProfile, buildSummary, computeInstallServices } from '../src/profile.mjs';

const install = createInstall();
install
  .addGroup({ id: 'ag-home', name: 'Home', folder: 'home', timezone: 'Asia/Jerusalem', mcpServers: { 'google-mcp': { command: 'node', env: { ALLOW: 'gcal_list,gmail_search', SECRET: 'SECRET_VALUE_123' } }, 'odd-server': {} } })
  .addGroup({ id: 'ag-ausie', name: 'Ausie', folder: 'ausie', mcpServers: { budget: { env: { ALLOW: 'ynab_get' } } } });
install.addSession({ id: 's1', agentGroupId: 'ag-home', lastActive: '2026-09-15T09:00:00.000Z' }).inbound({ timestamp: '2026-09-15T09:00:00.000Z' }).close();
install.writeGroupFile('home', 'agent-card.json', JSON.stringify({ name: 'Home', description: 'Runs the house', 'x-profile': { emoji: '🏠', neverDoes: ['Take sides'] }, skills: [{ name: 'Calendar', examples: ['What is on tomorrow?'] }] }));
install.writeGroupFile('home', 'instructions.prepend.md', '# Home persona');
install.writeGroupFile('ausie', 'agent-card.json', '{broken');
install.close();

const now = new Date('2026-09-15T12:00:00Z');
const config = { timezone: 'UTC', groupsDir: install.groupsDir, prices: {}, currency: { code: 'USD', symbol: '$', rate: 1 }, showCostToMembers: false };
const nanoclaw = createNanoclawSource(install.dbPath);
after(() => {
  nanoclaw.close();
  fs.rmSync(install.dir, { recursive: true, force: true });
});
const sources = {
  nanoclaw,
  card: (f) => readAgentCard(install.groupsDir, f),
  memory: (f) => readMemory(install.groupsDir, f),
  tasks: { listForGroup: async () => [{ series_id: 'brief-ab12', status: 'pending', schedule: '0 7 * * *', runs: 1, failed_runs: 0, last_run: null, next_run: '2026-09-16T04:00:00.000Z', lastLog: null }] },
  activity: createActivitySource({ sessionsDir: install.sessionsDir }),
  usage: createUsageSource({ sessionsDir: install.sessionsDir }),
};
const plugins = [{ name: 'allow', resolveTools: (n, cfg) => cfg.env?.ALLOW?.split(',') ?? undefined, activity: async (a, { days }) => ({ byDay: [{ date: days.at(-1), services: { Calendar: 2 } }] }) }];
const catalogue = [
  { match: 'gcal_*', service: 'Calendar', sentence: 'Reads your calendar' },
  { match: 'gmail_search', service: 'Email', sentence: 'Searches your email' },
  { match: 'gmail_send', service: 'Email', sentence: 'Sends email', cannot: 'Cannot send email' },
  { match: 'ynab_*', service: 'Budget', sentence: 'Checks your budget' },
];
const logs = [];
const base = { config, sources, plugins, catalogue, now, log: (m) => logs.push(m) };
const home = { id: 'ag-home', name: 'Home', folder: 'home' };

test('install services span every agent', () => {
  assert.deepEqual([...computeInstallServices(base)].sort(), ['Budget', 'Calendar', 'Email']);
});

test('member profile', async () => {
  const p = await buildProfile(home, { ...base, viewer: { isOwner: false }, installServices: computeInstallServices(base) });
  assert.equal(p.identity.name, 'Home');
  assert.equal(p.identity.emoji, '🏠');
  assert.deepEqual(p.capabilities.data.can.map((c) => c.service), ['Calendar', 'Email']);
  assert.deepEqual(p.capabilities.data.cannot, ['Cannot send email']);
  assert.deepEqual(p.capabilities.data.noAccess, ['Budget']);
  assert.deepEqual(p.capabilities.data.neverDoes, ['Take sides']);
  assert.equal(p.capabilities.data.unknownCount, 1);
  assert.deepEqual(p.capabilities.data.unknown, []);
  assert.equal(p.routines.data.timezone, 'Asia/Jerusalem');
  assert.equal(p.routines.data.items[0].schedule, 'Every day at 07:00');
  assert.equal(p.activity.data.days.length, 7);
  assert.deepEqual(p.activity.data.days[0].services, { Calendar: 2 });
  assert.equal(p.activity.data.days[0].messagesIn, 1);
  assert.equal(p.cost, null);
  assert.equal(p.instructions, null);
  assert.equal(p.cardProblem, false);
  assert.ok(!JSON.stringify(p).includes('SECRET_VALUE_123'));
});

test('owner profile adds cost, instructions and unknown names', async () => {
  const p = await buildProfile(home, { ...base, viewer: { isOwner: true }, installServices: new Set() });
  assert.equal(p.cost.ok, true);
  assert.equal(p.cost.data.months.length, 6);
  assert.equal(p.instructions.data, '# Home persona');
  assert.deepEqual(p.capabilities.data.unknown, [{ server: 'odd-server', tool: null }]);
});

test('a broken card still renders a profile with a fallback name', async () => {
  const p = await buildProfile({ id: 'ag-ausie', name: 'Ausie', folder: 'ausie' }, { ...base, viewer: { isOwner: true }, installServices: new Set() });
  assert.equal(p.identity.name, 'Ausie');
  assert.equal(p.cardProblem, true);
  assert.equal(p.capabilities.ok, true);
});

test('a failing source only fails its own section', async () => {
  const broken = { ...sources, tasks: { listForGroup: async () => { throw new Error('ncl down'); } } };
  const p = await buildProfile(home, { ...base, sources: broken, viewer: { isOwner: false }, installServices: new Set() });
  assert.deepEqual(p.routines, { ok: false });
  assert.equal(p.memory.ok, true);
  assert.ok(logs.some((l) => l.includes('ncl down')));
});

test('plugin cost replaces the estimate', async () => {
  const withCost = [...plugins, { name: 'ledger', cost: async (a, { months }) => ({ byMonth: [{ month: months.at(-1), usd: 2 }] }) }];
  const p = await buildProfile(home, { ...base, plugins: withCost, config: { ...config, currency: { code: 'ILS', symbol: '₪', rate: 4 } }, viewer: { isOwner: true }, installServices: new Set() });
  assert.equal(p.cost.data.estimate, false);
  assert.equal(p.cost.data.months.at(-1).amount, 8);
});

test('summary', async () => {
  const s = await buildSummary(home, { ...base, viewer: { isOwner: false } });
  assert.deepEqual(s, { folder: 'home', name: 'Home', emoji: '🏠', description: 'Runs the house', hasIcon: false, lastActive: 'today at 12:00' });
});
```

Note: `lastActive` for the summary is formatted in the agent's timezone (Asia/Jerusalem, UTC+3), so `09:00Z` is shown as `12:00`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/profile.mjs'".

- [ ] **Step 3: Implement**

`src/sources/index.mjs`:

```js
import { createNanoclawSource } from './nanoclaw.mjs';
import { readAgentCard } from './card.mjs';
import { readMemory } from './memory.mjs';
import { createTaskSource } from './tasks.mjs';
import { createActivitySource } from './activity.mjs';
import { createUsageSource } from './usage.mjs';

export function createSources(config) {
  return {
    nanoclaw: createNanoclawSource(config.dbPath),
    card: (folder) => readAgentCard(config.groupsDir, folder),
    memory: (folder) => readMemory(config.groupsDir, folder),
    tasks: createTaskSource({ ncl: config.ncl, groupsDir: config.groupsDir }),
    activity: createActivitySource({ sessionsDir: config.sessionsDir }),
    usage: createUsageSource({ sessionsDir: config.sessionsDir }),
  };
}
```

`src/profile.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { isValidTimezone } from './config.mjs';
import { describeCapabilities, serversOf } from './present/capabilities.mjs';
import { describeRoutine, formatWhen } from './present/schedule.mjs';
import { callHook, resolveToolsVia } from './plugins.mjs';
import { resolveIconPath } from './sources/card.mjs';
import { lastNMonths } from './sources/usage.mjs';

async function section(name, agent, log, fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    log(`[${agent.folder}] ${name}: ${err.stack ?? err.message}`);
    return { ok: false };
  }
}

function agentTimezone(containerConfig, config) {
  const tz = containerConfig?.timezone;
  return tz && isValidTimezone(tz) ? tz : config.timezone;
}

function tryCard(sources, folder, log) {
  try {
    return { info: sources.card(folder), problem: false };
  } catch (err) {
    log(`[${folder}] card: ${err.message}`);
    return { info: null, problem: true };
  }
}

export function computeInstallServices({ sources, catalogue, plugins, log = () => {} }) {
  const services = new Set();
  for (const group of sources.nanoclaw.listAgentGroups()) {
    const cc = sources.nanoclaw.getContainerConfig(group.id);
    const servers = serversOf(cc?.mcpServers ?? {}, (n, c) => resolveToolsVia(plugins, n, c, log));
    for (const { service } of describeCapabilities(servers, catalogue).can) services.add(service);
  }
  return services;
}

export async function buildSummary(agent, { config, sources, now = new Date(), log = () => {} }) {
  const { info } = tryCard(sources, agent.folder, log);
  const card = info?.card;
  let containerConfig = null;
  try {
    containerConfig = sources.nanoclaw.getContainerConfig(agent.id);
  } catch (err) {
    log(`[${agent.folder}] config: ${err.message}`);
  }
  let lastActive = null;
  try {
    const latest = sources.nanoclaw.listSessions(agent.id).map((s) => s.lastActive).filter(Boolean).sort().at(-1);
    lastActive = latest ? formatWhen(latest, { timezone: agentTimezone(containerConfig, config), now }) : null;
  } catch (err) {
    log(`[${agent.folder}] sessions: ${err.message}`);
  }
  return {
    folder: agent.folder,
    name: card?.name ?? containerConfig?.assistantName ?? agent.name,
    emoji: card?.['x-profile']?.emoji ?? null,
    description: card?.description ?? null,
    hasIcon: Boolean(resolveIconPath(info)),
    lastActive,
  };
}

export async function buildProfile(agent, ctx) {
  const { config, sources, plugins, catalogue, viewer, installServices = new Set(), now = new Date(), log = () => {} } = ctx;
  const run = (name, fn) => section(name, agent, log, fn);

  const containerConfig = await run('config', () => sources.nanoclaw.getContainerConfig(agent.id));
  const timezone = agentTimezone(containerConfig.ok ? containerConfig.data : null, config);
  const { info, problem } = tryCard(sources, agent.folder, log);
  const card = info?.card ?? null;
  const x = card?.['x-profile'] ?? {};

  const identity = {
    name: card?.name ?? (containerConfig.ok ? containerConfig.data?.assistantName : null) ?? agent.name,
    emoji: x.emoji ?? null,
    description: card?.description ?? null,
    serves: x.serves ?? null,
    voice: x.voice ?? null,
    hasIcon: Boolean(resolveIconPath(info)),
    skills: card?.skills ?? [],
  };

  const capabilities = await run('capabilities', () => {
    if (!containerConfig.ok) throw new Error('container config unavailable');
    const servers = serversOf(containerConfig.data?.mcpServers ?? {}, (n, c) => resolveToolsVia(plugins, n, c, log));
    const d = describeCapabilities(servers, catalogue, installServices);
    return {
      can: d.can,
      cannot: d.cannot,
      noAccess: d.noAccess,
      neverDoes: x.neverDoes ?? [],
      unknownCount: d.unknown.length,
      unknown: viewer.isOwner ? d.unknown : [],
    };
  });

  const routines = await run('routines', async () => {
    const rows = await sources.tasks.listForGroup(agent.id, agent.folder);
    const items = rows
      .map((r) => describeRoutine(r, { timezone, now }))
      .sort((a, b) => Number(a.paused) - Number(b.paused) || a.name.localeCompare(b.name));
    return { timezone, items };
  });

  const activity = await run('activity', async () => {
    const sessions = sources.nanoclaw.listSessions(agent.id);
    const days = sources.activity.dailyCounts(agent.id, sessions, { days: 7, timezone, now });
    const extra = await callHook(plugins, 'activity', [agent, { days: days.map((d) => d.date), timezone }], { log });
    const services = new Map((extra?.byDay ?? []).map((d) => [d.date, d.services]));
    return { days: days.map((d) => ({ ...d, services: services.get(d.date) ?? null })).reverse() };
  });

  const memory = await run('memory', () => sources.memory(agent.folder));

  const showCost = viewer.isOwner || config.showCostToMembers;
  const cost = showCost
    ? await run('cost', async () => {
        const months = lastNMonths(6, timezone, now);
        const fromPlugin = await callHook(plugins, 'cost', [agent, { months, timezone }], { log });
        if (Array.isArray(fromPlugin?.byMonth)) {
          const usd = new Map(fromPlugin.byMonth.map((m) => [m.month, m.usd]));
          return {
            months: months.map((month) => ({ month, amount: Math.round((usd.get(month) ?? 0) * config.currency.rate * 100) / 100 })),
            currency: config.currency,
            estimate: false,
            unpriced: false,
          };
        }
        return sources.usage.monthlyCost(agent.id, { months: 6, timezone, now, prices: config.prices, currency: config.currency });
      })
    : null;

  const instructions = viewer.isOwner
    ? await run('instructions', () => {
        const file = path.join(config.groupsDir, agent.folder, 'instructions.prepend.md');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      })
    : null;

  return {
    agent: { id: agent.id, name: agent.name, folder: agent.folder },
    cardProblem: viewer.isOwner && problem,
    identity,
    capabilities,
    routines,
    activity,
    memory,
    cost,
    instructions,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: assemble per-agent profile with per-section isolation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: HTML pages

**Files:**
- Create: `src/web/layout.mjs`, `src/web/pages.mjs`
- Test: `test/pages.test.mjs`

**Interfaces:**
- Consumes: `esc` (Task 1); `renderMarkdown` (Task 3); `formatMoney`, `monthLabel`, `dayLabel`, `activityLine`, `humanizeSlug` (Task 2); the `Profile` shape (Task 11).
- Produces:
  - `page({ title, body }) → string`: a full HTML document.
  - `renderHome({ viewer, agents: Summary[] }) → string`
  - `renderProfile(profile, { isOwner }) → string`
  - `renderMessage({ title, message }) → string`

- [ ] **Step 1: Write the failing test**

`test/pages.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement**

`src/web/layout.mjs`:

```js
import { esc } from '../escape.mjs';

const CSS = `
:root{--bg:#f7f6f3;--card:#fff;--text:#1f1f1f;--muted:#6b6b6b;--line:#e6e3dc;--accent:#2f6f4f;--warn:#9a4b00;--chip:#eef3ef}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--card:#202020;--text:#ececec;--muted:#a3a3a3;--line:#333;--accent:#7cc39c;--warn:#f0a35c;--chip:#23302a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
a{color:var(--accent)}
h1{font-size:1.6rem;margin:0}
h2{font-size:1.1rem;margin:0 0 12px}
h3,h4,h5,h6{font-size:1rem;margin:12px 0 4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:14px 0}
.muted{color:var(--muted)}
.hero{display:flex;gap:16px;align-items:center}
.avatar{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;font-size:2rem;background:var(--chip);flex:none;object-fit:cover}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.agent{display:block;text-decoration:none;color:inherit}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 0;padding:0;list-style:none}
.chips li{background:var(--chip);border-radius:999px;padding:4px 12px;font-size:.92rem}
.badge{display:inline-block;font-size:.75rem;border:1px solid var(--line);border-radius:6px;padding:0 6px;margin-left:6px;color:var(--muted)}
.warn{color:var(--warn)}
ul.plain{padding-left:18px;margin:4px 0}
.row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--line);padding:8px 0}
.row:first-child{border-top:0}
.bars{display:flex;gap:8px;align-items:flex-end;height:90px;margin-top:10px}
.bar{flex:1;text-align:center;font-size:.75rem;color:var(--muted)}
.bar span{display:block;background:var(--accent);border-radius:4px 4px 0 0;margin-bottom:4px;min-height:2px}
pre{white-space:pre-wrap;font-size:.85rem;background:var(--bg);padding:12px;border-radius:8px}
`;

export function page({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body><main>
${body}
</main></body>
</html>`;
}
```

`src/web/pages.mjs`:

```js
import { esc } from '../escape.mjs';
import { renderMarkdown } from '../present/markdown.mjs';
import { formatMoney, monthLabel, dayLabel, activityLine, humanizeSlug, pluralize } from '../present/format.mjs';
import { page } from './layout.mjs';

const UNAVAILABLE = `<p class="muted">Couldn't load right now.</p>`;
const card = (title, inner) => `<section class="card"><h2>${esc(title)}</h2>${inner}</section>`;
const sectionOr = (s, render) => (s?.ok ? render(s.data) : UNAVAILABLE);

function avatar({ folder, hasIcon, emoji, name }) {
  if (hasIcon) return `<img class="avatar" src="/agents/${esc(folder)}/icon" alt="">`;
  return `<div class="avatar" aria-hidden="true">${esc(emoji ?? (name ?? '?').slice(0, 1).toUpperCase())}</div>`;
}

export function renderMessage({ title, message }) {
  return page({ title, body: `<section class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p></section>` });
}

export function renderHome({ agents }) {
  const items = agents.map((a) => `
    <a class="card agent" href="/agents/${esc(a.folder)}">
      <div class="hero">${avatar(a)}<div><strong>${esc(a.name)}</strong>
      ${a.description ? `<div class="muted">${esc(a.description)}</div>` : ''}
      ${a.lastActive ? `<div class="muted">Last active ${esc(a.lastActive)}</div>` : ''}</div></div>
    </a>`).join('');
  return page({ title: 'Your agents', body: `<h1>Your agents</h1><div class="grid">${items}</div>` });
}

function renderIdentity(p) {
  const id = p.identity;
  const skills = id.skills.filter((s) => s.examples?.length);
  return `
    <div class="hero">${avatar({ folder: p.agent.folder, ...id })}<div>
      <h1>${esc(id.name)}</h1>
      ${id.description ? `<div>${esc(id.description)}</div>` : ''}
    </div></div>
    ${p.cardProblem ? `<p class="warn">This agent card has a problem and is being ignored. Run <code>nanoclaw-profiles check</code> for details.</p>` : ''}
    ${id.serves || id.voice ? card('About', `
      ${id.serves ? `<p><strong>Who it helps:</strong> ${esc(id.serves)}</p>` : ''}
      ${id.voice ? `<p><strong>How it talks:</strong> ${esc(id.voice)}</p>` : ''}`) : ''}
    ${skills.length ? card('Things you can ask', skills.map((s) => `
      <h3>${esc(s.name)}</h3>
      <ul class="chips">${s.examples.map((e) => `<li>“${esc(e)}”</li>`).join('')}</ul>`).join('')) : ''}`;
}

function renderCapabilities(c) {
  const can = c.can.length
    ? c.can.map((s) => `<h3>${esc(s.service)}</h3><ul class="plain">${s.sentences.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`).join('')
    : '<p class="muted">No connected services.</p>';
  const cannot = [
    ...c.cannot.map((x) => `<li>${esc(x)}</li>`),
    ...(c.noAccess.length ? [`<li>No access to: ${esc(c.noAccess.join(', '))}</li>`] : []),
    ...c.neverDoes.map((x) => `<li>${esc(x)}</li>`),
  ];
  const other = c.unknownCount
    ? `<p class="muted">${esc(pluralize(c.unknownCount, 'other tool'))} not described yet${c.unknown.length ? `: ${esc(c.unknown.map((u) => (u.tool ? `${u.server}/${u.tool}` : u.server)).join(', '))}` : ''}.</p>`
    : '';
  return `${can}${other}${cannot.length ? `<h3>What it can't do</h3><ul class="plain">${cannot.join('')}</ul>` : ''}`;
}

function renderRoutines(r) {
  if (!r.items.length) return '<p class="muted">No scheduled routines.</p>';
  const rows = r.items.map((i) => `
    <div class="row"><div>
      <strong>${esc(i.name)}</strong>${i.paused ? '<span class="badge">Paused</span>' : ''}
      <div>${esc(i.schedule)}</div>
      <div class="muted">${esc(i.lastRun)}${i.nextRun ? ` · ${esc(i.nextRun)}` : ''}</div>
      ${i.failures ? `<div class="warn">${esc(i.failures)}</div>` : ''}
      ${i.lastLog ? `<div class="muted">“${esc(i.lastLog)}”</div>` : ''}
    </div></div>`).join('');
  return `${rows}<p class="muted">Times are in ${esc(r.timezone)}.</p>`;
}

function renderActivity(a) {
  return a.days.map((d) => `<div class="row"><span>${esc(dayLabel(d.date))}</span><span class="muted">${esc(activityLine(d))}</span></div>`).join('');
}

function renderMemory(m) {
  const core = m.core ? renderMarkdown(m.core) : '<p class="muted">Nothing noted yet.</p>';
  const groups = new Map();
  for (const f of m.files) groups.set(f.folder, [...(groups.get(f.folder) ?? []), f]);
  const files = [...groups].map(([folder, list]) => `
    <h3>${esc(folder ? humanizeSlug(folder) : 'General')}</h3>
    <ul class="plain">${list.map((f) => `<li>${esc(f.title)}${f.type ? `<span class="badge">${esc(f.type)}</span>` : ''}${f.description ? ` <span class="muted">— ${esc(f.description)}</span>` : ''}</li>`).join('')}</ul>`).join('');
  return `${core}${files}<p class="muted">To correct something, tell the agent "forget that …".</p>`;
}

function renderCost(c) {
  const max = Math.max(...c.months.map((m) => m.amount), 0.01);
  const current = c.months.at(-1);
  const bars = c.months.map((m) => `<div class="bar"><span style="height:${Math.round((m.amount / max) * 70)}px"></span>${esc(monthLabel(m.month))}</div>`).join('');
  const note = c.estimate ? `This is an estimate${c.unpriced ? ' (some usage has no price set)' : ''}.` : '';
  return `<p><strong>This month:</strong> ${esc(formatMoney(current.amount, c.currency))}</p><div class="bars">${bars}</div>${note ? `<p class="muted">${esc(note)}</p>` : ''}`;
}

export function renderProfile(p, { isOwner }) {
  const body = `
    <p><a href="/">← All agents</a></p>
    ${renderIdentity(p)}
    ${card('What it can do', sectionOr(p.capabilities, renderCapabilities))}
    ${card('Routines', sectionOr(p.routines, renderRoutines))}
    ${card('Recent activity', sectionOr(p.activity, renderActivity))}
    ${card('What it knows', sectionOr(p.memory, renderMemory))}
    ${p.cost ? card('Cost', sectionOr(p.cost, renderCost)) : ''}
    ${isOwner && p.instructions ? card('For the owner', sectionOr(p.instructions, (text) => (text ? `<details><summary>Full instructions</summary><pre>${esc(text)}</pre></details>` : '<p class="muted">No instructions file.</p>'))) : ''}`;
  return page({ title: p.identity.name, body });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS. The test checks for `'agent card has a problem'`, which matches the text "This agent card has a problem"; keep that wording.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: server-rendered home and profile pages

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: HTTP server and `serve` command

**Files:**
- Create: `src/server.mjs`, `src/cli.mjs`
- Test: `test/server.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `createApp({ config, sources, plugins, catalogue, verifier, log?, now?, cache? }) → { handle(req, res) → Promise<void>, listen(port, host) → Promise<http.Server> }`
  - `SECURITY_HEADERS` object
  - CLI: `nanoclaw-profiles serve --config <file>`

Routes:
- `GET /healthz` → `200 ok`, with no auth and no data.
- `GET /` → the list of the viewer's agents.
- `GET /agents/<folder>` → that agent's profile.
- `GET /agents/<folder>/icon` → the agent's icon file.
- Any other path → `404`. Any method other than GET/HEAD → `405`.
- Login outcomes: an invalid token gets `403`; a failure to fetch the signing keys gets `503`; a verified email that isn't in `users` gets `200` with the "No agents yet" page.
- A folder the viewer can't see gets `404`.

- [ ] **Step 1: Write the failing test**

`test/server.test.mjs`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { householdInstall } from './helpers/install.mjs';
import { makeKeyPair, signJwt, fakeFetch } from './helpers/jwt.mjs';
import { createAccessVerifier } from '../src/auth.mjs';
import { createApp, SECURITY_HEADERS } from '../src/server.mjs';
import { validateConfig } from '../src/config.mjs';
import { createSources } from '../src/sources/index.mjs';
import { loadCatalogue } from '../src/catalogue.mjs';

const TEAM = 'team.cloudflareaccess.com';
const key = makeKeyPair('k1');
const install = householdInstall();
install.writeGroupFile('home', 'agent-card.json', JSON.stringify({ name: 'Home', iconUrl: 'a.png', 'x-profile': { emoji: '🏠' } }));
install.writeGroupFile('home', 'a.png', 'PNGDATA');
install.close();

let server;
let base;
before(async () => {
  const config = validateConfig({
    nanoclawDir: install.dir,
    ncl: '/bin/false',
    access: { teamDomain: TEAM, aud: 'aud' },
    users: { 'owner@x.com': 'wa:owner', 'spouse@x.com': 'wa:spouse', 'stranger@x.com': 'wa:stranger' },
    hiddenGroups: ['eval'],
  }, '/');
  const verifier = createAccessVerifier({ teamDomain: TEAM, aud: 'aud', fetchImpl: fakeFetch({ keys: [key.jwk] }) });
  const app = createApp({ config, sources: createSources(config), plugins: [], catalogue: loadCatalogue([]), verifier, log: () => {} });
  server = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  fs.rmSync(install.dir, { recursive: true, force: true });
});

const token = (email) => signJwt({ iss: `https://${TEAM}`, aud: ['aud'], email, exp: Date.now() / 1000 + 300 }, key);
const get = (path, email, init = {}) => fetch(base + path, { ...init, headers: email ? { 'cf-access-jwt-assertion': token(email) } : {} });

test('healthz needs no auth', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('no token is 403 with security headers', async () => {
  const res = await get('/');
  assert.equal(res.status, 403);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(k), v);
});

test('spouse sees only Home', async () => {
  const html = await (await get('/', 'spouse@x.com')).text();
  assert.ok(html.includes('/agents/home'));
  assert.ok(!html.includes('/agents/ausie'));
  assert.equal((await get('/agents/ausie', 'spouse@x.com')).status, 404);
  assert.equal((await get('/agents/eval', 'spouse@x.com')).status, 404);
});

test('owner sees hidden groups and profiles render', async () => {
  assert.equal((await get('/agents/eval', 'owner@x.com')).status, 200);
  const res = await get('/agents/home', 'owner@x.com');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Home'));
  assert.ok(html.includes("Couldn't load right now"), 'routines fail because ncl is /bin/false');
});

test('icon is served for visible agents', async () => {
  const res = await get('/agents/home/icon', 'spouse@x.com');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(await res.text(), 'PNGDATA');
  assert.equal((await get('/agents/ausie/icon', 'owner@x.com')).status, 404);
});

test('known email without groups gets the empty state', async () => {
  const html = await (await get('/', 'stranger@x.com')).text();
  assert.ok(html.includes('No agents yet'));
});

test('unknown email gets the no-agents page', async () => {
  const res = await get('/', 'nobody@x.com');
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('No agents yet'));
});

test('POST is 405, unknown path is 404', async () => {
  assert.equal((await get('/', 'owner@x.com', { method: 'POST' })).status, 405);
  assert.equal((await get('/nope', 'owner@x.com')).status, 404);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/server.mjs'".

- [ ] **Step 3: Implement**

`src/server.mjs`:

```js
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AuthError } from './auth.mjs';
import { createCache } from './cache.mjs';
import { resolveViewer } from './identity.mjs';
import { buildProfile, buildSummary, computeInstallServices } from './profile.mjs';
import { resolveIconPath } from './sources/card.mjs';
import { renderHome, renderMessage, renderProfile } from './web/pages.mjs';

export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
};

const ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const HTML = 'text/html; charset=utf-8';

function send(req, res, status, body, type = HTML, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createApp({ config, sources, plugins, catalogue, verifier, log = console.error, now = () => new Date(), cache = createCache() }) {
  const ctxBase = () => ({ config, sources, plugins, catalogue, now: now(), log });
  const notFound = (req, res) => send(req, res, 404, renderMessage({ title: 'Not found', message: "There's nothing here." }));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(req, res, 405, renderMessage({ title: 'Not allowed', message: 'This page is read-only.' }), HTML, { allow: 'GET, HEAD' });
    }
    if (url.pathname === '/healthz') return send(req, res, 200, 'ok', 'text/plain; charset=utf-8');

    let email;
    try {
      ({ email } = await verifier.verify(req.headers['cf-access-jwt-assertion']));
    } catch (err) {
      if (err instanceof AuthError) {
        return send(req, res, 403, renderMessage({ title: 'Please sign in', message: 'Open this page through its usual address so you can sign in.' }));
      }
      log(`auth unavailable: ${err.message}`);
      return send(req, res, 503, renderMessage({ title: 'Sign-in check unavailable', message: 'Please try again in a minute.' }));
    }

    const viewer = resolveViewer(email, { users: config.users, hiddenGroups: config.hiddenGroups, nanoclaw: sources.nanoclaw });
    if (!viewer || viewer.groups.length === 0) {
      return send(req, res, 200, renderMessage({ title: 'No agents yet', message: "You don't have any agents here yet. Ask the person who set this up to add you." }));
    }

    if (url.pathname === '/') {
      const agents = await Promise.all(viewer.groups.map((g) => cache.get(`summary:${g.id}`, () => buildSummary(g, ctxBase()))));
      return send(req, res, 200, renderHome({ viewer, agents }));
    }

    const m = /^\/agents\/([A-Za-z0-9._-]+)(\/icon)?\/?$/.exec(url.pathname);
    const agent = m && viewer.groups.find((g) => g.folder === m[1]);
    if (!agent) return notFound(req, res);

    if (m[2]) {
      let icon = null;
      try {
        icon = resolveIconPath(sources.card(agent.folder));
      } catch {
        icon = null;
      }
      if (!icon) return notFound(req, res);
      const type = ICON_TYPES[path.extname(icon).toLowerCase()];
      return send(req, res, 200, fs.readFileSync(icon), type, { 'cache-control': 'private, max-age=300' });
    }

    const role = viewer.isOwner ? 'owner' : 'member';
    const installServices = await cache.get('installServices', () => computeInstallServices(ctxBase()));
    const profile = await cache.get(`profile:${agent.id}:${role}`, () =>
      buildProfile(agent, { ...ctxBase(), viewer: { isOwner: viewer.isOwner }, installServices }));
    return send(req, res, 200, renderProfile(profile, { isOwner: viewer.isOwner }));
  }

  function listen(port, host) {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        log(err.stack ?? String(err));
        if (!res.headersSent) send(req, res, 500, renderMessage({ title: 'Something went wrong', message: 'Please try again.' }));
      });
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }

  return { handle, listen };
}
```

`src/cli.mjs`:

```js
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { loadPlugins } from './plugins.mjs';
import { loadCatalogue } from './catalogue.mjs';
import { createSources } from './sources/index.mjs';
import { createAccessVerifier } from './auth.mjs';
import { createApp } from './server.mjs';

const USAGE = `Usage:
  nanoclaw-profiles serve --config <config.json>
  nanoclaw-profiles check --config <config.json>
  nanoclaw-profiles check --templates <dir> [--plugin <file>]...`;

async function serve(configPath) {
  const config = loadConfig(configPath);
  const plugins = await loadPlugins(config.plugins);
  const catalogue = loadCatalogue(plugins);
  const sources = createSources(config);
  sources.nanoclaw.listAgentGroups();
  const verifier = createAccessVerifier(config.access);
  await verifier.init();
  const app = createApp({ config, sources, plugins, catalogue, verifier });
  await app.listen(config.port, '127.0.0.1');
  console.log(`nanoclaw-profiles listening on http://127.0.0.1:${config.port}`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { config: { type: 'string', short: 'c' }, templates: { type: 'string' }, plugin: { type: 'string', multiple: true } },
});

try {
  if (positionals[0] === 'serve') await serve(values.config ?? 'config.json');
  else if (positionals[0] === 'check') {
    const { runCheckCli } = await import('./check.mjs');
    process.exitCode = await runCheckCli(values);
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS, with all earlier tests still passing.

- [ ] **Step 5: Smoke-test the CLI**

Run: `chmod +x src/cli.mjs && node src/cli.mjs; echo "exit=$?"`
Expected: the usage text, then `exit=2`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: HTTP server with Access auth, routing and security headers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: `check` command

**Files:**
- Create: `src/check.mjs`
- Test: `test/check.test.mjs`

**Interfaces:**
- Consumes: `validateCard`, `readAgentCard`, `CardError`, `findCardFile` (Task 7); `describeCapabilities`, `serversOf` (Task 4); `loadPlugins`, `resolveToolsVia` (Task 10); `loadCatalogue` (Task 4); `loadConfig` (Task 1); `createNanoclawSource` (Task 5).
- Produces:
  - `checkTemplates(templatesDir, { plugins, catalogue }) → { errors: string[], warnings: string[] }`. It scans each subdirectory that contains a `plugin.json`, reading `mcp.json` (`{ mcpServers }`) and a root `agent-card.json`.
  - `checkInstall({ config, plugins, catalogue, nanoclaw }) → { errors, warnings }`
  - `runCheckCli({ config?, templates?, plugin? }) → Promise<exitCode 0|1|2>`

- [ ] **Step 1: Write the failing test**

`test/check.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/check.mjs'".

- [ ] **Step 3: Implement**

`src/check.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { validateCard, readAgentCard } from './sources/card.mjs';
import { describeCapabilities, serversOf } from './present/capabilities.mjs';
import { loadPlugins, resolveToolsVia } from './plugins.mjs';
import { loadCatalogue } from './catalogue.mjs';
import { loadConfig } from './config.mjs';
import { createNanoclawSource } from './sources/nanoclaw.mjs';

function toolErrors(name, mcpServers, { plugins, catalogue }) {
  const servers = serversOf(mcpServers, (n, c) => resolveToolsVia(plugins, n, c));
  return describeCapabilities(servers, catalogue).unknown.map((u) =>
    `${name}: no catalogue sentence for ${u.tool ? `${u.server}/${u.tool}` : `${u.server} (whole server)`}`);
}

export function checkTemplates(templatesDir, { plugins, catalogue }) {
  const errors = [];
  const warnings = [];
  for (const entry of fs.readdirSync(templatesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(templatesDir, entry.name);
    if (!entry.isDirectory() || !fs.existsSync(path.join(dir, 'plugin.json'))) continue;
    const cardFile = path.join(dir, 'agent-card.json');
    if (!fs.existsSync(cardFile)) warnings.push(`${entry.name}: no agent-card.json`);
    else {
      try {
        const problems = validateCard(JSON.parse(fs.readFileSync(cardFile, 'utf8')));
        if (problems.length) errors.push(`${entry.name}: agent-card.json: ${problems.join('; ')}`);
      } catch (err) {
        errors.push(`${entry.name}: agent-card.json: invalid JSON (${err.message})`);
      }
    }
    let mcpServers = {};
    const mcpFile = path.join(dir, 'mcp.json');
    if (fs.existsSync(mcpFile)) {
      try {
        mcpServers = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers ?? {};
      } catch (err) {
        errors.push(`${entry.name}: mcp.json: invalid JSON (${err.message})`);
      }
    }
    errors.push(...toolErrors(entry.name, mcpServers, { plugins, catalogue }));
  }
  return { errors, warnings };
}

export function checkInstall({ config, plugins, catalogue, nanoclaw }) {
  const errors = [];
  const warnings = [];
  for (const group of nanoclaw.listAgentGroups()) {
    try {
      if (!readAgentCard(config.groupsDir, group.folder)) warnings.push(`${group.folder}: no agent-card.json`);
    } catch (err) {
      errors.push(`${group.folder}: ${err.message}`);
    }
    const cc = nanoclaw.getContainerConfig(group.id);
    errors.push(...toolErrors(group.folder, cc?.mcpServers ?? {}, { plugins, catalogue }));
  }
  return { errors, warnings };
}

export async function runCheckCli({ config: configPath, templates, plugin = [] }) {
  let result;
  if (templates) {
    const plugins = await loadPlugins(plugin.map((p) => path.resolve(p)));
    result = checkTemplates(path.resolve(templates), { plugins, catalogue: loadCatalogue(plugins) });
  } else if (configPath) {
    const config = loadConfig(configPath);
    const plugins = await loadPlugins(config.plugins);
    const nanoclaw = createNanoclawSource(config.dbPath);
    try {
      result = checkInstall({ config, plugins, catalogue: loadCatalogue(plugins), nanoclaw });
    } finally {
      nanoclaw.close();
    }
  } else {
    console.error('check needs --templates <dir> or --config <file>');
    return 2;
  }
  for (const w of result.warnings) console.log(`! ${w}`);
  for (const e of result.errors) console.log(`✗ ${e}`);
  console.log(result.errors.length ? `${result.errors.length} problem(s) found.` : 'All good.');
  return result.errors.length ? 1 : 0;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: check command for templates and installs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Docs, example config and deployment unit

**Files:**
- Create: `README.md`, `config.example.json`, `deploy/nanoclaw-profiles.service.example`
- Test: `test/example-config.test.mjs`

**Interfaces:**
- Consumes: `validateConfig` (Task 1)

- [ ] **Step 1: Write the failing test**

`test/example-config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateConfig } from '../src/config.mjs';

test('config.example.json is valid and contains no real data', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const c = validateConfig(raw, '/etc/nanoclaw-profiles');
  assert.ok(Object.keys(c.users).every((e) => e.endsWith('@example.com')));
  assert.equal(c.access.teamDomain, 'your-team.cloudflareaccess.com');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`
Expected: FAIL with ENOENT for `config.example.json`.

- [ ] **Step 3: Write the files**

`config.example.json`. Prices are in USD per million tokens. The values below are illustrative, so replace them with the current published prices:

```json
{
  "port": 3200,
  "nanoclawDir": "/home/nanoclaw/nanoclaw",
  "timezone": "UTC",
  "access": {
    "teamDomain": "your-team.cloudflareaccess.com",
    "aud": "paste-the-application-audience-tag-here"
  },
  "users": {
    "owner@example.com": "whatsapp:15550000001",
    "partner@example.com": "whatsapp:15550000002"
  },
  "hiddenGroups": [],
  "showCostToMembers": false,
  "currency": { "code": "USD", "symbol": "$", "rate": 1 },
  "prices": {
    "claude-haiku-4-5": { "input": 1, "output": 5 },
    "claude-sonnet-5": { "input": 3, "output": 15 },
    "claude-opus-5": { "input": 5, "output": 25 }
  },
  "plugins": []
}
```

`deploy/nanoclaw-profiles.service.example`:

```ini
[Unit]
Description=nanoclaw-profiles (friendly agent profile pages)
After=network-online.target

[Service]
Type=simple
User=nanoclaw
WorkingDirectory=/opt/nanoclaw-profiles
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/nanoclaw-profiles/src/cli.mjs serve --config /etc/nanoclaw-profiles/config.json
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`README.md` should cover, in this order:
1. **What it is:** one paragraph, plus the four sections a person sees.
2. **Requirements:** NanoClaw v2, Node ≥ 22.13, and an authenticating Cloudflare Access application in front of the service.
3. **Install:** `git clone`, copy `config.example.json` to `/etc/nanoclaw-profiles/config.json`, and fill it in:
   - `users` maps each email to a NanoClaw user id; `ncl users list` shows the ids.
   - `access.aud` is the Application Audience (AUD) tag on the Access app's Overview tab.
4. **Agent cards:** the schema from spec §4.1, and where the file goes (`groups/<folder>/agent-card.json`, or the root of a template).
5. **Plugins:** the interface from spec §5, with a 15-line example `resolveTools` plugin.
6. **`check`:** both modes, and running it in CI.
7. **Security model:** the two locks, read-only access, what is never shown, and the recommended Access policy (an explicit list of allowed emails).
8. **License:** MIT.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS (full suite).

- [ ] **Step 5: End-to-end smoke test against a fixture install**

Run the following. It builds a fixture install, starts the server, and requests `/healthz` and `/`. It prints `200` for `/healthz` and `403` for `/`, because the unauthenticated request has no token.

```bash
node --disable-warning=ExperimentalWarning -e "
import('./test/helpers/install.mjs').then(async ({ householdInstall }) => {
  const i = householdInstall(); i.close();
  const { validateConfig } = await import('./src/config.mjs');
  const { createSources } = await import('./src/sources/index.mjs');
  const { loadCatalogue } = await import('./src/catalogue.mjs');
  const { createApp } = await import('./src/server.mjs');
  const config = validateConfig({ nanoclawDir: i.dir, access: { teamDomain: 't.example.com', aud: 'a' }, users: { 'a@example.com': 'wa:owner' } }, '/');
  const app = createApp({ config, sources: createSources(config), plugins: [], catalogue: loadCatalogue([]), verifier: { verify: async () => { throw new (await import('./src/auth.mjs')).AuthError('missing token'); } } });
  const s = await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + s.address().port;
  console.log((await fetch(base + '/healthz')).status, (await fetch(base + '/')).status);
  s.close();
});
"
```

Expected output: `200 403`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: README, example config and systemd unit

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## After v1: install repo follow-up (not part of this plan)

The first household deployment is a separate plan in the `ausie` repo (spec §11):
- agent cards for `ausie` and `home`;
- the Ausie plugin: `AUSIE_TOOL_ALLOW` → `resolveTools`, Ausie tool sentences, and cost/activity from the Supabase ledger through a new read-only role;
- the systemd unit;
- the Zero Trust tunnel hostname and Access application (click-by-click instructions);
- `nanoclaw-profiles check --templates agent/build --plugin profiles/ausie-plugin.mjs` in CI.

Write that plan once this package is merged.
