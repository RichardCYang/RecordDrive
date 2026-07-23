import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  pruneUserSessions,
  purgeUserSessions,
  sessionStorageKey,
  SQLiteSessionStore
} from '../src/session-store.js';
import { purgeAdministratorSessions } from '../src/admin-access.js';

const SESSION_SECRET = 'session-revocation-race-test-secret-at-least-thirty-two-characters';

function createSessionDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL
    );
    CREATE TABLE sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
  `);
  return db;
}

function invokeStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

test('a purged session cannot be resurrected by an in-flight touch', async (t) => {
  const db = createSessionDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  const stolenSid = 'stolen-session-id';
  const currentSid = 'current-session-id';
  const session = {
    cookie: { maxAge: 60_000, originalMaxAge: 60_000 },
    userId: 9,
    authenticatedAt: Date.now()
  };
  await invokeStore(store, 'set', stolenSid, session);
  await invokeStore(store, 'set', currentSid, session);

  // Simulate a request that loaded the stolen session immediately before the
  // account owner changed a password or MFA factor in another request.
  const inFlightSession = await invokeStore(store, 'get', stolenSid);
  assert.deepEqual(inFlightSession, session);
  assert.equal(purgeUserSessions(db, 9, currentSid, SESSION_SECRET), 1);

  const storageId = sessionStorageKey(stolenSid, SESSION_SECRET);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?').get(storageId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM revoked_sessions WHERE sid = ?').get(storageId).count, 1);

  // express-session can call store.touch() as the older request finishes. The
  // tombstone must make that delayed write a no-op instead of an UPSERT.
  await invokeStore(store, 'touch', stolenSid, inFlightSession);
  assert.equal(await invokeStore(store, 'get', stolenSid), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?').get(storageId).count, 0);
});

test('destroy tombstones a session so concurrent logout requests cannot restore it', async (t) => {
  const db = createSessionDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  const sid = 'logout-race-session-id';
  const session = {
    cookie: { maxAge: 60_000, originalMaxAge: 60_000 },
    userId: 11,
    authenticatedAt: Date.now()
  };
  await invokeStore(store, 'set', sid, session);
  const inFlightSession = await invokeStore(store, 'get', sid);

  await invokeStore(store, 'destroy', sid);
  await invokeStore(store, 'touch', sid, inFlightSession);

  assert.equal(await invokeStore(store, 'get', sid), null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM revoked_sessions WHERE sid = ?')
      .get(sessionStorageKey(sid, SESSION_SECRET)).count,
    1
  );
});

test('a delayed touch cannot recreate a missing row after its tombstone expires', async (t) => {
  const db = createSessionDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    absoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
    revocationTtlMs: 7 * 24 * 60 * 60 * 1000,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  const sid = 'expired-tombstone-delayed-touch-session-id';
  const session = {
    cookie: { maxAge: 60_000, originalMaxAge: 60_000 },
    userId: 12,
    authenticatedAt: Date.now(),
    sessionCreatedAt: Date.now()
  };
  await invokeStore(store, 'set', sid, session);
  const inFlightSession = await invokeStore(store, 'get', sid);
  await invokeStore(store, 'destroy', sid);

  const storageId = sessionStorageKey(sid, SESSION_SECRET);
  db.prepare('UPDATE revoked_sessions SET expires = ? WHERE sid = ?').run(Date.now() - 1, storageId);

  await invokeStore(store, 'touch', sid, inFlightSession);

  assert.equal(await invokeStore(store, 'get', sid), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?').get(storageId).count, 0);
});

test('an absolutely expired stale set cannot recreate a revoked session', async (t) => {
  const db = createSessionDatabase();
  const absoluteTtlMs = 60_000;
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    absoluteTtlMs,
    revocationTtlMs: absoluteTtlMs,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  const sid = 'absolutely-expired-stale-set-session-id';
  const createdAt = Date.now();
  const session = {
    cookie: { maxAge: 60_000, originalMaxAge: 60_000 },
    userId: 14,
    authenticatedAt: createdAt,
    sessionCreatedAt: createdAt
  };
  await invokeStore(store, 'set', sid, session);
  await invokeStore(store, 'destroy', sid);

  const storageId = sessionStorageKey(sid, SESSION_SECRET);
  db.prepare('UPDATE revoked_sessions SET expires = ? WHERE sid = ?').run(Date.now() - 1, storageId);
  const staleSession = {
    ...session,
    authenticatedAt: Date.now() - absoluteTtlMs - 1,
    sessionCreatedAt: Date.now() - absoluteTtlMs - 1
  };

  await invokeStore(store, 'set', sid, staleSession);

  assert.equal(await invokeStore(store, 'get', sid), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?').get(storageId).count, 0);
});


test('session-limit pruning cannot be undone by a delayed touch', async (t) => {
  const db = createSessionDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  const oldestSid = 'oldest-limited-session-id';
  const currentSid = 'current-limited-session-id';
  await invokeStore(store, 'set', oldestSid, {
    cookie: { maxAge: 60_000 },
    userId: 15,
    authenticatedAt: Date.now() - 10_000
  });
  await invokeStore(store, 'set', currentSid, {
    cookie: { maxAge: 60_000 },
    userId: 15,
    authenticatedAt: Date.now()
  });
  const inFlightSession = await invokeStore(store, 'get', oldestSid);

  assert.equal(pruneUserSessions(db, 15, currentSid, 1, SESSION_SECRET), 1);
  await invokeStore(store, 'touch', oldestSid, inFlightSession);

  assert.equal(await invokeStore(store, 'get', oldestSid), null);
  assert.notEqual(await invokeStore(store, 'get', currentSid), null);
});

test('administrator-session purge cannot be undone by a delayed touch', async (t) => {
  const db = createSessionDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  db.prepare('INSERT INTO users (id, role) VALUES (?, ?)').run(17, 'ADMIN');
  const sid = 'disabled-administrator-session-id';
  await invokeStore(store, 'set', sid, {
    cookie: { maxAge: 60_000 },
    userId: 17,
    authenticatedAt: Date.now()
  });
  const inFlightSession = await invokeStore(store, 'get', sid);

  assert.equal(purgeAdministratorSessions(db, SESSION_SECRET), 1);
  await invokeStore(store, 'touch', sid, inFlightSession);

  assert.equal(await invokeStore(store, 'get', sid), null);
});

test('an expired tombstone does not permanently reserve a session identifier', async (t) => {
  const db = createSessionDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  t.after(() => db.close());

  const sid = 'expired-tombstone-session-id';
  const session = { cookie: { maxAge: 60_000 }, userId: 13 };
  await invokeStore(store, 'set', sid, session);
  await invokeStore(store, 'destroy', sid);

  db.prepare('UPDATE revoked_sessions SET expires = ? WHERE sid = ?').run(
    Date.now() - 1,
    sessionStorageKey(sid, SESSION_SECRET)
  );
  await invokeStore(store, 'set', sid, session);

  assert.deepEqual(await invokeStore(store, 'get', sid), session);
});

test('legacy raw session rows are deleted without persisting browser session identifiers', (t) => {
  const db = createSessionDatabase();
  t.after(() => db.close());

  db.prepare('INSERT INTO users (id, role) VALUES (?, ?)').run(19, 'ADMIN');
  const rawSid = 'legacy-browser-visible-session-id';
  db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run(
    rawSid,
    JSON.stringify({ userId: 19, cookie: { maxAge: 60_000 } }),
    Date.now() + 60_000
  );

  assert.equal(purgeAdministratorSessions(db, SESSION_SECRET), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?').get(rawSid).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM revoked_sessions WHERE sid = ?').get(rawSid).count, 0);
});
