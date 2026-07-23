import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { runGeneratedPreviewDisclosureRevocationPoc } from '../security-poc/generated-preview-disclosure-revocation.mjs';
import { streamProtectedBuffer } from '../src/protected-file-stream.js';

const routeSource = fs.readFileSync(
  new URL('../src/routes/repositories.js', import.meta.url),
  'utf8'
);

const streamSource = fs.readFileSync(
  new URL('../src/protected-file-stream.js', import.meta.url),
  'utf8'
);

test('generated preview JSON stops after permission or session revocation', async () => {
  const result = await runGeneratedPreviewDisclosureRevocationPoc();

  assert.equal(result.baseline.permissionRevocation.fullDisclosure, true);
  assert.equal(result.baseline.sessionRevocation.fullDisclosure, true);
  assert.equal(result.patched.permissionRevocation.fullDisclosure, false);
  assert.equal(result.patched.sessionRevocation.fullDisclosure, false);
  assert.equal(result.patched.permissionRevocation.revoked, true);
  assert.equal(result.patched.sessionRevocation.revoked, true);
  assert.equal(result.verdict, 'BLOCKED');
});

test('structured preview routes use revocation-aware JSON streaming', () => {
  assert.doesNotMatch(routeSource, /return res\.json\(preview\);/u);
  assert.match(
    routeSource,
    /streamAuthorizedJson\(preview, res, next, authorizeDisclosure\);/u
  );
  assert.match(
    routeSource,
    /streamProtectedBuffer\(\{[\s\S]*highWaterMark: PREVIEW_JSON_CHUNK_BYTES[\s\S]*authorizeEveryChunk: true/u
  );
  assert.match(
    streamSource,
    /export function streamProtectedBuffer\(options = \{\}\)/u
  );
});

test('generated preview streaming denies before the first byte when authorization is absent', async () => {
  let receivedBytes = 0;
  const destination = new Writable({
    write(chunk, encoding, callback) {
      receivedBytes += chunk.length;
      callback();
    }
  });
  destination.on('error', () => {});

  const control = streamProtectedBuffer({
    buffer: Buffer.alloc(128 * 1024, 0x52),
    destination,
    isAuthorized: () => false,
    highWaterMark: 16 * 1024
  });
  const result = await control.done;

  assert.equal(control.started, false);
  assert.equal(result.revoked, true);
  assert.equal(receivedBytes, 0);
});

test('generated preview streaming fails closed when a re-check throws', async () => {
  let receivedBytes = 0;
  let checks = 0;
  const destination = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, encoding, callback) {
      receivedBytes += chunk.length;
      callback();
    }
  });
  destination.on('error', () => {});

  const control = streamProtectedBuffer({
    buffer: Buffer.alloc(128 * 1024, 0x52),
    destination,
    isAuthorized() {
      checks += 1;
      if (checks >= 3) throw new Error('simulated authorization backend failure');
      return true;
    },
    highWaterMark: 16 * 1024,
    authorizeEveryChunk: true
  });
  const result = await control.done;

  assert.equal(result.revoked, true);
  assert.equal(result.error, null);
  assert.equal(receivedBytes, 16 * 1024);
});

