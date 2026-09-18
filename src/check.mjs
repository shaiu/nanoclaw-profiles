import fs from 'node:fs';
import path from 'node:path';
import { validateCard, readAgentCard } from './sources/card.mjs';
import { describeCapabilities, serversOf } from './present/capabilities.mjs';
import { loadPlugins, resolveToolsVia } from './plugins.mjs';
import { loadCatalogue } from './catalogue.mjs';
import { loadConfig } from './config.mjs';
import { createNanoclawSource } from './sources/nanoclaw.mjs';

function toolErrors(name, mcpServers, { plugins, catalogue }) {
  const servers = serversOf(mcpServers, (n, c) => resolveToolsVia(plugins, n, c));
  return describeCapabilities(servers, catalogue).unknown.map((u) =>
    `${name}: no catalogue sentence for ${u.tool ? `${u.server}/${u.tool}` : `${u.server} (whole server)`}`);
}

export function checkTemplates(templatesDir, { plugins, catalogue }) {
  const errors = [];
  const warnings = [];
  for (const entry of fs.readdirSync(templatesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(templatesDir, entry.name);
    if (!entry.isDirectory() || !fs.existsSync(path.join(dir, 'plugin.json'))) continue;
    const cardFile = path.join(dir, 'agent-card.json');
    if (!fs.existsSync(cardFile)) warnings.push(`${entry.name}: no agent-card.json`);
    else {
      try {
        const problems = validateCard(JSON.parse(fs.readFileSync(cardFile, 'utf8')));
        if (problems.length) errors.push(`${entry.name}: agent-card.json: ${problems.join('; ')}`);
      } catch (err) {
        errors.push(`${entry.name}: agent-card.json: invalid JSON`);
      }
    }
    let mcpServers = {};
    const mcpFile = path.join(dir, 'mcp.json');
    if (fs.existsSync(mcpFile)) {
      try {
        mcpServers = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers ?? {};
      } catch (err) {
        errors.push(`${entry.name}: mcp.json: invalid JSON`);
      }
    }
    errors.push(...toolErrors(entry.name, mcpServers, { plugins, catalogue }));
  }
  return { errors, warnings };
}

export function checkInstall({ config, plugins, catalogue, nanoclaw }) {
  const errors = [];
  const warnings = [];
  for (const group of nanoclaw.listAgentGroups()) {
    try {
      if (!readAgentCard(config.groupsDir, group.folder)) warnings.push(`${group.folder}: no agent-card.json`);
    } catch (err) {
      errors.push(`${group.folder}: ${err.message}`);
    }
    const cc = nanoclaw.getContainerConfig(group.id);
    errors.push(...toolErrors(group.folder, cc?.mcpServers ?? {}, { plugins, catalogue }));
  }
  return { errors, warnings };
}

export async function runCheckCli({ config: configPath, templates, plugin = [] }) {
  let result;
  if (templates) {
    const plugins = await loadPlugins(plugin.map((p) => path.resolve(p)));
    result = checkTemplates(path.resolve(templates), { plugins, catalogue: loadCatalogue(plugins) });
  } else if (configPath) {
    const config = loadConfig(configPath);
    const plugins = await loadPlugins(config.plugins);
    const nanoclaw = createNanoclawSource(config.dbPath);
    try {
      result = checkInstall({ config, plugins, catalogue: loadCatalogue(plugins), nanoclaw });
    } finally {
      nanoclaw.close();
    }
  } else {
    console.error('check needs --templates <dir> or --config <file>');
    return 2;
  }
  for (const w of result.warnings) console.log(`! ${w}`);
  for (const e of result.errors) console.log(`✗ ${e}`);
  console.log(result.errors.length ? `${result.errors.length} problem(s) found.` : 'All good.');
  return result.errors.length ? 1 : 0;
}
