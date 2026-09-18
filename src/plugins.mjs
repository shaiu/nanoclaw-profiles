import { pathToFileURL } from 'node:url';

export async function loadPlugins(paths) {
  const plugins = [];
  for (const file of paths) {
    const mod = await import(pathToFileURL(file).href);
    const plugin = mod.default;
    if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string') {
      throw new Error(`Plugin ${file} must default-export an object with a string "name"`);
    }
    if (plugin.capabilities !== undefined && !Array.isArray(plugin.capabilities)) {
      throw new Error(`Plugin ${plugin.name}: capabilities must be an array`);
    }
    plugins.push(plugin);
  }
  return plugins;
}

export function resolveToolsVia(plugins, serverName, serverConfig, log = () => {}) {
  for (const p of plugins) {
    if (typeof p.resolveTools !== 'function') continue;
    try {
      const tools = p.resolveTools(serverName, serverConfig);
      if (Array.isArray(tools)) return tools.filter((t) => typeof t === 'string');
    } catch (err) {
      log(`plugin ${p.name} resolveTools failed: ${err.message}`);
    }
  }
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function callHook(plugins, hook, args, { timeoutMs = 5000, log = () => {} } = {}) {
  for (const p of plugins) {
    if (typeof p[hook] !== 'function') continue;
    try {
      const result = await withTimeout(Promise.resolve().then(() => p[hook](...args)), timeoutMs);
      if (result !== undefined && result !== null) return result;
    } catch (err) {
      log(`plugin ${p.name} ${hook} failed: ${err.message}`);
    }
  }
  return undefined;
}
