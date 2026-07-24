import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createStoredSessionActivityChecker,
  purgeUserSessions,
  SQLiteSessionStore
} from '../src/session-store.js';
import { createRecoveryCodes, replaceRecoveryCodes } from '../src/security-service.js';

const sessionSecret = 'recovery-session-poc-secret-at-least-thirty-two-characters';
const config = {
  mfaEncryptionKey: 'recovery-code-poc-encryption-key-at-least-thirty-two-characters',
  sessionSecret
};
const userId = 7;
const currentSid = 'account-owner-current-session';
const stolenSid = 'attacker-controlled-stolen-session';
const now = Date.now();
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    used_at TEXT
  );
`);

const store = new SQLiteSessionStore(db, {
  secret: sessionSecret,
  defaultTtlMs: 60_000,
  cleanupIntervalMs: 3_600_000
});
const invoke = (method, ...args) => new Promise((resolve, reject) => {
  store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
});
const storedSession = {
  cookie: { maxAge: 60_000, originalMaxAge: 60_000 },
  userId,
  authenticatedAt: now,
  sessionCreatedAt: now
};

await invoke('set', stolenSid, storedSession);
await invoke('set', currentSid, storedSession);
createRecoveryCodes(db, userId, config, 1);
replaceRecoveryCodes(db, userId, config, 1);

const baselineStolenSessionActive = createStoredSessionActivityChecker(
  db,
  stolenSid,
  sessionSecret,
  { userId, absoluteTtlMs: 60_000 }
)(now);

const revokedOtherSessions = purgeUserSessions(
  db,
  userId,
  currentSid,
  sessionSecret,
  60_000
);
const patchedStolenSessionActive = createStoredSessionActivityChecker(
  db,
  stolenSid,
  sessionSecret,
  { userId, absoluteTtlMs: 60_000 }
)(now);
const currentSessionActive = createStoredSessionActivityChecker(
  db,
  currentSid,
  sessionSecret,
  { userId, absoluteTtlMs: 60_000 }
)(now);

assert.equal(baselineStolenSessionActive, true);
assert.equal(revokedOtherSessions, 1);
assert.equal(patchedStolenSessionActive, false);
assert.equal(currentSessionActive, true);

const rollbackDb = new DatabaseSync(':memory:');
rollbackDb.exec(`
  CREATE TABLE recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    used_at TEXT
  );
  INSERT INTO recovery_codes (user_id, code_hash)
  VALUES (${userId}, 'existing-recovery-code-hash');
  CREATE TRIGGER reject_recovery_code_insert
  BEFORE INSERT ON recovery_codes
  BEGIN
    SELECT RAISE(ABORT, 'forced insertion failure');
  END;
`);
let replacementFailed = false;
try {
  replaceRecoveryCodes(rollbackDb, userId, config, 1);
} catch {
  replacementFailed = true;
}
const retainedCodesAfterFailure = rollbackDb.prepare(`
  SELECT COUNT(*) AS count
  FROM recovery_codes
  WHERE user_id = ? AND code_hash = 'existing-recovery-code-hash'
`).get(userId).count;
assert.equal(replacementFailed, true);
assert.equal(retainedCodesAfterFailure, 1);

console.log(JSON.stringify({
  finding: 'Recovery-key rotation did not revoke other authenticated sessions',
  baseline: {
    recoveryKeysRotated: true,
    stolenSessionStillActive: baselineStolenSessionActive,
    verdict: baselineStolenSessionActive ? 'VULNERABLE' : 'BLOCKED'
  },
  patched: {
    revokedOtherSessions,
    stolenSessionStillActive: patchedStolenSessionActive,
    currentSessionActive,
    verdict: !patchedStolenSessionActive && currentSessionActive ? 'BLOCKED' : 'VULNERABLE'
  },
  transactionalReplacement: {
    forcedInsertionFailure: replacementFailed,
    previousRecoveryKeyRowsRetained: retainedCodesAfterFailure,
    verdict: replacementFailed && retainedCodesAfterFailure === 1 ? 'ROLLED_BACK' : 'DATA_LOSS'
  }
}, null, 2));

rollbackDb.close();
db.close();
