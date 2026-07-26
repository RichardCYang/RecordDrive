import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_PREVIEW_MAX_PATH_COMPONENTS,
  ARCHIVE_PREVIEW_MAX_TREE_NODES,
  createArchivePreviewTreeBudget,
  normalizeArchivePreviewName
} from '../src/archive-preview-security.js';

test('normalizes safe archive names without treating metadata as filesystem paths', () => {
  assert.deepEqual(normalizeArchivePreviewName('docs\\2026/report.txt'), {
    name: 'docs/2026/report.txt',
    components: ['docs', '2026', 'report.txt'],
    directory: false
  });
  assert.equal(normalizeArchivePreviewName('docs/folder/').directory, true);
});

test('rejects archive metadata that can spoof paths or amplify tree depth', () => {
  assert.equal(normalizeArchivePreviewName('../secret.txt'), null);
  assert.equal(normalizeArchivePreviewName('safe/./file.txt'), null);
  assert.equal(normalizeArchivePreviewName('safe/\u202efile.txt'), null);
  assert.equal(normalizeArchivePreviewName('safe/line\nbreak.txt'), null);
  const tooDeep = Array.from({ length: ARCHIVE_PREVIEW_MAX_PATH_COMPONENTS + 1 }, (_, index) => `d${index}`).join('/');
  assert.equal(normalizeArchivePreviewName(tooDeep), null);
});

test('caps unique archive preview tree nodes independently of entry count and name bytes', () => {
  const budget = createArchivePreviewTreeBudget(5);
  assert.equal(budget.reserve(['a', 'b', 'one.txt']), true);
  assert.equal(budget.size, 3);
  assert.equal(budget.reserve(['a', 'b', 'two.txt']), true);
  assert.equal(budget.size, 4);
  assert.equal(budget.reserve(['x', 'y']), false);
  assert.equal(budget.size, 4);

  const defaultBudget = createArchivePreviewTreeBudget();
  for (let index = 0; index < ARCHIVE_PREVIEW_MAX_TREE_NODES; index += 1) {
    assert.equal(defaultBudget.reserve([`n${index}`]), true);
  }
  assert.equal(defaultBudget.reserve(['overflow']), false);
});
