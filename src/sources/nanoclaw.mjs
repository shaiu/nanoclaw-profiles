import { openReadOnly } from '../db.mjs';

export function createNanoclawSource(dbPath) {
  let db = null;
  const all = (sql, ...params) => {
    try {
      db ??= openReadOnly(dbPath);
      return db.prepare(sql).all(...params);
    } catch (err) {
      try { db?.close(); } catch {}
      db = null;
      throw err;
    }
  };
  return {
    listAgentGroups() {
      return all('SELECT id, name, folder FROM agent_groups ORDER BY name').map((r) => ({ id: r.id, name: r.name, folder: r.folder }));
    },
    getContainerConfig(agentGroupId) {
      const [row] = all('SELECT * FROM container_configs WHERE agent_group_id = ?', agentGroupId);
      if (!row) return null;
      let mcpServers = {};
      try {
        const parsed = JSON.parse(row.mcp_servers);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) mcpServers = parsed;
      } catch {}
      return { assistantName: row.assistant_name ?? null, timezone: row.timezone ?? null, mcpServers };
    },
    getRoles(userId) {
      return all('SELECT role, agent_group_id FROM user_roles WHERE user_id = ?', userId).map((r) => ({ role: r.role, agentGroupId: r.agent_group_id ?? null }));
    },
    getMemberships(userId) {
      return all('SELECT agent_group_id FROM agent_group_members WHERE user_id = ?', userId).map((r) => r.agent_group_id);
    },
    listSessions(agentGroupId) {
      return all('SELECT id, last_active, created_at FROM sessions WHERE agent_group_id = ?', agentGroupId)
        .map((r) => ({ id: r.id, lastActive: r.last_active ?? null, createdAt: r.created_at }));
    },
    close() {
      try { db?.close(); } catch {}
      db = null;
    },
  };
}
