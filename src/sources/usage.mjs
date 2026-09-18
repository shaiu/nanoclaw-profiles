import fs from 'node:fs';
import path from 'node:path';
import { dayKey } from '../present/schedule.mjs';
import { realDirInside } from '../fs-safe.mjs';

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
    const id = o.message.id ?? o.requestId ?? null;
    const record = {
      id,
      t: Date.parse(o.timestamp),
      model: o.message.model ?? 'unknown',
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite5m: cc ? cc.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0,
      cacheWrite1h: cc ? cc.ephemeral_1h_input_tokens ?? 0 : 0,
    };
    if (id) byId.set(id, record);
    else anonymous.push(record);
  }
  return [...byId.values(), ...anonymous];
}

function listJsonl(root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // The session dir, like the group folder, may be agent-writable — skip
    // symlinks rather than follow them out of the real root.
    if (entry.isSymbolicLink()) continue;
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
    const sessionDir = path.join(sessionsDir, agentGroupId);
    const root = realDirInside(sessionDir, path.join('.claude-shared', 'projects'));
    const files = root ? listJsonl(root) : [];
    const live = new Set(files);
    // Cache keys are realpath'd (they come from listJsonl(root), and root is
    // already realpath'd by realDirInside). sessionDir itself is not — if
    // the sessions dir is reached through a symlink, comparing against the
    // non-realpath'd sessionDir never matches, so a deleted file's entry is
    // never evicted. Realpath the comparison base too.
    let realSessionDir;
    try {
      realSessionDir = fs.realpathSync(sessionDir);
    } catch {
      realSessionDir = sessionDir;
    }
    for (const key of fileCache.keys()) if (key.startsWith(realSessionDir + path.sep) && !live.has(key)) fileCache.delete(key);
    const fileEntries = [];
    for (const file of files) {
      const st = fs.statSync(file);
      let entry = fileCache.get(file);
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        entry = { mtimeMs: st.mtimeMs, size: st.size, records: parseTranscript(file) };
        parsed += 1;
        fileCache.set(file, entry);
      }
      fileEntries.push(entry);
    }
    // Dedupe by message id across every file of the agent: one API response
    // can be re-synced into more than one transcript file. The record from
    // the file with the latest mtime wins (then line order within a file,
    // handled by parseTranscript itself).
    fileEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const byId = new Map();
    const anonymous = [];
    for (const entry of fileEntries) {
      for (const r of entry.records) {
        if (r.id) byId.set(r.id, r);
        else anonymous.push(r);
      }
    }
    return [...byId.values(), ...anonymous];
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
    _cacheKeys: () => [...fileCache.keys()],
  };
}
