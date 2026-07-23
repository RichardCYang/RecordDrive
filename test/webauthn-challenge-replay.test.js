import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  consumeWebAuthnChallenge,
  ensureWebAuthnChallengeSchema,
  issueWebAuthnChallenge
} from '../src/webauthn-challenge-store.js';

const SESSION_SECRET = 'webauthn-challenge-test-secret-at-least-thirty-two-characters';
const SESSION_ID = 'pending-mfa-session-id';
const USER_ID = 7;
const NOW = 1_800_000_000_000;

function createDatabase() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    INSERT INTO users (id) VALUES (${USER_ID});
  `);
  ensureWebAuthnChallengeSchema(db);
  return db;
}

function issue(db, overrides = {}) {
  const options = {
    sessionId: SESSION_ID,
    sessionSecret: SESSION_SECRET,
    userId: USER_ID,
    purpose: 'authentication',
    challenge: 'signed-webauthn-challenge',
    now: NOW,
    expiresAt: NOW + 60_000,
    ...overrides
  };
  return {
    id: issueWebAuthnChallenge(db, options),
    options
  };
}

test('stores only protected WebAuthn challenge bindings', () => {
  const db = createDatabase();
  try {
    issue(db);
    const row = db.prepare('SELECT * FROM webauthn_challenges').get();
    assert.equal(row.user_id, USER_ID);
    assert.equal(row.purpose, 'authentication');
    assert.notEqual(row.session_key, SESSION_ID);
    assert.notEqual(row.challenge_hash, 'signed-webauthn-challenge');
    assert.match(row.session_key, /^[a-f0-9]{64}$/);
    assert.match(row.challenge_hash, /^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});

test('atomically accepts a WebAuthn challenge exactly once', async () => {
  const db = createDatabase();
  try {
    const { id, options } = issue(db);
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const attempts = [1, 2].map(async () => {
      await barrier;
      return consumeWebAuthnChallenge(db, {
        challengeId: id,
        ...options
      });
    });
    release();
    const accepted = (await Promise.all(attempts)).filter(Boolean).length;
    assert.equal(accepted, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webauthn_challenges').get().count, 0);
  } finally {
    db.close();
  }
});

test('binds challenge consumption to session, user, purpose, value, and expiry', () => {
  const cases = [
    { sessionId: 'other-session' },
    { userId: USER_ID + 1 },
    { purpose: 'registration' },
    { challenge: 'different-challenge' },
    { now: NOW + 60_001 }
  ];

  for (const mutation of cases) {
    const db = createDatabase();
    try {
      if (mutation.userId === USER_ID + 1) db.prepare('INSERT INTO users (id) VALUES (?)').run(USER_ID + 1);
      const { id, options } = issue(db);
      assert.equal(consumeWebAuthnChallenge(db, {
        challengeId: id,
        ...options,
        ...mutation
      }), false);
    } finally {
      db.close();
    }
  }
});

test('issuing a replacement invalidates the older challenge for the same session and purpose', () => {
  const db = createDatabase();
  try {
    const first = issue(db, { challenge: 'first-challenge' });
    const second = issue(db, { challenge: 'second-challenge' });
    assert.equal(consumeWebAuthnChallenge(db, { challengeId: first.id, ...first.options }), false);
    assert.equal(consumeWebAuthnChallenge(db, { challengeId: second.id, ...second.options }), true);
  } finally {
    db.close();
  }
});

test('routes consume the ledger entry before cryptographic verification and guard counter updates', () => {
  const authSource = fs.readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8');
  const settingsSource = fs.readFileSync(new URL('../src/routes/settings.js', import.meta.url), 'utf8');

  const authVerifyRoute = authSource.indexOf("router.post('/login/mfa/passkey/verify'");
  const authConsume = authSource.indexOf('consumeWebAuthnChallenge(db', authVerifyRoute);
  const authVerify = authSource.indexOf('verifyAuthenticationResponse({', authVerifyRoute);
  assert.ok(authVerifyRoute >= 0 && authConsume > authVerifyRoute && authVerify > authConsume);
  assert.match(authSource, /WHERE id = \? AND user_id = \? AND counter = \?/);
  assert.match(authSource, /if \(counterUpdate\.changes !== 1\)/);

  const registrationRoute = settingsSource.indexOf("router.post('/settings/security/passkeys/verify'");
  const registrationConsume = settingsSource.indexOf('consumeWebAuthnChallenge(db', registrationRoute);
  const registrationVerify = settingsSource.indexOf('verifyRegistrationResponse({', registrationRoute);
  assert.ok(registrationRoute >= 0 && registrationConsume > registrationRoute && registrationVerify > registrationConsume);
});
