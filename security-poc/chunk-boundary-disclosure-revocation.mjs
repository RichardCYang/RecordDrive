import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { streamProtectedFile } from '../src/protected-file-stream.js';

const PAYLOAD_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-chunk-poc-'));
  const filePath = path.join(directory, 'confidential.bin');
  fs.writeFileSync(filePath, Buffer.alloc(PAYLOAD_BYTES, 0x53));
  return { directory, filePath };
}

async function runLegacyCachedDecisionModel(filePath) {
  const fd = fs.openSync(filePath, 'r');
  let authorized = true;
  let cachedAuthorized = authorized;
  let position = 0;
  let writes = 0;
  let disclosedBytes = 0;

  try {
    while (position < PAYLOAD_BYTES && cachedAuthorized) {
      const readLength = Math.min(CHUNK_BYTES, PAYLOAD_BYTES - position);
      const chunk = Buffer.alloc(readLength);
      const bytesRead = fs.readSync(fd, chunk, 0, readLength, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      disclosedBytes += bytesRead;
      writes += 1;
      if (writes === 1) authorized = false;
      // Vulnerable behavior: the live authorization result is cached until a
      // time interval elapses, so this tight loop never observes revocation.
      void authorized;
    }
  } finally {
    fs.closeSync(fd);
  }

  return { writes, disclosedBytes, revoked: false };
}

async function runPatchedProductionStream(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const stats = fs.fstatSync(fd);
  let authorized = true;
  let writes = 0;
  let disclosedBytes = 0;
  const destination = new Writable({
    highWaterMark: PAYLOAD_BYTES * 2,
    write(chunk, encoding, callback) {
      writes += 1;
      disclosedBytes += chunk.length;
      if (writes === 1) authorized = false;
      callback();
    }
  });

  const transfer = streamProtectedFile({
    opened: { fd, filePath, stats },
    destination,
    isAuthorized: () => authorized,
    recheckIntervalMs: 60_000,
    highWaterMark: CHUNK_BYTES
  });
  const result = await transfer.done;
  return { writes, disclosedBytes, revoked: result.revoked };
}

const { directory, filePath } = fixture();
try {
  const originalModel = await runLegacyCachedDecisionModel(filePath);
  const patchedModel = await runPatchedProductionStream(filePath);

  assert.equal(originalModel.disclosedBytes, PAYLOAD_BYTES);
  assert.equal(patchedModel.revoked, true);
  assert.equal(patchedModel.disclosedBytes, CHUNK_BYTES);

  console.log(JSON.stringify({
    scenario: {
      payloadBytes: PAYLOAD_BYTES,
      chunkBytes: CHUNK_BYTES,
      revocationMoment: 'immediately after the first destination write',
      cachedDecisionWindowMs: 60_000
    },
    originalModel,
    patchedModel,
    verdict: 'BLOCKED'
  }, null, 2));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
