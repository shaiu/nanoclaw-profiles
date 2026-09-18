import { test, after } from 'node:test';
import assert from 'node:assert/strict';
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
