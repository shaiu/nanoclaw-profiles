#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { loadPlugins } from './plugins.mjs';
import { loadCatalogue } from './catalogue.mjs';
import { createSources } from './sources/index.mjs';
import { createAccessVerifier } from './auth.mjs';
import { createApp } from './server.mjs';

const USAGE = `Usage:
  nanoclaw-profiles serve --config <config.json>
  nanoclaw-profiles check --config <config.json>
  nanoclaw-profiles check --templates <dir> [--plugin <file>]...`;

async function serve(configPath) {
  const config = loadConfig(configPath);
  const plugins = await loadPlugins(config.plugins);
  const catalogue = loadCatalogue(plugins);
  const sources = createSources(config);
  sources.nanoclaw.listAgentGroups();
  const verifier = createAccessVerifier(config.access);
  await verifier.init();
  const app = createApp({ config, sources, plugins, catalogue, verifier });
  await app.listen(config.port, '127.0.0.1');
  console.log(`nanoclaw-profiles listening on http://127.0.0.1:${config.port}`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { config: { type: 'string', short: 'c' }, templates: { type: 'string' }, plugin: { type: 'string', multiple: true } },
});

try {
  if (positionals[0] === 'serve') await serve(values.config ?? 'config.json');
  else if (positionals[0] === 'check') {
    const { runCheckCli } = await import('./check.mjs');
    process.exitCode = await runCheckCli(values);
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
