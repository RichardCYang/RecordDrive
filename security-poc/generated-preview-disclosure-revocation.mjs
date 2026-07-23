import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Writable } from 'node:stream';
import { streamProtectedBuffer } from '../src/protected-file-stream.js';

const CHUNK_SIZE = 16 * 1024;
const CONFIDENTIAL_TEXT_BYTES = 1024 * 1024;

class SlowSink extends Writable {
  constructor(delayMs = 2) {
    super({ highWaterMark: CHUNK_SIZE });
    this.delayMs = delayMs;
    this.receivedBytes = 0;
    this.firstWrite = new Promise((resolve) => {
      this.resolveFirstWrite = resolve;
    });
  }

  _write(chunk, encoding, callback) {
    this.receivedBytes += chunk.length;
    this.resolveFirstWrite?.();
    this.resolveFirstWrite = null;
    setTimeout(callback, this.delayMs);
  }
}

function previewPayload() {
  return Buffer.from(JSON.stringify({
    kind: 'xlsx',
    sheet: {
      name: 'Confidential',
      rows: [[{
        value: `CONFIDENTIAL:${'R'.repeat(CONFIDENTIAL_TEXT_BYTES)}`,
        type: 3,
        style: {}
      }]]
    }
  }), 'utf8');
}

async function runOneShotBaseline(revoke) {
  const payload = previewPayload();
  const authorization = { permission: true, session: true };
  const destination = new SlowSink();
  const completed = new Promise((resolve, reject) => {
    destination.once('finish', resolve);
    destination.once('error', reject);
  });

  // Express res.json() serializes the complete object and ends the response with
  // one body. Once queued, later authorization changes cannot affect the write.
  destination.end(payload);
  await destination.firstWrite;
  revoke(authorization);
  await completed;

  return {
    payloadBytes: payload.length,
    receivedBytes: destination.receivedBytes,
    fullDisclosure: destination.receivedBytes === payload.length
  };
}

async function runProtectedPreview(revoke) {
  const payload = previewPayload();
  const authorization = { permission: true, session: true };
  const destination = new SlowSink();
  destination.on('error', () => {});

  const control = streamProtectedBuffer({
    buffer: payload,
    destination,
    isAuthorized() {
      return authorization.permission && authorization.session;
    },
    recheckIntervalMs: 5,
    highWaterMark: CHUNK_SIZE,
    authorizeEveryChunk: true
  });

  await destination.firstWrite;
  revoke(authorization);
  const result = await control.done;

  return {
    payloadBytes: payload.length,
    receivedBytes: destination.receivedBytes,
    fullDisclosure: destination.receivedBytes === payload.length,
    revoked: result.revoked
  };
}

export async function runGeneratedPreviewDisclosureRevocationPoc() {
  const revokePermission = (authorization) => {
    authorization.permission = false;
  };
  const revokeSession = (authorization) => {
    authorization.session = false;
  };

  const baseline = {
    permissionRevocation: await runOneShotBaseline(revokePermission),
    sessionRevocation: await runOneShotBaseline(revokeSession)
  };
  const patched = {
    permissionRevocation: await runProtectedPreview(revokePermission),
    sessionRevocation: await runProtectedPreview(revokeSession)
  };

  const verdict = (
    baseline.permissionRevocation.fullDisclosure
    && baseline.sessionRevocation.fullDisclosure
    && !patched.permissionRevocation.fullDisclosure
    && !patched.sessionRevocation.fullDisclosure
    && patched.permissionRevocation.revoked
    && patched.sessionRevocation.revoked
  ) ? 'BLOCKED' : 'FAILED';

  return {
    confidentialityTarget: 'generated XLSX/ZIP/7z preview JSON',
    baseline,
    patched,
    verdict
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const result = await runGeneratedPreviewDisclosureRevocationPoc();
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict !== 'BLOCKED') process.exitCode = 1;
}
