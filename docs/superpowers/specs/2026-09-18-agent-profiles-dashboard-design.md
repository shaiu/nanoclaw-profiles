# nanoclaw-profiles — design

Date: 2026-09-18
Status: approved in brainstorming, pending written-spec review

## 1. Problem

NanoClaw's official dashboard (`@nanoco/nanoclaw-dashboard`, installed by
`/add-dashboard`) is an operator console: tokens, cache-hit rate, sessions,
context windows, channels, logs. It says nothing a non-technical person can
use about *who an agent is*: its role, how it talks, what it can and cannot
do, what it does on a schedule, what it has done lately, what it knows, and
what it costs.

A survey of the ecosystem (2026-09-18) found nothing that fills this gap:
every NanoClaw/OpenClaw dashboard found (the official one,
niels-emmer/nanoclaw-dashboard, ClawMetry, mudrii/openclaw-dashboard,
openclaw-mission-control) is operator-oriented. The friendly UX that exists
(Lindy, custom-GPT pages) is SaaS and cannot read a NanoClaw install.

**Goal:** a read-only, per-person "agent profile" web app for any NanoClaw v2
install. The first deployment serves one household (an owner and a spouse,
with a personal agent and a shared household agent); the product itself is
generic and publishable.

## 2. Decisions taken

| Question | Decision |
|---|---|
| Audience | Household members first; generic, so any NanoClaw install can use it |
| Sections | Identity & personality · Can / can't do · Routines & recent activity · What it knows + cost |
| Access | Web behind Cloudflare Access (Google login); per-person visibility from NanoClaw's own roles |
| Read/write | Read-only in v1. Changes are made by talking to the agent |
| Language | English only |
| Approach | Standalone read-only service (not a fork of the official dashboard, not a static-site generator) |
| Coupling | Own repo, `nanoclaw-profiles`, MIT. Zero install-specific code; install-specific behaviour enters only through config and plugins |
| Plain-language text | Generated deterministically from data and a catalogue. No LLM at request time |
| Message contents | Never shown. Activity is counts only |

## 3. Architecture

```
Browser ──► <host> ──► Cloudflare Access (IdP login)
                            │  Cf-Access-Jwt-Assertion (signed JWT)
                            ▼
                 tunnel / reverse proxy ──► 127.0.0.1:<port>
                            │
            ┌───────────────┴────────────────┐
            │ nanoclaw-profiles (Node, SSR)  │
            │ read-only                      │
            └──┬────────────┬─────────────┬──┘
   NanoClaw    │            │             │  plugins (optional)
   v2.db (ro)  │  groups/<folder>/        │  e.g. an install's own
   ncl tasks   │  agent-card.json,        │  cost ledger / tool filter
   transcripts │  memory/                 │
```

The service is **read-only against every source**, binds to loopback only,
and relies on an authenticating proxy in front of it. v1 supports Cloudflare
Access as the proxy. The auth module is the seam for adding others later.

### 3.1 Units

Each unit has one job and is testable on its own.

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/config.mjs` | Load and validate `config.json`; resolve paths; load plugins | fs |
| `src/auth.mjs` | Verify the Access JWT (signature against cached JWKS, `aud`, `iss`, `exp`); return the verified email | node:crypto, fetch |
| `src/identity.mjs` | Email → NanoClaw user id (config map) → visible agent groups (roles/members) | sources/nanoclaw |
| `src/sources/nanoclaw.mjs` | Read `v2.db` read-only: agent_groups, container_configs, users, user_roles, agent_group_members, sessions, messaging groups | node:sqlite |
| `src/sources/tasks.mjs` | Routines via `ncl tasks list/get` (JSON) | child_process |
| `src/sources/sessions.mjs` | Per-day message counts from per-session `inbound.db`/`outbound.db` | node:sqlite |
| `src/sources/card.mjs` | Read and validate `groups/<folder>/agent-card.json` | fs |
| `src/sources/memory.mjs` | Read `groups/<folder>/memory/`: Core Memory section of `index.md` + concept-file titles/descriptions from frontmatter | fs |
| `src/sources/transcripts.mjs` | Token usage per day from Claude transcript JSONLs → cost via the price table | fs |
| `src/present/*.mjs` | Pure functions: tool → sentence, can't-do derivation, cron → English, run status → English, counts → activity lines, money formatting | none |
| `src/profile.mjs` | Assemble one agent's profile model from sources + plugins; isolate per-section failures | all sources, plugins |
| `src/web/*.mjs` | HTML templates: "My agents" grid, "Agent profile" page, error/empty pages | present |
| `src/server.mjs` | `node:http` routing, per-request auth, 30 s in-memory cache | all |
| `src/cli.mjs` | `nanoclaw-profiles serve` and `nanoclaw-profiles check` | all |

No web framework, no front-end build and **no runtime dependencies**. Pages
are server-rendered with inline CSS that is mobile-first and supports light
and dark themes. SQLite access uses the built-in `node:sqlite` module, so the
minimum Node version is **22.13**. The first deployment runs Node 22.23.2.

### 3.2 Request flow

1. Request arrives. `auth` verifies the JWT and gets the email. On failure the
   response is `403` with a plain page, and nothing else runs.
2. `identity` maps the email to a NanoClaw user. An unknown email gets a
   friendly "You don't have any agents here yet" page (200, no data).
3. `identity` computes the visible agent groups:
   - **owner** (`user_roles.role='owner'`) sees all agent groups;
   - **admin** sees the groups it is scoped to (global admin sees all);
   - **member** sees groups with an `agent_group_members` row.
   Groups listed in `config.hiddenGroups` are visible to owners only
   (e.g. an eval/test agent).
4. `/` renders the "My agents" grid. `/agents/<folder>` renders a profile.
   Requesting a group the person cannot see returns `404`, not `403`, so the
   response does not reveal that the group exists.
5. Each source result is cached for 30 s, keyed by source and group.

## 4. Data model — the profile

### 4.1 Agent card (`groups/<folder>/agent-card.json`)

Hand-authored. Follows the A2A AgentCard field names where they exist, plus an
`x-profile` extension for what A2A lacks. All fields are optional; the page
degrades to NanoClaw data when a field or the whole file is missing.

```json
{
  "name": "Home",
  "description": "Helps the family run the household — kids' schedule, shopping, the house.",
  "iconUrl": "avatar.png",
  "skills": [
    {
      "id": "calendar",
      "name": "Family calendar",
      "description": "Keeps the shared calendar up to date.",
      "examples": ["What's on tomorrow for the kids?", "Add swimming every Tuesday at 17:00"]
    }
  ],
  "x-profile": {
    "emoji": "🏠",
    "serves": "Both parents, in the shared WhatsApp group",
    "voice": "Short, warm, practical. Asks whose task it is when unclear.",
    "neverDoes": ["Take sides between parents", "Send email on anyone's behalf"]
  }
}
```

`iconUrl` is resolved relative to the group folder and served by the app
through an allow-listed image route (png/jpg/webp/svg, same folder only).

**Where the card is found.** The service looks first at
`groups/<folder>/agent-card.json`, which is how a bare group gets a card. If
that is missing, it takes the first match, in alphabetical order, of
`groups/<folder>/plugins/*/agent-card.json`. NanoClaw's template stamping
copies the whole template directory to `groups/<folder>/plugins/<template>/`
(`src/templates/create-agent.ts`), so a template that ships a card at its root
provides one with **no NanoClaw change**.

### 4.2 Capabilities (can / can't do)

Source of truth: `container_configs.mcp_servers` for the group. That is what
the container actually runs with, so the page cannot claim a tool the agent
does not have.

1. For each configured MCP server, determine its tools:
   - default: the server as a whole, described by the catalogue entry that
     matches the server name or command;
   - if a plugin's `resolveTools(serverName, serverConfig)` returns a list,
     use exactly that list (per-tool granularity).
2. Map each tool, or the whole server, through the **capability catalogue**
   (`catalogue/capabilities.json` shipped with the package, merged with plugin
   `capabilities`, with plugin entries taking precedence). Each entry has:
   - `match`: a tool-name glob, for per-tool entries;
   - or `server`: a server-name glob, for whole-server entries;
   - `service`: e.g. "Calendar";
   - `sentence`: e.g. "Reads and changes events on your calendar";
   - optionally `cannot`: the sentence shown when this entry is *not*
     allowed, e.g. "Cannot send or reply to email".
3. **Can do** = sentences grouped by service.
4. **Can't do** has three parts:
   - the `cannot` sentence of each catalogue entry that is in a service the
     agent partly has but is not itself allowed. Example: Email read tools are
     allowed and send tools are not, which gives "Cannot send or reply to
     email".
   - "No access to: Budget, Smart home". These are services that *another
     agent in the same install* has and this one does not. This keeps the
     list meaningful and short.
   - the card's `x-profile.neverDoes` lines.
   Tools or servers with no catalogue entry are counted as "N other tools".
   Their raw names are shown to owners only; `check` flags them.
5. Environment values in `mcp_servers` are **never** rendered. Plugins
   receive the server config to parse allow-lists; the core only reads server
   names and commands.

### 4.3 Routines

From `ncl tasks list --group <id> --json`. `--json` is a flag every `ncl`
command accepts. It returns the frame `{id, ok, data, human}`, where each row
of `data` has `series_id`, `status`, `schedule` (a cron expression or
`once`), `runs`, `failed_runs`, `last_run`, `next_run` and `log` (the run-log
path relative to the group folder). Tasks have no separate name field: the
name is the slug of `series_id` (`<slug>-<4hex>`), shown in readable form
("proactive-brief-dec7" becomes "Proactive brief"). The task prompt is
**never** shown. Cron schedules are described in the agent's timezone
(`container_configs.timezone`, falling back to `config.timezone`). Each
routine renders:

- schedule in English, in the install's timezone: "Every weekday at 07:30",
  or "Once, on 14 Jul at 18:00";
- task name;
- last run: "Last ran today at 07:30", plus "N of M runs failed" when
  `failed_runs > 0`, plus the last line of the run log (truncated to 140
  characters);
- next run;
- a "Paused" badge when paused.

### 4.4 Recent activity (counts only)

For the last 7 days, per day: conversations (sessions active that day),
messages handled (inbound/outbound counts), routine runs and failures.
Plugins may add tool usage by service ("used Calendar ×3, Notion ×5"). No
message text, sender content, or tool arguments are ever read into the page
model.

### 4.5 What it knows

From `groups/<folder>/memory/`:

- the **Core Memory** section of `index.md`, rendered as Markdown (sanitised,
  no raw HTML);
- every other concept file listed by folder, excluding `index.md`, `log.md`
  and the `system/` folder. Each shows a title (the first `#` heading, or the
  file name in readable form), its OKF frontmatter `type` as a badge, and the
  frontmatter `description` if there is one. The file body is not shown.
- the footer hint: *To correct something, tell the agent "forget that …"*.

### 4.6 Cost

- **Core:** per-day token usage summed from the group's Claude transcript
  JSONLs (`data/v2-sessions/<ag-id>/.claude-shared/projects/**/*.jsonl`).
  Only `type:"assistant"` lines count, using `message.model` and
  `message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  and `cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens`, falling back to `cache_creation_input_tokens`
  as 5m. Lines are **deduplicated by `message.id`**, because one API response
  can span several lines. Per-file aggregates are cached by (path, mtime,
  size), so unchanged files are not re-read. The totals are multiplied by a per-model price
  table in config (`prices`, USD per million tokens), and converted to display
  currency at `currency.rate`. Shows "This month: ₪X" and a small bar for each
  of the last 6 months. Labelled "estimate".
- **Plugin override:** a plugin `cost(agent, range)` replaces the estimate. The
  label then drops "estimate".
- Visible to owners always; to members only if `showCostToMembers: true`,
  which defaults to false.

## 5. Plugin interface

A plugin is an ES module path listed in `config.plugins`. All hooks are
optional and may be async.

```js
export default {
  name: 'example',
  capabilities: [ { match: 'gcal_*', service: 'Calendar', sentence: '…' } ],
  resolveTools(serverName, serverConfig) { /* string[] | undefined */ },
  async cost(agent, { from, to }) { /* { byMonth: [{month, amount}], currency } | undefined */ },
  async activity(agent, { from, to }) { /* { byDay: [{date, services: {Calendar: 3}}] } | undefined */ },
};
```

`agent` is `{ id, folder, name }`. A hook that throws or times out (5 s) is
treated as `undefined`, and its section falls back to core data or shows
"Couldn't load right now". Plugins run in-process; they are trusted code chosen
by the install owner.

## 6. Configuration (`config.json`)

```json
{
  "port": 3200,
  "nanoclawDir": "/home/user/nanoclaw",
  "ncl": "/home/user/nanoclaw/bin/ncl",
  "timezone": "Asia/Jerusalem",
  "access": { "teamDomain": "example.cloudflareaccess.com", "aud": "<app AUD tag>" },
  "users": { "person@example.com": "whatsapp:972500000000" },
  "hiddenGroups": ["eval"],
  "showCostToMembers": false,
  "currency": { "code": "ILS", "symbol": "₪", "rate": 3.7 },
  "prices": { "claude-opus-5": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
  "plugins": ["/path/to/plugin.mjs"]
}
```

`timezone` defaults to NanoClaw's installation timezone when omitted. The
price values above are placeholders. `config.example.json` ships with
documented fields and no personal data. `config.json` is gitignored.

## 7. Error handling

- **Per-section isolation:** each section is built independently. A failing
  source renders "Couldn't load right now" for that card only. Details go to
  stderr (journald), never to the page.
- **Startup validation:** bad config, an unreadable `v2.db`, or an
  unreachable JWKS on first fetch cause the process to exit non-zero with a
  clear message, so systemd shows it.
- **Stale JWKS:** keys are cached and refetched on an unknown `kid`, at most
  once per minute.
- `v2.db` is opened with `readOnly`. `SQLITE_BUSY` is retried briefly, then
  the section fails in isolation.

## 8. Security

- **Two locks:** Access must admit the person *and* the email must be in
  `config.users`. An Access misconfiguration alone does not expose data.
- The JWT is always verified. A request from loopback without a valid token
  gets `403`; there is no trust by source IP.
- Read-only everywhere. No secrets, env values, message contents, or tool
  arguments reach the page model.
- Output escaping everywhere, and Markdown is rendered without raw HTML.
  Response headers include a CSP with no external scripts,
  `X-Content-Type-Options`, and `Referrer-Policy: no-referrer`.
- `404` for groups the person cannot see.

## 9. `nanoclaw-profiles check`

A CLI for install CI. It loads config and plugins, then for each agent group
(or a given templates dir) it reports:

- an invalid or malformed `agent-card.json`;
- configured tools or servers with no catalogue sentence, so raw names never
  reach the page;
- cards with more than 5 `skills[].examples` per skill, or any example longer than 120 characters.

It exits non-zero on any error.

## 10. Testing

`node --test`, fixture-driven. No test touches a real install.

- **present/**: cron → English across patterns and the timezone; catalogue
  matching (exact, glob, server-level); can't-do derivation; money formatting;
  activity lines.
- **identity**: owner / global admin / scoped admin / member / unknown email /
  hidden group, against a fixture SQLite created from NanoClaw's real schema
  DDL.
- **auth**: a locally generated RSA key and JWKS covering valid, expired,
  wrong `aud`, wrong `iss`, bad signature, unknown `kid`, and a missing
  header.
- **sources**: fixture `v2.db`, session DBs, transcripts, memory folder, and
  card. A fake `ncl` script emits canned JSON.
- **profile**: one source throws, and the page still renders the rest; a
  plugin hook throws or times out, and the page falls back.
- **web**: snapshot-free assertions that key text is present, contents are
  escaped, and no env values appear.
- **check CLI**: fixtures for a missing sentence and a malformed card.

## 11. First deployment (lives in the install's own repo, not here)

For the first household install, the install repo (`ausie`) adds:

- `agent/template/{ausie,home}/agent-card.json`;
- a plugin that parses `AUSIE_TOOL_ALLOW` from each server config
  (`resolveTools`), supplies sentences for its own tools, and reads cost and
  tool usage from its existing Supabase ledger through a **new read-only
  Postgres role** limited to SELECT on the ledger tables;
- `config.json` on the VPS (not committed), a systemd unit, and an install
  script in the style of its existing `host/deploy` units;
- a tunnel ingress rule `agents.<domain> → 127.0.0.1:3200` and a Cloudflare
  Access application with a Google IdP and an email allow-list. These are
  manual dashboard steps, delivered as click-by-click instructions;
- a CI step running `nanoclaw-profiles check`.

That work gets its own plan in the install repo once this package's v1 exists.

## 12. Out of scope (v1)

Editing anything, LLM-written summaries, message contents, localisation,
notifications, proxies other than Cloudflare Access, and packaging as a
NanoClaw `/add-profiles` skill. The skill is the intended distribution path
once v1 is stable.

## 13. Planning-time checks (resolved 2026-09-18)

1. The VPS runs Node v22.23.2 and `node:sqlite` loads, with an
   ExperimentalWarning that the unit silences with
   `--disable-warning=ExperimentalWarning`. **No `better-sqlite3`.**
2. `ncl tasks list --json` works (global flag); the frame shape is in §4.3.
   **No upstream change.**
3. Template stamping copies the whole plugin dir to `groups/<f>/plugins/<t>/`.
   **No upstream change;** the card lookup is in §4.1.
4. Session DBs are at `data/v2-sessions/<ag-id>/<session-id>/{inbound,outbound}.db`.
   - Chat messages are `messages_in.kind IN ('chat','chat-sdk')` and
     `messages_out.kind IN ('chat','chat-sdk')`.
   - Routine runs are `messages_in.kind='task'` with status
     `completed`/`failed`, bucketed by `process_after`.
   - Only sessions whose central `sessions.last_active` falls in the window
     are opened.
5. The transcript usage shape is recorded in §4.6.
6. The first install's Cloudflare Tunnel is remotely managed (token only, no
   local `config.yml`). The ingress rule is therefore added in the Zero Trust
   dashboard, which belongs to the install plan, not this package.
