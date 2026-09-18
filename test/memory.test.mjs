import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstall } from './helpers/install.mjs';
import { extractCoreMemory, parseFrontmatter, readMemory } from '../src/sources/memory.mjs';

const install = createInstall();
after(() => install.cleanup());
install.addGroup({ id: 'h', name: 'Home', folder: 'home' });
install.writeGroupFile('home', 'memory/index.md', '# Index\n\n## Core Memory\n\n- Kids: Or and Noa\n\n### Detail\nsub\n\n## Map\n- [family](family/index.md)\n');
install.writeGroupFile('home', 'memory/family/index.md', '# Family index');
install.writeGroupFile('home', 'memory/family/or.md', '---\ntype: person\ndescription: "Older kid, class B2"\n---\n# Or\n\nDetails that must not be shown.');
install.writeGroupFile('home', 'memory/school-contacts.md', 'No frontmatter here.');
install.writeGroupFile('home', 'memory/log.md', '# Log');
install.writeGroupFile('home', 'memory/system/definition.md', '---\ntype: system\n---\n# How memory works');

test('extractCoreMemory takes the section including subsections', () => {
  assert.equal(extractCoreMemory('## Core Memory\n\n- a\n### Sub\nb\n## Next\nc'), '- a\n### Sub\nb');
  assert.equal(extractCoreMemory('# Nothing'), null);
});

test('parseFrontmatter', () => {
  assert.deepEqual(parseFrontmatter("---\ntype: person\ndescription: 'x: y'\n---\nbody"), { data: { type: 'person', description: 'x: y' }, body: 'body' });
  assert.deepEqual(parseFrontmatter('plain'), { data: {}, body: 'plain' });
});

test('readMemory lists titles and descriptions, never bodies', () => {
  const m = readMemory(install.groupsDir, 'home');
  assert.equal(m.core, '- Kids: Or and Noa\n\n### Detail\nsub');
  assert.deepEqual(m.files, [
    { folder: '', title: 'School contacts', type: null, description: null },
    { folder: 'family', title: 'Or', type: 'person', description: 'Older kid, class B2' },
  ]);
  assert.ok(!JSON.stringify(m).includes('must not be shown'));
});

test('missing memory folder is empty, not an error', () => {
  install.addGroup({ id: 'x', name: 'X', folder: 'empty' });
  assert.deepEqual(readMemory(install.groupsDir, 'empty'), { core: null, files: [] });
});

test('a memory dir symlinked to another group is treated as empty', () => {
  install.addGroup({ id: 'atk', name: 'Attacker', folder: 'attacker' });
  const target = path.join(install.groupsDir, 'home', 'memory');
  const symlinkPath = path.join(install.groupsDir, 'attacker', 'memory');
  fs.symlinkSync(target, symlinkPath);
  assert.deepEqual(readMemory(install.groupsDir, 'attacker'), { core: null, files: [] });
});

test('index.md symlinked to a host file outside the group is not read', () => {
  install.addGroup({ id: 'atk2', name: 'Attacker2', folder: 'attacker2' });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-outside-'));
  try {
    fs.writeFileSync(path.join(outsideDir, '.env'), '## Core Memory\n\nSECRET_API_KEY=hunter2');
    fs.mkdirSync(path.join(install.groupsDir, 'attacker2', 'memory'));
    fs.symlinkSync(path.join(outsideDir, '.env'), path.join(install.groupsDir, 'attacker2', 'memory', 'index.md'));
    const m = readMemory(install.groupsDir, 'attacker2');
    assert.equal(m.core, null);
    assert.ok(!JSON.stringify(m).includes('hunter2'));
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
