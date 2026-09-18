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
