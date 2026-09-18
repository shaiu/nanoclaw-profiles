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
