import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createFileAccessTracker,
  withTrackedFileAccess
} from '../src/file-access-time.js';

function repositoryPolicyDb(updateFileAccessTime) {
  return {
    prepare(sql) {
      if (/SELECT\s+update_file_access_time\s+FROM repositories/iu.test(sql)) {
        return { get: () => ({ update_file_access_time: updateFileAccessTime ? 1 : 0 }) };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    }
  };
}

test('preserves the primary file-operation error when access-time completion also fails', async () => {
  const primaryError = Object.assign(new Error('encoded-header unpacked size exceeds its safety limit.'), {
    code: 'SEVEN_ZIP_METADATA_LIMIT'
  });
  const completionError = Object.assign(new Error('EPERM: operation not permitted, futime'), {
    code: 'EPERM',
    syscall: 'futime'
  });
  let reportedCompletionError = null;

  await assert.rejects(
    withTrackedFileAccess(
      { complete: () => { throw completionError; } },
      async () => { throw primaryError; },
      (error) => { reportedCompletionError = error; }
    ),
    (error) => error === primaryError
  );
  assert.equal(reportedCompletionError, completionError);
});

test('falls back to path-based timestamp updates after Windows-style futime EPERM', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-atime-fallback-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const filePath = path.join(tempRoot, 'stored-file.bin');
  fs.writeFileSync(filePath, Buffer.from('recorddrive'));
  const oldAccessTimeMs = Date.now() - (24 * 60 * 60 * 1000);
  const oldModifiedTimeMs = Date.now() - (60 * 60 * 1000);
  fs.utimesSync(filePath, oldAccessTimeMs / 1000, oldModifiedTimeMs / 1000);

  const fd = fs.openSync(filePath, 'r');
  t.after(() => fs.closeSync(fd));
  const originalFutimesSync = fs.futimesSync;
  let futimesAttempts = 0;
  fs.futimesSync = () => {
    futimesAttempts += 1;
    const error = new Error('EPERM: operation not permitted, futime');
    error.code = 'EPERM';
    error.syscall = 'futime';
    throw error;
  };
  t.after(() => { fs.futimesSync = originalFutimesSync; });

  const beforeCompleteMs = Date.now();
  const tracker = createFileAccessTracker(
    repositoryPolicyDb(true),
    { id: 7 },
    { id: 11, initial_access_time_ms: oldAccessTimeMs },
    { fd, filePath }
  );
  tracker.complete();
  const afterCompleteMs = Date.now();
  const stats = fs.statSync(filePath);

  assert.equal(futimesAttempts, 1);
  assert.ok(stats.atimeMs >= beforeCompleteMs - 1000);
  assert.ok(stats.atimeMs <= afterCompleteMs + 1000);
  assert.ok(Math.abs(stats.mtimeMs - oldModifiedTimeMs) < 1000);
});

test('does not update a replacement path when the opened file identity changed', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-atime-identity-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const filePath = path.join(tempRoot, 'stored-file.bin');
  const movedPath = path.join(tempRoot, 'opened-file.bin');
  fs.writeFileSync(filePath, Buffer.from('original'));
  const initialAccessTimeMs = Date.now() - (24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, initialAccessTimeMs / 1000, initialAccessTimeMs / 1000);

  const fd = fs.openSync(filePath, 'r');
  t.after(() => fs.closeSync(fd));
  const tracker = createFileAccessTracker(
    repositoryPolicyDb(true),
    { id: 7 },
    { id: 11, initial_access_time_ms: initialAccessTimeMs },
    { fd, filePath }
  );

  fs.renameSync(filePath, movedPath);
  fs.writeFileSync(filePath, Buffer.from('replacement'));
  const replacementAccessTimeMs = Date.now() - (12 * 60 * 60 * 1000);
  fs.utimesSync(filePath, replacementAccessTimeMs / 1000, replacementAccessTimeMs / 1000);

  const originalFutimesSync = fs.futimesSync;
  fs.futimesSync = () => {
    const error = new Error('EPERM: operation not permitted, futime');
    error.code = 'EPERM';
    error.syscall = 'futime';
    throw error;
  };
  t.after(() => { fs.futimesSync = originalFutimesSync; });

  assert.throws(() => tracker.complete(), (error) => error?.code === 'ESTALE');
  assert.ok(Math.abs(fs.statSync(filePath).atimeMs - replacementAccessTimeMs) < 1000);
});
