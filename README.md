# nanoclaw-profiles

`nanoclaw-profiles` is a small, read-only web app that turns a NanoClaw
install into friendly profile pages for each agent — so the people who live
with an agent can see what it does without reading its config or its logs.
Each agent's page shows four sections:

- **What it can do** (and can't) — plain-English sentences generated from the
  agent's actual configured tools; a tool with no sentence is counted as "N
  other tools" (owners also see its name).
- **Routines** — its scheduled tasks, in plain English, with last/next run.
- **Recent activity** — counts only (conversations, messages, routine runs)
  for the last 7 days. No message text, ever.
- **What it knows** — the agent's Core Memory, shown in full as rendered
  Markdown, plus its other memory files, each listed by title, type and
  description only — never the body of those other files.

Owners (and, if enabled, other members) additionally see an estimated
**Cost** section. Owners alone see a **For the owner** section with the
agent's full instructions.

## Requirements

- A NanoClaw v2 install. Most data comes from reading its SQLite database,
  group folders and Claude transcript files directly. The **Routines**
  section is the exception: it runs `ncl tasks list --group <id> --json`
  (`bin/ncl` inside the NanoClaw install, which shells out to
  `pnpm exec tsx …` over NanoClaw's local socket), so the NanoClaw service
  itself must be running, and `pnpm` must be on the **PATH of the account
  that runs `nanoclaw-profiles`** (see the systemd unit's commented
  `Environment=PATH=…` line) — not just on the NanoClaw service's PATH.
- Node.js ≥ 22.13.
- A Cloudflare Access application placed in front of the service. Access
  handles authentication; `nanoclaw-profiles` never accepts unauthenticated
  requests.

## Install

```bash
git clone https://github.com/example/nanoclaw-profiles.git
cd nanoclaw-profiles
npm install --omit=dev   # no runtime dependencies today, but future-proof
sudo mkdir -p /etc/nanoclaw-profiles
sudo cp config.example.json /etc/nanoclaw-profiles/config.json
sudo $EDITOR /etc/nanoclaw-profiles/config.json
```

Fill in `config.json`:

- `nanoclawDir` — the absolute path to the NanoClaw install (the directory
  that contains `data/v2.db` and `groups/`).
- `users` — maps each person's email address to their NanoClaw user id, e.g.
  `"owner@example.com": "whatsapp:15550000001"`. Run `ncl users list` inside
  the NanoClaw install to see the ids; a person only sees the agent groups
  their id belongs to.
- `access.teamDomain` — your Cloudflare Access team domain, e.g.
  `your-team.cloudflareaccess.com`.
- `access.aud` — the **Application Audience (AUD) tag** of the Access
  application you put in front of this service. Find it on the
  application's **Overview** tab in the Zero Trust dashboard.
- `prices` — USD per million tokens, per model, used to estimate cost. Keep
  these current with the published prices for the models the install uses.
- `currency` — the display currency for the Cost section; token totals are
  computed in USD and converted at `currency.rate`.
- `plugins` — absolute paths to plugin modules (see below). Leave empty for
  a plain install.
- `port` — the port the app listens on (default `3200`).
- `timezone` — the install's default IANA timezone (default `UTC`), used
  for routines, activity and cost. An individual agent's own
  `container_configs.timezone`, when set and valid, wins over this default
  for that agent's page.
- `hiddenGroups` — an array of group folder names to hide from the "Your
  agents" list for everyone, owners included (e.g. an eval/test agent
  stamped from the same template, so it would otherwise show a duplicate
  card). Owners can still open a hidden group's profile directly at its
  `/agents/<folder>` URL; non-owners get a 404 there, same as any other
  group they can't see.
- `showCostToMembers` — whether non-owner members also see the Cost
  section (default `false`; owners see it either way).
- `ncl` — absolute path to NanoClaw's `ncl` binary, used for the Routines
  section. Defaults to `<nanoclawDir>/bin/ncl`; set this only if your
  install keeps it somewhere else.
- `nclTimeoutMs` — how long to wait for `ncl tasks list` before giving up
  on the Routines section for that request (default `15000`, minimum
  `1000`). Raise it if `ncl` is consistently slow on your install.

`config.json` holds no secrets itself, but keep it out of version control —
it lists real people's emails and NanoClaw user ids.

Run it directly to check the config:

```bash
node --disable-warning=ExperimentalWarning src/cli.mjs serve --config /etc/nanoclaw-profiles/config.json
```

or install the systemd unit (see **Deployment** below).

## Agent cards

An agent's name, description, icon and skills come from a hand-authored
`agent-card.json`, following the A2A `AgentCard` field names plus an
`x-profile` extension for what A2A doesn't cover:

```json
{
  "name": "Home",
  "description": "Helps the household run day to day.",
  "iconUrl": "avatar.png",
  "skills": [
    {
      "id": "calendar",
      "name": "Calendar",
      "description": "Keeps the shared calendar up to date.",
      "examples": ["What's on tomorrow?", "Add piano every Tuesday at 17:00"]
    }
  ],
  "x-profile": {
    "emoji": "🏠",
    "serves": "Everyone in the shared group",
    "voice": "Short, warm, practical.",
    "neverDoes": ["Send email on anyone's behalf"]
  }
}
```

All fields are optional; a missing field, or a missing file, makes the page
fall back to plain NanoClaw data. `iconUrl` is a path relative to the card's
own folder, and must point at a `.png`, `.jpg`, `.jpeg`, `.webp` or `.svg`
file in that same folder.

**Where the file goes.** The app looks first at the first match,
alphabetically, of `groups/<folder>/plugins/*/agent-card.json` — that's how
a NanoClaw template gets a card for free: if the template ships an
`agent-card.json` at the root of its own directory, every group created
from that template has a profile with no NanoClaw change at all. Only when
no template card exists does it fall back to a hand-authored
`groups/<folder>/agent-card.json` placed directly in the group folder. The
template card wins on purpose: it's the read-only, install-managed one, so
a group's own writable folder can't silently override it.

## Plugins

A plugin is an ES module path listed in `config.plugins`. Its default export
is an object with a `name` and any of these optional hooks:

- `resolveTools` is called **synchronously** and must return a plain
  `string[]` (or `undefined` to fall back to describing the server as a
  whole) — an async function or a Promise return value is not awaited, so
  it is treated as `undefined` and silently ignored.
- `cost` and `activity` may be async, and each gets a 5-second timeout; a
  hook that throws or is still pending after 5 seconds is treated as if it
  returned nothing.

```js
export default {
  name: 'example',
  capabilities: [{ match: 'gcal_*', service: 'Calendar', sentence: '…' }],
  resolveTools(serverName, serverConfig) {
    // Synchronous. Return string[] of tool names for this MCP server, or
    // undefined to fall back to describing the server as a whole.
  },
  async cost(agent, { months, timezone }) {
    // Replace the estimated cost with real figures from your own ledger.
  },
  async activity(agent, { days, timezone }) {
    // Add per-service tool-usage counts to the Recent activity section.
  },
};
```

A 15-line example that turns an allow-list environment variable into
per-tool names, so the capability catalogue can describe them individually:

```js
// profiles/allowlist-plugin.mjs
export default {
  name: 'allowlist',
  resolveTools(serverName, serverConfig) {
    if (serverName !== 'my-mcp-server') return undefined;
    const raw = serverConfig?.env?.MY_TOOL_ALLOW;
    if (!raw) return undefined;
    return raw.split(',').map((t) => t.trim()).filter(Boolean);
  },
  capabilities: [
    { match: 'send_*', service: 'Messaging', sentence: 'Sends messages on your behalf' },
    { match: 'read_*', service: 'Messaging', sentence: 'Reads your messages' },
  ],
};
```

`agent` passed to `cost` and `activity` is `{ id, folder, name }`. `cost`
returns `{ byMonth: [{ month: '2026-09', usd: 12.3, unpricedCalls: 0 }, …] }`,
where `unpricedCalls` is optional and, when greater than zero for any month,
makes the page say the total is incomplete. `activity`
returns `{ byDay: [{ date: '2026-09-12', services: { Calendar: 3 } }, …] }`.
Plugins run in-process and are trusted code chosen by the install owner —
they are not sandboxed.

## `check`

`nanoclaw-profiles check` is a CI tool. It reports (and exits non-zero on)
any agent card that's malformed, any configured tool or server with no
catalogue sentence (so a raw tool name never reaches the page), and any
skill with more than 5 examples or an example longer than 120 characters.

Two modes:

```bash
# Check a live install's groups against its real container configs.
nanoclaw-profiles check --config /etc/nanoclaw-profiles/config.json

# Check a directory of NanoClaw templates (each a subdirectory with a
# plugin.json) before they're ever installed, optionally loading plugins
# so resolveTools/capabilities are taken into account.
nanoclaw-profiles check --templates path/to/templates --plugin profiles/allowlist-plugin.mjs
```

In CI, run the templates form against the templates directory in the repo
that defines them, and fail the build on a non-zero exit code:

```yaml
- run: node --disable-warning=ExperimentalWarning src/cli.mjs check --templates agent/templates --plugin profiles/allowlist-plugin.mjs
```

## Security model

Every request needs **two locks** to open, and losing either one keeps the
page closed:

1. **Cloudflare Access** must admit the person (their JWT is verified on
   every request; there's no bypass for requests from loopback).
2. Their verified email must also be a key in `config.users`. An Access
   misconfiguration alone — anyone the team lets through — does not expose
   any agent's data by itself.

Beyond that:

- Everything is **read-only**. The app never writes to the NanoClaw
  database, group folders, or anywhere else.
- Nothing sensitive ever reaches the page: no secrets or environment values
  from MCP server configs, no message text or sender content, no tool
  arguments, no task prompts. Activity and cost are shown as counts and
  totals only. A configured tool or server with no catalogue sentence is
  counted as "N other tools" for everyone, but owners additionally see the
  raw tool/server names themselves (never their arguments or output) — the
  `check` command flags these so they get a real sentence instead.
- Output is escaped everywhere, and Markdown (in "What it knows") is
  rendered without raw HTML. Responses carry a strict Content-Security-Policy
  with no external scripts, `X-Content-Type-Options: nosniff`, and
  `Referrer-Policy: no-referrer`.
- A person gets a plain `404` for any agent group they're not a member of —
  the page never reveals that a group exists.

**Recommended Access policy:** configure the Access application with an
explicit **Include: Emails** rule listing exactly the addresses that also
appear in `config.users` — not a broader rule like "everyone in this
domain". That keeps the two locks aligned, but it also means **both** lists
need updating when someone joins or leaves: add (or remove) their email in
the Access policy's Include rule *and* as a key in `config.users`. Either
one alone leaves them locked out (Access admits them but `config.users`
doesn't recognise them, or vice versa) rather than over-exposed, but both
still need to be kept in sync by hand.

## Deployment

Copy `deploy/nanoclaw-profiles.service.example` to
`/etc/systemd/system/nanoclaw-profiles.service`, adjust the paths and user
if needed, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nanoclaw-profiles
```

The service runs as an unprivileged `nanoclaw` user with `ProtectSystem`,
`ProtectHome` and `PrivateTmp` enabled, and only listens on `127.0.0.1` —
put it behind the Cloudflare Access application (e.g. via `cloudflared`) so
the two-lock model above actually applies.

## License

MIT. See [LICENSE](./LICENSE).
