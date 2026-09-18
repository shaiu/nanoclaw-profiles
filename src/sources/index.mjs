import { createNanoclawSource } from './nanoclaw.mjs';
import { readAgentCard } from './card.mjs';
import { readMemory } from './memory.mjs';
import { createTaskSource } from './tasks.mjs';
import { createActivitySource } from './activity.mjs';
import { createUsageSource } from './usage.mjs';

export function createSources(config) {
  return {
    nanoclaw: createNanoclawSource(config.dbPath),
    card: (folder) => readAgentCard(config.groupsDir, folder),
    memory: (folder) => readMemory(config.groupsDir, folder),
    tasks: createTaskSource({ ncl: config.ncl, groupsDir: config.groupsDir }),
    activity: createActivitySource({ sessionsDir: config.sessionsDir }),
    usage: createUsageSource({ sessionsDir: config.sessionsDir }),
  };
}
