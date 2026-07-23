import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  consumeWebAuthnChallenge,
  ensureWebAuthnChallengeSchema,
  issueWebAuthnChallenge
} from '../src/webauthn-challenge-store.js';

const secret = 'webauthn-replay-poc-secret-at-least-thirty-two-characters';
const sessionId = 'stolen-or-relayed-pending-mfa-session';
const userId = 7;
const challenge = 'captured-valid-signed-challenge';
const now = Date.now();

let releaseLegacy;
const legacyBarrier = new Promise((resolve) => { releaseLegacy = resolve; });
const vulnerableSession = {
  webAuthnAuthentication: { challenge, userId }
};
const legacyAttempts = [1, 2].map(async () => {
  const requestLocalSession = structuredClone(vulnerableSession);
  const observed = requestLocalSession.webAuthnAuthentication;
  await legacyBarrier;
  if (!observed) return false;
  delete requestLocalSession.webAuthnAuthentication;
  return true;
});
releaseLegacy();
const legacyAccepted = (await Promise.all(legacyAttempts)).filter(Boolean).length;

const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY);
  INSERT INTO users (id) VALUES (${userId});
`);
ensureWebAuthnChallengeSchema(db);
const challengeId = issueWebAuthnChallenge(db, {
  sessionId,
  sessionSecret: secret,
  userId,
  purpose: 'authentication',
  challenge,
  now,
  expiresAt: now + 60_000
});
const stored = db.prepare('SELECT session_key, challenge_hash FROM webauthn_challenges').get();

let releasePatched;
const patchedBarrier = new Promise((resolve) => { releasePatched = resolve; });
const patchedAttempts = [1, 2].map(async () => {
  await patchedBarrier;
  return consumeWebAuthnChallenge(db, {
    challengeId,
    sessionId,
    sessionSecret: secret,
    userId,
    purpose: 'authentication',
    challenge,
    now
  });
});
releasePatched();
const patchedAccepted = (await Promise.all(patchedAttempts)).filter(Boolean).length;

const authSource = fs.readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8');
const result = {
  baseline: {
    parallelRequests: 2,
    acceptedWithSessionOnlyDeletion: legacyAccepted,
    vulnerable: legacyAccepted === 2
  },
  patched: {
    parallelRequests: 2,
    acceptedWithAtomicLedger: patchedAccepted,
    replayBlocked: patchedAccepted === 1,
    rawSessionIdStored: stored.session_key === sessionId,
    rawChallengeStored: stored.challenge_hash === challenge,
    counterCompareAndSwapPresent: /WHERE id = \? AND user_id = \? AND counter = \?/.test(authSource)
  }
};
result.verdict = result.baseline.vulnerable
  && result.patched.replayBlocked
  && !result.patched.rawSessionIdStored
  && !result.patched.rawChallengeStored
  && result.patched.counterCompareAndSwapPresent
  ? 'BLOCKED'
  : 'FAILED';

console.log(JSON.stringify(result, null, 2));
db.close();
if (result.verdict !== 'BLOCKED') process.exitCode = 1;
