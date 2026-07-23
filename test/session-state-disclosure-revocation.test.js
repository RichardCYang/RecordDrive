import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFileDisclosureAuthorizer } from '../src/disclosure-authorization.js';
import { SQLiteSessionStore } from '../src/session-store.js';

const SESSION_SECRET = 'session-state-disclosure-test-secret-at-least-thirty-two-characters';
const SESSION_ID = 'session-state-disclosure-test-sid';
const USER_ID = 1;
const REPOSITORY_ID = 10;
const FILE_ID = 'protected-file';

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE repositories (
      id INTEGER PRIMARY KEY,
      created_by INTEGER NOT NULL
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO users (id, role, must_change_password) VALUES (?, ?, 0)')
    .run(USER_ID, 'USER');
  db.prepare('INSERT INTO repositories (id, created_by) VALUES (?, ?)')
    .run(REPOSITORY_ID, USER_ID);
  db.prepare('INSERT INTO files (id, repository_id) VALUES (?, ?)')
    .run(FILE_ID, REPOSITORY_ID);
  return db;
}

function invokeStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

function storedSession(now, overrides = {}) {
  return {
    cookie: {
      expires: new Date(now + 60_000).toISOString(),
      maxAge: 60_000,
      originalMaxAge: 60_000
    },
    userId: USER_ID,
    authenticatedAt: now,
    sessionCreatedAt: now,
    ...overrides
  };
}

function authorizer(db, absoluteTtlMs) {
  return createFileDisclosureAuthorizer(db, {
    sessionSecret: SESSION_SECRET,
    sessionAbsoluteHours: absoluteTtlMs / (60 * 60 * 1000),
    administratorAccessDisabled: false
  }, {
    sessionId: SESSION_ID,
    userId: USER_ID,
    repositoryId: REPOSITORY_ID,
    fileId: FILE_ID
  });
}

test('in-flight disclosure stops when the same session row loses its authenticated identity', async (t) => {
  const db = createDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  const now = Date.now();
  const authorize = authorizer(db, 60_000);
  await invokeStore(store, 'set', SESSION_ID, storedSession(now));
  assert.equal(authorize(now), true);

  await invokeStore(store, 'set', SESSION_ID, storedSession(now, {
    userId: undefined,
    authenticatedAt: undefined,
    sessionCreatedAt: undefined,
    authenticationFlow: { userId: USER_ID, createdAt: now }
  }));

  assert.equal(authorize(now + 1), false);
});

test('in-flight disclosure stops at absolute session expiry even while the row expiry remains live', async (t) => {
  const db = createDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  const now = Date.now();
  const absoluteTtlMs = 1_000;
  const createdAt = now - absoluteTtlMs - 1;
  await invokeStore(store, 'set', SESSION_ID, storedSession(now, {
    authenticatedAt: createdAt,
    sessionCreatedAt: createdAt
  }));

  assert.equal(authorizer(db, absoluteTtlMs)(now), false);
});

test('in-flight disclosure fails closed when the encrypted session payload is corrupt', async (t) => {
  const db = createDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  const now = Date.now();
  await invokeStore(store, 'set', SESSION_ID, storedSession(now));
  db.prepare('UPDATE sessions SET sess = ?').run('v1.corrupt.payload');

  assert.equal(authorizer(db, 60_000)(now), false);
});
