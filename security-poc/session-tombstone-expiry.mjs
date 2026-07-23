import { DatabaseSync } from 'node:sqlite';
import {
  sessionStorageKey,
  SQLiteSessionStore
} from '../src/session-store.js';

const SECRET = 'session-tombstone-expiry-poc-secret-at-least-thirty-two-characters';
const ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
  `);
  return db;
}

function invoke(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

async function delayedTouchAfterTombstoneExpiry() {
  const db = createDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SECRET,
    defaultTtlMs: 60_000,
    absoluteTtlMs: ABSOLUTE_TTL_MS,
    revocationTtlMs: ABSOLUTE_TTL_MS,
    cleanupIntervalMs: 3_600_000
  });
  const sid = 'stolen-session-delayed-touch';
  const now = Date.now();
  const session = {
    cookie: { maxAge: 60_000, originalMaxAge: 60_000 },
    userId: 7,
    authenticatedAt: now,
    sessionCreatedAt: now
  };

  try {
    await invoke(store, 'set', sid, session);
    const staleCopy = structuredClone(await invoke(store, 'get', sid));
    await invoke(store, 'destroy', sid);

    const storageId = sessionStorageKey(sid, SECRET);
    db.prepare('UPDATE revoked_sessions SET expires = ? WHERE sid = ?')
      .run(Date.now() - 1, storageId);
    await invoke(store, 'touch', sid, staleCopy);

    const resurrected = await invoke(store, 'get', sid);
    return {
      tombstoneForcedExpired: true,
      delayedTouchAttempted: true,
      delayedTouchResurrected: Boolean(resurrected),
      storedRows: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?')
        .get(storageId).count
    };
  } finally {
    clearInterval(store.cleanupTimer);
    db.close();
  }
}

async function staleSetAfterAbsoluteExpiry() {
  const db = createDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SECRET,
    defaultTtlMs: 60_000,
    absoluteTtlMs: ABSOLUTE_TTL_MS,
    revocationTtlMs: ABSOLUTE_TTL_MS,
    cleanupIntervalMs: 3_600_000
  });
  const sid = 'stolen-session-stale-set';
  const now = Date.now();
  const session = {
    cookie: { maxAge: 60_000, originalMaxAge: 60_000 },
    userId: 8,
    authenticatedAt: now,
    sessionCreatedAt: now
  };

  try {
    await invoke(store, 'set', sid, session);
    await invoke(store, 'destroy', sid);

    const storageId = sessionStorageKey(sid, SECRET);
    db.prepare('UPDATE revoked_sessions SET expires = ? WHERE sid = ?')
      .run(Date.now() - 1, storageId);
    const expiredCreatedAt = Date.now() - ABSOLUTE_TTL_MS - 1;
    await invoke(store, 'set', sid, {
      ...session,
      authenticatedAt: expiredCreatedAt,
      sessionCreatedAt: expiredCreatedAt
    });

    const resurrected = await invoke(store, 'get', sid);
    return {
      tombstoneForcedExpired: true,
      absoluteLifetimeExceeded: true,
      staleSetResurrected: Boolean(resurrected),
      storedRows: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?')
        .get(storageId).count
    };
  } finally {
    clearInterval(store.cleanupTimer);
    db.close();
  }
}

const delayedTouch = await delayedTouchAfterTombstoneExpiry();
const staleSet = await staleSetAfterAbsoluteExpiry();
const vulnerable = delayedTouch.delayedTouchResurrected || staleSet.staleSetResurrected;
const result = {
  delayedTouch,
  staleSet,
  verdict: vulnerable ? 'VULNERABLE' : 'BLOCKED'
};

console.log(JSON.stringify(result, null, 2));
if (vulnerable) process.exitCode = 1;
