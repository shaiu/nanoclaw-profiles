export function globToRegExp(glob) {
  const src = String(glob).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${src}$`, 'i');
}

export function serversOf(mcpServers, resolve) {
  return Object.entries(mcpServers ?? {}).map(([name, cfg]) => ({ name, tools: resolve(name, cfg) ?? null }));
}

export function describeCapabilities(servers, catalogue, installServices = new Set()) {
  const entries = catalogue.map((e, i) => ({
    ...e,
    i,
    toolRe: e.match ? globToRegExp(e.match) : null,
    serverRe: e.server ? globToRegExp(e.server) : null,
  }));
  const serverEntry = (name) => entries.find((e) => !e.toolRe && e.serverRe?.test(name));
  const allowed = new Set();
  const unknown = [];

  for (const server of servers) {
    if (server.tools === null) {
      const hit = serverEntry(server.name);
      if (hit) allowed.add(hit.i);
      else unknown.push({ server: server.name, tool: null });
      continue;
    }
    for (const tool of server.tools) {
      const hit = entries.find((e) => e.toolRe?.test(tool) && (!e.serverRe || e.serverRe.test(server.name))) ?? serverEntry(server.name);
      if (hit) allowed.add(hit.i);
      else unknown.push({ server: server.name, tool });
    }
  }

  const services = new Map();
  for (const e of entries) {
    if (!allowed.has(e.i)) continue;
    const list = services.get(e.service) ?? [];
    if (!list.includes(e.sentence)) list.push(e.sentence);
    services.set(e.service, list);
  }

  const cannot = [];
  for (const e of entries) {
    if (!allowed.has(e.i) && e.cannot && services.has(e.service) && !cannot.includes(e.cannot)) cannot.push(e.cannot);
  }

  const noAccess = [...installServices].filter((s) => !services.has(s)).sort();
  return { can: [...services].map(([service, sentences]) => ({ service, sentences })), cannot, noAccess, unknown };
}
