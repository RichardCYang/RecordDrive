import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSevenZipPreview } from '../src/file-preview.js';

const samplePath = new URL('./fixtures/sample.7z', import.meta.url);
const encryptedPath = new URL('./fixtures/encrypted.7z', import.meta.url);
const encryptedContentPath = new URL('./fixtures/encrypted-content.7z', import.meta.url);
const unsafePathsPath = new URL('./fixtures/unsafe-paths.7z', import.meta.url);

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function writeOversizedHeaderArchive(filePath, nextHeaderSize = 65_537) {
  const header = Buffer.alloc(32);
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]).copy(header, 0);
  header[6] = 0;
  header[7] = 4;
  header.writeBigUInt64LE(0n, 12);
  header.writeBigUInt64LE(BigInt(nextHeaderSize), 20);
  header.writeUInt32LE(0, 28);
  header.writeUInt32LE(crc32(header.subarray(12, 32)), 8);
  fs.writeFileSync(filePath, header);
  fs.truncateSync(filePath, 32 + nextHeaderSize);
}

test('uses the pure-JavaScript parser by default and lists real 7z metadata', async () => {
  const archivePath = fileURLToPath(samplePath);
  const preview = await createSevenZipPreview(archivePath, fs.statSync(archivePath));

  assert.equal(preview.kind, '7z');
  assert.equal(preview.metadataOnly, true);
  assert.equal(preview.parserEngine, 'javascript');
  assert.equal(preview.encrypted, false);
  assert.equal(preview.totalEntries, 4);
  assert.equal(preview.totalUncompressedSize, 22);
  assert.equal(preview.totalCompressedSize, fs.statSync(archivePath).size);
  assert.ok(preview.entries.some((entry) => entry.name === 'folder/nested.txt'));
  assert.ok(preview.entries.some((entry) => entry.name === 'root.txt'));
});

test('hides all names and aggregate content metadata for encrypted 7z archives', async () => {
  const archivePath = fileURLToPath(encryptedPath);
  const preview = await createSevenZipPreview(archivePath, fs.statSync(archivePath));

  assert.equal(preview.parserEngine, 'javascript');
  assert.equal(preview.encrypted, true);
  assert.deepEqual(preview.entries, []);
  assert.equal(preview.totalEntries, 0);
  assert.equal(preview.totalEntriesExact, false);
  assert.equal(preview.totalUncompressedSize, 0);
  assert.equal(preview.totalsExact, false);
});

test('also hides metadata when file streams are encrypted but the header is visible', async () => {
  const archivePath = fileURLToPath(encryptedContentPath);
  const preview = await createSevenZipPreview(archivePath, fs.statSync(archivePath));
  assert.equal(preview.encrypted, true);
  assert.deepEqual(preview.entries, []);
  assert.equal(preview.totalEntries, 0);
  assert.equal(preview.totalUncompressedSize, 0);
});

test('omits traversal and bidi-controlled names from archive metadata', async () => {
  const archivePath = fileURLToPath(unsafePathsPath);
  const preview = await createSevenZipPreview(archivePath, fs.statSync(archivePath));
  assert.deepEqual(preview.entries.map((entry) => entry.name), ['safe/ok.txt', 'absolute.txt', 'drive.txt']);
  assert.equal(preview.totalEntries, 5);
  assert.equal(preview.truncated, true);
});

test('bounds visible metadata and total scanned entry count', async () => {
  const archivePath = fileURLToPath(samplePath);
  const stats = fs.statSync(archivePath);
  const truncated = await createSevenZipPreview(archivePath, stats, { maxVisibleEntries: 2 });
  assert.equal(truncated.totalEntries, 4);
  assert.equal(truncated.entries.length, 2);
  assert.equal(truncated.truncated, true);

  await assert.rejects(
    createSevenZipPreview(archivePath, stats, { maxScannedEntries: 2 }),
    (error) => error?.code === 'SEVEN_ZIP_METADATA_LIMIT'
  );
});

test('allows an explicit security-policy override to disable 7z preview', async () => {
  const archivePath = fileURLToPath(samplePath);
  await assert.rejects(
    createSevenZipPreview(archivePath, fs.statSync(archivePath), { enabled: false }),
    (error) => error?.code === 'SEVEN_ZIP_DISABLED'
  );
});

test('rejects malformed and CRC-corrupted 7z headers', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-seven-zip-invalid-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const malformed = path.join(tempRoot, 'malformed.7z');
  fs.writeFileSync(malformed, Buffer.alloc(64, 0x41));
  await assert.rejects(
    createSevenZipPreview(malformed, fs.statSync(malformed)),
    (error) => error?.code === 'INVALID_7Z'
  );

  const corrupted = path.join(tempRoot, 'corrupted.7z');
  const contents = fs.readFileSync(samplePath);
  contents[contents.length - 1] ^= 0xff;
  fs.writeFileSync(corrupted, contents);
  await assert.rejects(
    createSevenZipPreview(corrupted, fs.statSync(corrupted)),
    (error) => error?.code === 'INVALID_7Z'
  );
});

test('rejects a next header exceeding the configured metadata limit', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-seven-zip-limit-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const archivePath = path.join(tempRoot, 'oversized-header.7z');
  writeOversizedHeaderArchive(archivePath);

  await assert.rejects(
    createSevenZipPreview(archivePath, fs.statSync(archivePath), { maxHeaderBytes: 65_536 }),
    (error) => error?.code === 'SEVEN_ZIP_METADATA_LIMIT'
  );
});

test('contains no external 7-Zip execution or native/WASM decoder payload', () => {
  const previewSource = fs.readFileSync(new URL('../src/file-preview.js', import.meta.url), 'utf8');
  const workerSource = fs.readFileSync(new URL('../src/seven-zip-parser-worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(previewSource, /node:child_process|\bspawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(/u);
  assert.doesNotMatch(workerSource, /node:child_process|\bspawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(/u);

  const decoderRoot = fileURLToPath(new URL('../vendor/xz-compat-purejs/', import.meta.url));
  const pending = [decoderRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      if (entry.isFile()) assert.doesNotMatch(entry.name, /\.(?:node|dll|exe|wasm)$/iu);
    }
  }
  const decoderPackage = JSON.parse(fs.readFileSync(path.join(decoderRoot, 'package.json'), 'utf8'));
  assert.equal(decoderPackage.recorddriveSecurity.nativeAddons, false);
  assert.equal(decoderPackage.recorddriveSecurity.runtimePackageInstallation, false);
  assert.equal(decoderPackage.dependencies?.['install-module-linked'], undefined);
});
