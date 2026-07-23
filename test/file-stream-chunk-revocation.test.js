import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';
import { streamProtectedFile } from '../src/protected-file-stream.js';

const CHUNK_BYTES = 64 * 1024;

function createOpenedFixture(size = 1024 * 1024) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-chunk-revocation-'));
  const filePath = path.join(directory, 'confidential.bin');
  fs.writeFileSync(filePath, Buffer.alloc(size, 0x53));
  const fd = fs.openSync(filePath, 'r');
  return {
    directory,
    opened: { fd, filePath, stats: fs.fstatSync(fd) }
  };
}

test('a fast file stream reauthorizes every chunk before disclosure', async (t) => {
  const fixture = createOpenedFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  let authorized = true;
  let disclosedBytes = 0;
  let writeCount = 0;
  const destination = new Writable({
    highWaterMark: fixture.opened.stats.size * 2,
    write(chunk, encoding, callback) {
      disclosedBytes += chunk.length;
      writeCount += 1;
      if (writeCount === 1) authorized = false;
      callback();
    }
  });

  const transfer = streamProtectedFile({
    opened: fixture.opened,
    destination,
    isAuthorized: () => authorized,
    recheckIntervalMs: 60_000,
    highWaterMark: CHUNK_BYTES
  });
  const result = await transfer.done;

  assert.equal(result.revoked, true);
  assert.equal(writeCount, 1);
  assert.equal(disclosedBytes, CHUNK_BYTES);
  assert.ok(disclosedBytes < fixture.opened.stats.size);
});
