import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/present/markdown.mjs';

test('headings shift down two levels', () => {
  assert.equal(renderMarkdown('# Family'), '<h3>Family</h3>');
  assert.equal(renderMarkdown('###### Deep'), '<h6>Deep</h6>');
});

test('lists and paragraphs', () => {
  assert.equal(renderMarkdown('- a\n- **b**\n\nText *here*\nmore'), '<ul><li>a</li><li><strong>b</strong></li></ul>\n<p>Text <em>here</em> more</p>');
  assert.equal(renderMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('html is escaped', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('only http(s) links become anchors', () => {
  assert.equal(renderMarkdown('[site](https://example.com/a?b=1&c=2)'), '<p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">site</a></p>');
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>x</p>');
  assert.equal(renderMarkdown('[kids](family/kids.md)'), '<p>kids</p>');
});

test('inline code', () => {
  assert.equal(renderMarkdown('use `ncl`'), '<p>use <code>ncl</code></p>');
});
