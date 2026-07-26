import assert from 'node:assert/strict';
import {
  ARCHIVE_PREVIEW_MAX_TREE_NODES,
  createArchivePreviewTreeBudget,
  normalizeArchivePreviewName
} from '../src/archive-preview-security.js';

const entries = Array.from({ length: 2_000 }, (_, entryIndex) => ({
  name: Array.from({ length: 64 }, (_, depth) => `e${entryIndex}-d${depth}`).join('/')
}));

const vulnerablePrefixes = new Set();
for (const entry of entries) {
  let prefix = '';
  for (const part of entry.name.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part;
    vulnerablePrefixes.add(prefix);
  }
}

const budget = createArchivePreviewTreeBudget();
let accepted = 0;
for (const entry of entries) {
  const normalized = normalizeArchivePreviewName(entry.name);
  if (normalized && budget.reserve(normalized.components)) accepted += 1;
}

assert.equal(vulnerablePrefixes.size, 128_000);
assert.equal(budget.size <= ARCHIVE_PREVIEW_MAX_TREE_NODES, true);
assert.equal(accepted < entries.length, true);
console.log(JSON.stringify({
  status: 'PASS',
  vulnerableTreeNodes: vulnerablePrefixes.size,
  patchedTreeNodes: budget.size,
  patchedLimit: ARCHIVE_PREVIEW_MAX_TREE_NODES,
  acceptedEntries: accepted,
  totalEntries: entries.length
}, null, 2));
