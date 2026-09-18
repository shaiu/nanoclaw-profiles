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
      <ul class="chips">${s.examples.map((e) => `<li>"${esc(e)}"</li>`).join('')}</ul>`).join('')) : ''}`;
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
      ${i.lastLog ? `<div class="muted">"${esc(i.lastLog)}"</div>` : ''}
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
  const note = c.estimate
    ? `This is an estimate${c.unpriced ? ' (some usage has no price set)' : ''}.`
    : c.unpriced ? 'Some usage has no price set, so the real total is higher.' : '';
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
