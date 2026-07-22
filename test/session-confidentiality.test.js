import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateLegacySessionPayloads,
  purgeUserSessions,
  sessionStorageKey,
  SQLiteSessionStore
} from '../src/session-store.js';
import { purgeAdministratorSessions } from '../src/admin-access.js';
import { resolveWebAuthnSettings } from '../src/security-service.js';

const SESSION_SECRET = 'session-confidentiality-test-secret-with-at-least-thirty-two-characters';

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

function setSession(store, sid, value) {
  return new Promise((resolve, reject) => {
    store.set(sid, value, (error) => (error ? reject(error) : resolve()));
  });
}

function getSession(store, sid) {
  return new Promise((resolve, reject) => {
    store.get(sid, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

test('encrypts SQLite session payloads and authenticates them against their storage identifiers', async (t) => {
  const db = createSessionDatabase();
  const store = new SQLiteSessionStore(db, { secret: SESSION_SECRET, defaultTtlMs: 60_000 });
  t.after(() => db.close());

  const sid = 'sensitive-session-identifier';
  const storedSession = {
    cookie: { maxAge: 60_000 },
    userId: 42,
    csrfToken: 'confidential-csrf-token',
    webAuthnAuthentication: { userId: 42, challenge: 'confidential-passkey-challenge' }
  };
  await setSession(store, sid, storedSession);

  const storageId = sessionStorageKey(sid, SESSION_SECRET);
  const row = db.prepare('SELECT sid, sess FROM sessions WHERE sid = ?').get(storageId);
  assert.equal(row.sid, storageId);
  assert.match(row.sess, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(row.sess, /confidential-csrf-token|confidential-passkey-challenge|userId/);
  assert.deepEqual(await getSession(store, sid), storedSession);

  const replacementStorageId = sessionStorageKey('different-session-identifier', SESSION_SECRET);
  db.prepare('UPDATE sessions SET sid = ? WHERE sid = ?').run(replacementStorageId, storageId);
  assert.equal(await getSession(store, 'different-session-identifier'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('migrates valid legacy plaintext session rows before serving requests', async (t) => {
  const db = createSessionDatabase();
  t.after(() => db.close());

  const sid = 'legacy-session-identifier';
  const storageId = sessionStorageKey(sid, SESSION_SECRET);
  const legacySession = {
    cookie: { maxAge: 60_000 },
    userId: 7,
    csrfToken: 'legacy-plaintext-token'
  };
  db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run(
    storageId,
    JSON.stringify(legacySession),
    Date.now() + 60_000
  );

  assert.deepEqual(migrateLegacySessionPayloads(db, SESSION_SECRET), { migrated: 1, discarded: 0 });
  const encrypted = db.prepare('SELECT sess FROM sessions WHERE sid = ?').get(storageId).sess;
  assert.match(encrypted, /^v1\./);
  assert.doesNotMatch(encrypted, /legacy-plaintext-token/);

  const store = new SQLiteSessionStore(db, { secret: SESSION_SECRET, defaultTtlMs: 60_000 });
  assert.deepEqual(await getSession(store, sid), legacySession);
});

test('session purge operations inspect encrypted payloads without exposing their contents', async (t) => {
  const db = createSessionDatabase();
  const store = new SQLiteSessionStore(db, { secret: SESSION_SECRET, defaultTtlMs: 60_000 });
  t.after(() => db.close());

  db.prepare('INSERT INTO users (id, role) VALUES (?, ?)').run(1, 'ADMIN');
  db.prepare('INSERT INTO users (id, role) VALUES (?, ?)').run(2, 'USER');
  await setSession(store, 'admin-session', { cookie: { maxAge: 60_000 }, userId: 1 });
  await setSession(store, 'user-session-a', { cookie: { maxAge: 60_000 }, userId: 2 });
  await setSession(store, 'user-session-b', {
    cookie: { maxAge: 60_000 },
    pendingMfa: { userId: 2, createdAt: Date.now() }
  });

  assert.equal(purgeAdministratorSessions(db, SESSION_SECRET), 1);
  assert.equal(purgeUserSessions(db, 2, '', SESSION_SECRET), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('externally reachable WebAuthn flows require an explicit trusted origin and RP ID', () => {
  const request = {
    protocol: 'https',
    get(name) {
      assert.equal(name, 'host');
      return 'attacker-controlled.example';
    }
  };
  const externalConfig = {
    isProduction: false,
    externallyReachable: true,
    webAuthnOrigin: '',
    webAuthnRpId: '',
    webAuthnRpName: 'RecordDrive'
  };

  assert.throws(
    () => resolveWebAuthnSettings(request, externalConfig),
    /WEBAUTHN_ORIGIN must be configured/
  );
  assert.deepEqual(resolveWebAuthnSettings(request, {
    ...externalConfig,
    webAuthnOrigin: 'https://drive.example.com',
    webAuthnRpId: 'drive.example.com'
  }), {
    origin: 'https://drive.example.com',
    rpID: 'drive.example.com',
    rpName: 'RecordDrive'
  });
});

test('user-facing routes do not load complete secret-bearing user rows', () => {
  const routeFiles = [
    new URL('../src/routes/admin.js', import.meta.url),
    new URL('../src/routes/auth.js', import.meta.url),
    new URL('../src/routes/repositories.js', import.meta.url)
  ];
  for (const routeFile of routeFiles) {
    const source = fs.readFileSync(routeFile, 'utf8');
    assert.doesNotMatch(source, /SELECT\s+(?:u\.)?\*\s+FROM\s+users/i);
  }
});
