import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createFileDisclosureAuthorizer } from '../src/disclosure-authorization.js';
import { streamProtectedFile } from '../src/protected-file-stream.js';
import { sessionStorageKey } from '../src/session-store.js';

const SESSION_SECRET = 'in-flight-disclosure-poc-secret-at-least-thirty-two-characters';
const SESSION_ID = 'in-flight-disclosure-poc-session';
const USER_ID = 2;
const REPOSITORY_ID = 7;
const FILE_ID = 'confidential-file';
const FILE_SIZE = 2 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;

class SlowSink extends Writable {
  constructor(delayMs = 1) {
    super({ highWaterMark: CHUNK_SIZE });
    this.delayMs = delayMs;
    this.receivedBytes = 0;
    this.firstChunk = new Promise((resolve) => {
      this.resolveFirstChunk = resolve;
    });
  }

  _write(chunk, encoding, callback) {
    this.receivedBytes += chunk.length;
    this.resolveFirstChunk?.();
    this.resolveFirstChunk = null;
    setTimeout(callback, this.delayMs);
  }
}

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE repositories (
      id INTEGER PRIMARY KEY,
      created_by INTEGER
    );
    CREATE TABLE repository_permissions (
      repository_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 0,
      can_upload INTEGER NOT NULL DEFAULT 0,
      can_download INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repository_id, user_id)
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE revoked_sessions (
      sid TEXT PRIMARY KEY,
      expires INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO users (id, role, must_change_password) VALUES (?, ?, 0)')
    .run(USER_ID, 'USER');
  db.prepare('INSERT INTO repositories (id, created_by) VALUES (?, ?)')
    .run(REPOSITORY_ID, 1);
  db.prepare(`
    INSERT INTO repository_permissions (
      repository_id, user_id, can_view, can_upload, can_download, can_delete
    ) VALUES (?, ?, 1, 0, 1, 0)
  `).run(REPOSITORY_ID, USER_ID);
  db.prepare('INSERT INTO files (id, repository_id) VALUES (?, ?)')
    .run(FILE_ID, REPOSITORY_ID);
  return db;
}

function resetAuthorization(db) {
  const storageId = sessionStorageKey(SESSION_ID, SESSION_SECRET);
  db.prepare('DELETE FROM revoked_sessions WHERE sid = ?').run(storageId);
  db.prepare(`
    INSERT INTO sessions (sid, sess, expires)
    VALUES (?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
  `).run(storageId, '{}', Date.now() + 10 * 60 * 1000);
  db.prepare(`
    UPDATE repository_permissions
    SET can_download = 1
    WHERE repository_id = ? AND user_id = ?
  `).run(REPOSITORY_ID, USER_ID);
}

function createAuthorizer(db) {
  return createFileDisclosureAuthorizer(db, {
    sessionSecret: SESSION_SECRET,
    adminAccessDisabled: false
  }, {
    sessionId: SESSION_ID,
    userId: USER_ID,
    repositoryId: REPOSITORY_ID,
    fileId: FILE_ID
  });
}

function revokePermission(db) {
  db.prepare(`
    UPDATE repository_permissions
    SET can_download = 0
    WHERE repository_id = ? AND user_id = ?
  `).run(REPOSITORY_ID, USER_ID);
}

function revokeSession(db) {
  const storageId = sessionStorageKey(SESSION_ID, SESSION_SECRET);
  db.prepare(`
    INSERT INTO revoked_sessions (sid, expires)
    VALUES (?, ?)
    ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires
  `).run(storageId, Date.now() + 10 * 60 * 1000);
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(storageId);
}

async function runBaselineScenario(db, filePath, revoke) {
  resetAuthorization(db);
  const isAuthorized = createAuthorizer(db);
  assert.equal(isAuthorized(), true);

  const destination = new SlowSink();
  const source = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
  const completed = new Promise((resolve, reject) => {
    source.once('error', reject);
    destination.once('error', reject);
    destination.once('finish', resolve);
  });
  source.pipe(destination);
  await destination.firstChunk;
  revoke(db);
  await completed;

  return {
    receivedBytes: destination.receivedBytes,
    completed: destination.receivedBytes === FILE_SIZE,
    fullDisclosure: destination.receivedBytes === FILE_SIZE
  };
}

async function runPatchedScenario(db, filePath, revoke) {
  resetAuthorization(db);
  const isAuthorized = createAuthorizer(db);
  assert.equal(isAuthorized(), true);

  const destination = new SlowSink();
  destination.on('error', () => {});
  const fd = fs.openSync(filePath, 'r');
  const opened = {
    fd,
    filePath,
    stats: fs.fstatSync(fd)
  };
  const control = streamProtectedFile({
    opened,
    tracker: { complete() {} },
    destination,
    isAuthorized,
    recheckIntervalMs: 5,
    highWaterMark: CHUNK_SIZE
  });
  assert.equal(control.started, true);
  await destination.firstChunk;
  revoke(db);
  const result = await control.done;

  return {
    receivedBytes: destination.receivedBytes,
    completed: destination.receivedBytes === FILE_SIZE,
    fullDisclosure: destination.receivedBytes === FILE_SIZE,
    revoked: result.revoked
  };
}

export async function runInFlightDisclosureRevocationPoc() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-disclosure-poc-'));
  const filePath = path.join(temporaryDirectory, 'confidential.bin');
  fs.writeFileSync(filePath, Buffer.alloc(FILE_SIZE, 0x52), { mode: 0o600 });
  const db = createDatabase();

  try {
    const baseline = {
      permissionRevocation: await runBaselineScenario(db, filePath, revokePermission),
      sessionRevocation: await runBaselineScenario(db, filePath, revokeSession)
    };
    const patched = {
      permissionRevocation: await runPatchedScenario(db, filePath, revokePermission),
      sessionRevocation: await runPatchedScenario(db, filePath, revokeSession)
    };

    return {
      fileSize: FILE_SIZE,
      baseline,
      patched,
      verdict: (
        baseline.permissionRevocation.fullDisclosure
        && baseline.sessionRevocation.fullDisclosure
        && !patched.permissionRevocation.fullDisclosure
        && !patched.sessionRevocation.fullDisclosure
        && patched.permissionRevocation.revoked
        && patched.sessionRevocation.revoked
      ) ? 'BLOCKED' : 'FAILED'
    };
  } finally {
    db.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const result = await runInFlightDisclosureRevocationPoc();
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict !== 'BLOCKED') process.exitCode = 1;
}
