import { DatabaseSync } from 'node:sqlite';
import {
  purgeUserSessions,
  sessionStorageKey,
  SQLiteSessionStore
} from '../src/session-store.js';

const secret = 'session-revocation-poc-secret-at-least-thirty-two-characters';
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
`);
const store = new SQLiteSessionStore(db, {
  secret,
  defaultTtlMs: 60_000,
  cleanupIntervalMs: 3_600_000
});
const invoke = (method, ...args) => new Promise((resolve, reject) => {
  store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
});

const stolenSid = 'attacker-controlled-stolen-session';
const currentSid = 'account-owner-current-session';
const storedSession = {
  cookie: { maxAge: 60_000, originalMaxAge: 60_000 },
  userId: 7,
  authenticatedAt: Date.now()
};

await invoke('set', stolenSid, storedSession);
await invoke('set', currentSid, storedSession);
const inFlightCopy = await invoke('get', stolenSid);
const purged = purgeUserSessions(db, 7, currentSid, secret);
const storageId = sessionStorageKey(stolenSid, secret);
const rowsAfterPurge = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?')
  .get(storageId).count;
const tombstonesAfterPurge = db.prepare('SELECT COUNT(*) AS count FROM revoked_sessions WHERE sid = ?')
  .get(storageId).count;

await invoke('touch', stolenSid, inFlightCopy);
const resurrected = Boolean(await invoke('get', stolenSid));
const rowsAfterDelayedTouch = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?')
  .get(storageId).count;

const result = {
  purged,
  rowsAfterPurge,
  tombstonesAfterPurge,
  delayedTouchAttempted: true,
  resurrected,
  rowsAfterDelayedTouch,
  verdict: resurrected ? 'VULNERABLE' : 'BLOCKED'
};
console.log(JSON.stringify(result, null, 2));
db.close();
if (resurrected) process.exitCode = 1;
