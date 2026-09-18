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

export function createActivitySource({ sessionsDir, log = () => {} }) {
  return {
    dailyCounts(agentGroupId, sessions, { days = 7, timezone, now = new Date() }) {
      const keys = lastNDays(days, timezone, now);
      const byDay = new Map(keys.map((date) => [date, { date, conversations: 0, messagesIn: 0, messagesOut: 0, routineRuns: 0, routineFailures: 0 }]));
      const since = new Date(Date.parse(`${keys[0]}T00:00:00Z`) - DAY_MS).toISOString();
      const bucket = (ts) => byDay.get(dayKey(new Date(ts), timezone));

      for (const session of sessions) {
        if (!session.lastActive || session.lastActive < since) continue;
        const dir = path.join(sessionsDir, agentGroupId, session.id);

        try {
          const active = new Set();
          const inbound = readRows(
            path.join(dir, 'inbound.db'),
            'SELECT kind, timestamp, status, process_after FROM messages_in WHERE timestamp >= ? OR process_after >= ?',
            [since, since],
          );
          const outbound = readRows(path.join(dir, 'outbound.db'), 'SELECT kind, timestamp FROM messages_out WHERE timestamp >= ?', [since]);

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
          for (const r of outbound) {
            if (!CHAT_KINDS.has(r.kind)) continue;
            const d = bucket(r.timestamp);
            if (d) {
              d.messagesOut += 1;
              active.add(d);
            }
          }
          for (const d of active) d.conversations += 1;
        } catch (err) {
          log(`activity: skipped session ${session.id}: ${err.message}`);
        }
      }
      return keys.map((k) => byDay.get(k));
    },
  };
}
