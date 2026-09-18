import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CENTRAL_DDL = `
CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, agent_provider TEXT, created_at TEXT NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL, agent_group_id TEXT, granted_by TEXT, granted_at TEXT NOT NULL, PRIMARY KEY (user_id, role, agent_group_id));
CREATE TABLE agent_group_members (user_id TEXT NOT NULL, agent_group_id TEXT NOT NULL, added_by TEXT, added_at TEXT NOT NULL, PRIMARY KEY (user_id, agent_group_id));
CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT, thread_id TEXT, agent_provider TEXT, status TEXT DEFAULT 'active', container_status TEXT DEFAULT 'stopped', last_active TEXT, created_at TEXT NOT NULL);
CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, provider TEXT, model TEXT, effort TEXT, image_tag TEXT, assistant_name TEXT, max_messages_per_prompt INTEGER, skills TEXT NOT NULL DEFAULT '"all"', mcp_servers TEXT NOT NULL DEFAULT '{}', packages_apt TEXT NOT NULL DEFAULT '[]', packages_npm TEXT NOT NULL DEFAULT '[]', additional_mounts TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL, cli_scope TEXT NOT NULL DEFAULT 'group', timezone TEXT);
`;

const INBOUND_DDL = `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL, status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, series_id TEXT, tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL, source_session_id TEXT, on_wake INTEGER NOT NULL DEFAULT 0);`;
const OUTBOUND_DDL = `CREATE TABLE messages_out (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT, timestamp TEXT NOT NULL, deliver_after TEXT, recurrence TEXT, kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL);`;

const NOW = '2026-09-01T00:00:00.000Z';

export function createInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-install-'));
  fs.mkdirSync(path.join(dir, 'data', 'v2-sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'groups'), { recursive: true });
  const dbPath = path.join(dir, 'data', 'v2.db');
  const db = new DatabaseSync(dbPath);
  db.exec(CENTRAL_DDL);
  let seq = 0;

  const install = {
    dir,
    dbPath,
    sessionsDir: path.join(dir, 'data', 'v2-sessions'),
    groupsDir: path.join(dir, 'groups'),
    addGroup({ id, name, folder, mcpServers = {}, timezone = null, assistantName = null }) {
      db.prepare('INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(id, name, folder, NOW);
      db.prepare('INSERT INTO container_configs (agent_group_id, assistant_name, mcp_servers, updated_at, timezone) VALUES (?, ?, ?, ?, ?)')
        .run(id, assistantName, JSON.stringify(mcpServers), NOW, timezone);
      fs.mkdirSync(path.join(install.groupsDir, folder), { recursive: true });
      return install;
    },
    addUser(id, displayName = id) {
      db.prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(id, 'whatsapp', displayName, NOW);
      return install;
    },
    addRole(userId, role, agentGroupId = null) {
      db.prepare('INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES (?, ?, ?, ?)').run(userId, role, agentGroupId, NOW);
      return install;
    },
    addMember(userId, agentGroupId) {
      db.prepare('INSERT INTO agent_group_members (user_id, agent_group_id, added_at) VALUES (?, ?, ?)').run(userId, agentGroupId, NOW);
      return install;
    },
    addSession({ id, agentGroupId, lastActive }) {
      db.prepare('INSERT INTO sessions (id, agent_group_id, last_active, created_at) VALUES (?, ?, ?, ?)').run(id, agentGroupId, lastActive, NOW);
      const sdir = path.join(install.sessionsDir, agentGroupId, id);
      fs.mkdirSync(sdir, { recursive: true });
      const inbound = new DatabaseSync(path.join(sdir, 'inbound.db'));
      inbound.exec(INBOUND_DDL);
      const outbound = new DatabaseSync(path.join(sdir, 'outbound.db'));
      outbound.exec(OUTBOUND_DDL);
      const session = {
        inbound({ kind = 'chat', timestamp, status = 'completed', processAfter = null, seriesId = null }) {
          seq += 2;
          inbound.prepare('INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, series_id, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(`in-${seq}`, seq, kind, timestamp, status, processAfter, seriesId, '{"text":"PRIVATE MESSAGE TEXT"}');
          return session;
        },
        outbound({ kind = 'chat', timestamp }) {
          seq += 2;
          outbound.prepare('INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)')
            .run(`out-${seq}`, seq + 1, kind, timestamp, '{"text":"PRIVATE REPLY TEXT"}');
          return session;
        },
        close() {
          inbound.close();
          outbound.close();
        },
      };
      return session;
    },
    writeGroupFile(folder, rel, content) {
      const file = path.join(install.groupsDir, folder, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
    writeTranscript(agentGroupId, rel, lines) {
      const file = path.join(install.sessionsDir, agentGroupId, '.claude-shared', 'projects', rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return file;
    },
    close() {
      db.close();
    },
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return install;
}

export function householdInstall() {
  const install = createInstall();
  install
    .addGroup({ id: 'ag-personal', name: 'Personal', folder: 'personal' })
    .addGroup({ id: 'ag-home', name: 'Home', folder: 'home' })
    .addGroup({ id: 'ag-eval', name: 'Eval', folder: 'eval' })
    .addUser('wa:owner')
    .addUser('wa:spouse')
    .addUser('wa:stranger')
    .addRole('wa:owner', 'owner')
    .addMember('wa:spouse', 'ag-home');
  return install;
}
