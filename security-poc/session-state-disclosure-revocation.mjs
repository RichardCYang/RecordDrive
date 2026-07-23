import { DatabaseSync } from 'node:sqlite';
import { createFileDisclosureAuthorizer } from '../src/disclosure-authorization.js';
import {
  sessionStorageKey,
  SQLiteSessionStore
} from '../src/session-store.js';

const SESSION_SECRET = 'session-state-disclosure-poc-secret-at-least-thirty-two-characters';
const SESSION_ID = 'session-state-disclosure-poc-sid';
const USER_ID = 1;
const REPOSITORY_ID = 10;
const FILE_ID = 'poc-file';
const ABSOLUTE_TTL_MS = 1_000;

function invokeStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

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

function legacySessionRowIsActive(db, now = Date.now()) {
  const storageId = sessionStorageKey(SESSION_ID, SESSION_SECRET);
  return Boolean(db.prepare(`
    SELECT CASE WHEN
      EXISTS (
        SELECT 1 FROM sessions WHERE sid = ? AND expires >= ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM revoked_sessions WHERE sid = ? AND expires >= ?
      )
      THEN 1 ELSE 0 END AS active
  `).get(storageId, now, storageId, now).active);
}

function sessionRecord(now, overrides = {}) {
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

export async function runSessionStateDisclosureRevocationPoc() {
  const db = createDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  const config = {
    sessionSecret: SESSION_SECRET,
    sessionAbsoluteHours: ABSOLUTE_TTL_MS / (60 * 60 * 1000),
    administratorAccessDisabled: false
  };
  const authorizeDisclosure = createFileDisclosureAuthorizer(db, config, {
    sessionId: SESSION_ID,
    userId: USER_ID,
    repositoryId: REPOSITORY_ID,
    fileId: FILE_ID
  });

  try {
    const now = Date.now();
    await invokeStore(store, 'set', SESSION_ID, sessionRecord(now));
    const initial = {
      legacyRowOnly: legacySessionRowIsActive(db, now),
      currentAuthorizer: authorizeDisclosure(now)
    };

    // Same storage identifier remains alive, but authentication is removed.
    await invokeStore(store, 'set', SESSION_ID, sessionRecord(now, {
      userId: undefined,
      authenticatedAt: undefined,
      sessionCreatedAt: undefined,
      authenticationFlow: { userId: USER_ID, createdAt: now }
    }));
    const afterAuthenticationRemoval = {
      legacyRowOnly: legacySessionRowIsActive(db, now + 1),
      currentAuthorizer: authorizeDisclosure(now + 1)
    };

    // The row expiry is still in the future, but the authenticated session's
    // absolute lifetime has elapsed.
    const staleCreatedAt = now - ABSOLUTE_TTL_MS - 1;
    await invokeStore(store, 'set', SESSION_ID, sessionRecord(now, {
      authenticatedAt: staleCreatedAt,
      sessionCreatedAt: staleCreatedAt
    }));
    const afterAbsoluteExpiry = {
      legacyRowOnly: legacySessionRowIsActive(db, now),
      currentAuthorizer: authorizeDisclosure(now)
    };

    return {
      absoluteTtlMs: ABSOLUTE_TTL_MS,
      initial,
      afterAuthenticationRemoval,
      afterAbsoluteExpiry,
      vulnerable: Boolean(
        initial.currentAuthorizer
        && afterAuthenticationRemoval.currentAuthorizer
        && afterAbsoluteExpiry.currentAuthorizer
      ),
      blocked: Boolean(
        initial.currentAuthorizer
        && !afterAuthenticationRemoval.currentAuthorizer
        && !afterAbsoluteExpiry.currentAuthorizer
      )
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runSessionStateDisclosureRevocationPoc();
  console.log(JSON.stringify(result, null, 2));
}
