import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  createStoredSessionActivityChecker,
  purgeUserSessions,
  SQLiteSessionStore
} from '../src/session-store.js';
import { createRecoveryCodes, replaceRecoveryCodes } from '../src/security-service.js';

const SESSION_SECRET = 'recovery-session-test-secret-at-least-thirty-two-characters';
const MFA_CONFIG = {
  mfaEncryptionKey: 'recovery-code-test-encryption-key-at-least-thirty-two-characters',
  sessionSecret: SESSION_SECRET
};

function routeBlock(source, routePath, nextRoutePath) {
  const start = source.indexOf(`router.post('${routePath}'`);
  const end = source.indexOf(`router.post('${nextRoutePath}'`, start + 1);
  assert.notEqual(start, -1, `${routePath} route must exist`);
  assert.notEqual(end, -1, `${nextRoutePath} route must follow ${routePath}`);
  return source.slice(start, end);
}

function createRecoveryCodeDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      used_at TEXT
    );
  `);
  return db;
}

function createSessionDatabase() {
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

function invokeStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

test('recovery-key add and regenerate routes revoke every other authenticated session', () => {
  const source = fs.readFileSync(new URL('../src/routes/settings.js', import.meta.url), 'utf8');
  const addRoute = routeBlock(
    source,
    '/settings/security/recovery-codes/add',
    '/settings/security/recovery-codes/regenerate'
  );
  const regenerateRoute = routeBlock(
    source,
    '/settings/security/recovery-codes/regenerate',
    '/settings/security/passkeys/options'
  );

  assert.match(addRoute, /storeNewRecoveryCodes[\s\S]*revokeOtherUserSessions\(req, db, config\)/);
  assert.match(regenerateRoute, /replaceRecoveryCodes[\s\S]*revokeOtherUserSessions\(req, db, config\)/);
});

test('recovery-key rotation can preserve the current browser while invalidating a stolen session', async () => {
  const db = createSessionDatabase();
  const store = new SQLiteSessionStore(db, {
    secret: SESSION_SECRET,
    defaultTtlMs: 60_000,
    cleanupIntervalMs: 3_600_000
  });
  const now = Date.now();
  const userId = 42;
  const currentSid = 'current-session';
  const stolenSid = 'stolen-session';
  const storedSession = {
    cookie: { maxAge: 60_000, originalMaxAge: 60_000 },
    userId,
    authenticatedAt: now,
    sessionCreatedAt: now
  };

  try {
    await invokeStore(store, 'set', currentSid, storedSession);
    await invokeStore(store, 'set', stolenSid, storedSession);

    const stolenSessionActive = createStoredSessionActivityChecker(
      db,
      stolenSid,
      SESSION_SECRET,
      { userId, absoluteTtlMs: 60_000 }
    );
    const currentSessionActive = createStoredSessionActivityChecker(
      db,
      currentSid,
      SESSION_SECRET,
      { userId, absoluteTtlMs: 60_000 }
    );

    assert.equal(stolenSessionActive(now), true);
    assert.equal(purgeUserSessions(db, userId, currentSid, SESSION_SECRET, 60_000), 1);
    assert.equal(stolenSessionActive(now), false);
    assert.equal(currentSessionActive(now), true);
  } finally {
    db.close();
  }
});

test('failed recovery-key replacement rolls back instead of deleting the previous keys', () => {
  const db = createRecoveryCodeDatabase();
  const userId = 9;
  db.prepare(`
    INSERT INTO recovery_codes (user_id, code_hash)
    VALUES (?, 'existing-recovery-code-hash')
  `).run(userId);
  db.exec(`
    CREATE TRIGGER reject_recovery_code_insert
    BEFORE INSERT ON recovery_codes
    BEGIN
      SELECT RAISE(ABORT, 'forced insertion failure');
    END;
  `);

  try {
    assert.throws(
      () => replaceRecoveryCodes(db, userId, MFA_CONFIG, 1),
      /forced insertion failure/
    );
    const retained = db.prepare(`
      SELECT COUNT(*) AS count
      FROM recovery_codes
      WHERE user_id = ? AND code_hash = 'existing-recovery-code-hash'
    `).get(userId).count;
    assert.equal(retained, 1);
  } finally {
    db.close();
  }
});

test('successful recovery-key replacement commits only the new bounded key set', () => {
  const db = createRecoveryCodeDatabase();
  const userId = 11;

  try {
    const originalCodes = createRecoveryCodes(db, userId, MFA_CONFIG, 2);
    const replacementCodes = replaceRecoveryCodes(db, userId, MFA_CONFIG, 3);
    const rowCount = db.prepare(`
      SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ?
    `).get(userId).count;

    assert.equal(originalCodes.length, 2);
    assert.equal(replacementCodes.length, 3);
    assert.equal(rowCount, 3);
  } finally {
    db.close();
  }
});
