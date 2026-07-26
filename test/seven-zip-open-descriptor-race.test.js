import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { runSevenZipOpenDescriptorRacePoc } from '../security-poc/seven-zip-open-descriptor-race.mjs';

test('7z preview workers keep reading the already-authorized descriptor after a pathname swap', async () => {
  const result = await runSevenZipOpenDescriptorRacePoc();
  assert.equal(result.vulnerableAcceptedReplacement, true);
  assert.equal(result.fixedStayedOnAuthorizedInode, true);
  assert.equal(result.descriptorStillOpen, true);
});

test('the repository preview route passes the open descriptor into 7z preview generation', () => {
  const routeSource = fs.readFileSync(new URL('../src/routes/repositories.js', import.meta.url), 'utf8');
  const previewSource = fs.readFileSync(new URL('../src/file-preview.js', import.meta.url), 'utf8');
  const workerSource = fs.readFileSync(new URL('../src/seven-zip-parser-worker.js', import.meta.url), 'utf8');

  assert.match(routeSource, /createSevenZipPreview\(\{ fd: opened\.fd, filePath: opened\.filePath \}/u);
  assert.match(previewSource, /fileDescriptor: sourceDescriptor/u);
  assert.match(workerSource, /this\.fd = source\.fileDescriptor/u);
  assert.match(workerSource, /if \(this\.ownsDescriptor && this\.fd !== undefined\) fs\.closeSync\(this\.fd\)/u);
});
