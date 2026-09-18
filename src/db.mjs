import { DatabaseSync } from 'node:sqlite';

export function openReadOnly(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 2000');
  return db;
}
