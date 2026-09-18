import path from 'node:path';
import { isValidTimezone } from './config.mjs';
import { describeCapabilities, serversOf } from './present/capabilities.mjs';
import { describeRoutine, formatWhen } from './present/schedule.mjs';
import { callHook, resolveToolsVia } from './plugins.mjs';
import { resolveIconPath } from './sources/card.mjs';
import { lastNMonths } from './sources/usage.mjs';
import { readFileInside } from './fs-safe.mjs';

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

export function computeInstallServices({ sources, catalogue, plugins, config, log = () => {} }) {
  const hidden = new Set(config?.hiddenGroups ?? []);
  const services = new Set();
  for (const group of sources.nanoclaw.listAgentGroups()) {
    if (hidden.has(group.folder)) continue;
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

  // Independent sections: none depends on another's result, so run them
  // concurrently once containerConfig/timezone/card are known.
  const showCost = viewer.isOwner || config.showCostToMembers;

  const [capabilities, routines, activity, memory, cost, instructions] = await Promise.all([
    run('capabilities', () => {
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
    }),

    run('routines', async () => {
      const rows = await sources.tasks.listForGroup(agent.id, agent.folder);
      const items = rows
        .map((r) => describeRoutine(r, { timezone, now }))
        .sort((a, b) => Number(a.paused) - Number(b.paused) || a.name.localeCompare(b.name));
      return { timezone, items };
    }),

    run('activity', async () => {
      const sessions = sources.nanoclaw.listSessions(agent.id);
      const days = sources.activity.dailyCounts(agent.id, sessions, { days: 7, timezone, now });
      const extra = await callHook(plugins, 'activity', [agent, { days: days.map((d) => d.date), timezone }], { log });
      const services = new Map((extra?.byDay ?? []).map((d) => [d.date, d.services]));
      return { days: days.map((d) => ({ ...d, services: services.get(d.date) ?? null })).reverse() };
    }),

    run('memory', () => sources.memory(agent.folder)),

    showCost
      ? run('cost', async () => {
          const months = lastNMonths(6, timezone, now);
          const fromPlugin = await callHook(plugins, 'cost', [agent, { months, timezone }], { log });
          if (Array.isArray(fromPlugin?.byMonth)) {
            const usd = new Map(fromPlugin.byMonth.map((m) => [m.month, m.usd]));
            return {
              months: months.map((month) => {
                const raw = usd.get(month);
                const amount = Number.isFinite(raw) ? raw : 0;
                return { month, amount: Math.round(amount * config.currency.rate * 100) / 100 };
              }),
              currency: config.currency,
              estimate: false,
              unpriced: false,
            };
          }
          return sources.usage.monthlyCost(agent.id, { months: 6, timezone, now, prices: config.prices, currency: config.currency });
        })
      : Promise.resolve(null),

    viewer.isOwner
      ? run('instructions', () => readFileInside(path.join(config.groupsDir, agent.folder), 'instructions.prepend.md'))
      : Promise.resolve(null),
  ]);

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
