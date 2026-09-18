import fs from 'node:fs';

const BUILTIN = JSON.parse(fs.readFileSync(new URL('../catalogue/capabilities.json', import.meta.url), 'utf8'));

export function loadCatalogue(plugins) {
  return [...plugins.flatMap((p) => p.capabilities ?? []), ...BUILTIN];
}
