import fs from 'node:fs';
import path from 'node:path';
import { humanizeSlug } from '../present/format.mjs';
import { realDirInside, readFileInside } from '../fs-safe.mjs';

export function extractCoreMemory(indexMd) {
  const lines = String(indexMd).split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+core memory\b/i.test(l));
  if (start === -1) return null;
  const level = /^(#+)/.exec(lines[start])[1].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^(#+)\s/.exec(line);
    if (m && m[1].length <= level) break;
    body.push(line);
  }
  return body.join('\n').trim() || null;
}

export function parseFrontmatter(md) {
  const text = String(md);
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const data = {};
  for (const line of text.slice(text.indexOf('\n') + 1, end).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) data[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: text.slice(end + 4).replace(/^\r?\n/, '') };
}

const SKIP_FILES = new Set(['index.md', 'log.md']);

export function readMemory(groupsDir, folder, { maxFiles = 200 } = {}) {
  const groupDir = path.join(groupsDir, folder);
  const root = realDirInside(groupDir, 'memory');
  if (!root) return { core: null, files: [] };
  const indexText = readFileInside(root, 'index.md');
  const core = indexText !== null ? extractCoreMemory(indexText) : null;
  const files = [];
  const walk = (rel, depth) => {
    if (depth > 6 || files.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!rel && entry.name === 'system') continue;
        walk(childRel, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
        const content = readFileInside(root, childRel);
        if (content === null) continue;
        const { data, body } = parseFrontmatter(content);
        const heading = /^#\s+(.+)$/m.exec(body)?.[1].trim();
        files.push({ folder: rel, title: heading || humanizeSlug(entry.name), type: data.type || null, description: data.description || null });
      }
    }
  };
  walk('', 0);
  files.sort((a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title));
  return { core, files };
}
