import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSevenZipPreview } from '../src/file-preview.js';

function createListingBinary(tempRoot, entryCount) {
  const binaryPath = path.join(tempRoot, `fake-7zz-${entryCount}.mjs`);
  const argsPath = path.join(tempRoot, `fake-7zz-${entryCount}-args.json`);
  const script = `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
const lines = [
  '7-Zip fake test binary',
  '',
  'Listing archive: sparse.7z',
  '',
  '--',
  'Path = sparse.7z',
  'Type = 7z',
  'Physical Size = 5368709120',
  'Headers Size = 4096',
  'Method = LZMA2:24',
  'Solid = +',
  'Blocks = 1',
  '',
  '----------'
];
for (let index = 0; index < ${entryCount}; index += 1) {
  lines.push(
    'Path = folder/file-' + index + '.txt',
    'Size = 1024',
    'Packed Size = 16',
    'Modified = 2026-07-20 11:00:00',
    'Attributes = A_ -rw-r--r--',
    'Folder = -',
    'Encrypted = -',
    ''
  );
}
process.stdout.write(lines.join('\\n'));
`;
  fs.writeFileSync(binaryPath, script, { mode: 0o755 });
  fs.chmodSync(binaryPath, 0o755);
  return { binaryPath, argsPath };
}

test('lists a multi-gigabyte 7z file through metadata only without extraction', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-seven-zip-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const archivePath = path.join(tempRoot, 'large-sparse.7z');
  fs.closeSync(fs.openSync(archivePath, 'w'));
  fs.truncateSync(archivePath, 5 * 1024 * 1024 * 1024);
  const fake = createListingBinary(tempRoot, 3);

  const preview = await createSevenZipPreview(archivePath, fs.statSync(archivePath), {
    enabled: true,
    binary: fake.binaryPath,
    timeoutMs: 5000
  });

  assert.equal(preview.kind, '7z');
  assert.equal(preview.metadataOnly, true);
  assert.equal(preview.totalEntries, 3);
  assert.equal(preview.totalEntriesExact, true);
  assert.equal(preview.totalCompressedSize, 5 * 1024 * 1024 * 1024);
  assert.equal(preview.totalUncompressedSize, 3 * 1024);
  assert.equal(preview.truncated, false);

  const args = JSON.parse(fs.readFileSync(fake.argsPath, 'utf8'));
  assert.equal(args[0], 'l');
  assert.ok(args.includes('-slt'));
  assert.ok(args.includes('--'));
  assert.equal(args.at(-1), archivePath);
  assert.ok(!args.some((argument) => ['e', 'x'].includes(argument)));
});

test('bounds visible 7z metadata while preserving an exact scanned entry count', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-seven-zip-limit-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const archivePath = path.join(tempRoot, 'many-files.7z');
  fs.writeFileSync(archivePath, 'fixture');
  const fake = createListingBinary(tempRoot, 120);

  const preview = await createSevenZipPreview(archivePath, fs.statSync(archivePath), {
    enabled: true,
    binary: fake.binaryPath,
    timeoutMs: 5000,
    maxVisibleEntries: 25,
    maxScannedEntries: 200
  });

  assert.equal(preview.totalEntries, 120);
  assert.equal(preview.totalEntriesExact, true);
  assert.equal(preview.entries.length, 25);
  assert.equal(preview.truncated, true);
});

test('keeps native 7z parsing disabled unless explicitly enabled', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-seven-zip-disabled-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const archivePath = path.join(tempRoot, 'archive.7z');
  fs.writeFileSync(archivePath, 'fixture');

  await assert.rejects(
    createSevenZipPreview(archivePath, fs.statSync(archivePath)),
    (error) => error?.code === 'SEVEN_ZIP_DISABLED'
  );
});

test('does not pass application secrets to the 7z child process', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-seven-zip-env-test-'));
  const archivePath = path.join(tempRoot, 'archive.7z');
  const binaryPath = path.join(tempRoot, 'fake-7zz-env.mjs');
  const environmentPath = path.join(tempRoot, 'child-environment.json');
  const previousSecret = process.env.RECORDDRIVE_TEST_SECRET;
  process.env.RECORDDRIVE_TEST_SECRET = 'must-not-reach-native-parser';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.RECORDDRIVE_TEST_SECRET;
    else process.env.RECORDDRIVE_TEST_SECRET = previousSecret;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.writeFileSync(archivePath, 'fixture');
  fs.writeFileSync(binaryPath, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(environmentPath)}, JSON.stringify({
  secret: process.env.RECORDDRIVE_TEST_SECRET || null,
  path: process.env.PATH || process.env.Path || null,
  lang: process.env.LANG || null
}));
process.stdout.write([
  '7-Zip fake test binary',
  '',
  'Path = archive.7z',
  'Type = 7z',
  'Physical Size = 7',
  '',
  '----------',
  'Path = file.txt',
  'Size = 1',
  'Packed Size = 1',
  'Folder = -',
  'Encrypted = -',
  ''
].join('\\n'));
`, { mode: 0o755 });
  fs.chmodSync(binaryPath, 0o755);

  const preview = await createSevenZipPreview(archivePath, fs.statSync(archivePath), {
    enabled: true,
    binary: binaryPath,
    timeoutMs: 5000
  });
  assert.equal(preview.totalEntries, 1);
  const childEnvironment = JSON.parse(fs.readFileSync(environmentPath, 'utf8'));
  assert.equal(childEnvironment.secret, null);
  assert.ok(childEnvironment.path);
});

