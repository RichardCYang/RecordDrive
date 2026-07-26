import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasUnsafeDisplayControls,
  safeDisplayText,
  stripUnsafeDisplayControls
} from '../src/display-text-security.js';
import { safeInternalPath, safeOriginalName } from '../src/utils.js';

test('removes bidirectional and C0/C1 controls from displayed names', () => {
  const deceptive = `invoice.pdf\u202Eexe`;
  assert.equal(hasUnsafeDisplayControls(deceptive), true);
  assert.equal(stripUnsafeDisplayControls(deceptive), 'invoice.pdfexe');
  assert.equal(safeDisplayText(deceptive), 'invoice.pdfexe');
});

test('normalizes browser and SMB supplied filenames without preserving platform paths', () => {
  assert.equal(safeOriginalName(`C:\\fake\\invoice.pdf\u202Eexe`), 'invoice.pdfexe');
  assert.equal(safeOriginalName('../quarterly  report.pdf'), 'quarterly report.pdf');
  assert.equal(safeOriginalName('\u0000\u202E'), 'unnamed-file');
});

test('rejects hidden direction controls and encoded separators in internal redirects', () => {
  assert.equal(safeInternalPath('/repositories/1\u202Eevil', '/'), '/');
  assert.equal(safeInternalPath('/repositories/1%E2%80%AEevil', '/'), '/');
  assert.equal(safeInternalPath('/repositories%5Cadmin', '/'), '/');
  assert.equal(safeInternalPath('/%2Fexample.test/path', '/'), '/');
  assert.equal(safeInternalPath('/repositories/1?sort=name-asc', '/'), '/repositories/1?sort=name-asc');
});
