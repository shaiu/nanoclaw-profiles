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
