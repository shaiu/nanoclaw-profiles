import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realInside, realDirInside, readFileInside } from '../src/fs-safe.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-fs-safe-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-fs-safe-outside-'));
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

fs.mkdirSync(path.join(dir, 'sub'));
fs.writeFileSync(path.join(dir, 'sub', 'file.txt'), 'inside');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'escape.txt'));
fs.symlinkSync(outside, path.join(dir, 'escape-dir'));

test('realInside resolves a real contained path', () => {
  assert.equal(realInside(dir, 'sub/file.txt'), fs.realpathSync(path.join(dir, 'sub', 'file.txt')));
});

test('realInside returns null for a missing target', () => {
  assert.equal(realInside(dir, 'nope.txt'), null);
});

test('realInside returns null for a literal .. escape', () => {
  assert.equal(realInside(dir, '../outside-file.txt'), null);
});

test('realInside returns null for a symlinked file escaping the base', () => {
  assert.equal(realInside(dir, 'escape.txt'), null);
});

test('realInside returns null for a symlinked directory escaping the base', () => {
  assert.equal(realInside(dir, 'escape-dir'), null);
});

test('readFileInside reads a contained file and refuses an escaping symlink', () => {
  assert.equal(readFileInside(dir, 'sub/file.txt'), 'inside');
  assert.equal(readFileInside(dir, 'escape.txt'), null);
  assert.equal(readFileInside(dir, 'sub'), null); // not a regular file
});

test('realDirInside accepts a contained directory and refuses an escaping symlink', () => {
  assert.equal(realDirInside(dir, 'sub'), fs.realpathSync(path.join(dir, 'sub')));
  assert.equal(realDirInside(dir, 'escape-dir'), null);
  assert.equal(realDirInside(dir, 'sub/file.txt'), null); // not a directory
});
