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
