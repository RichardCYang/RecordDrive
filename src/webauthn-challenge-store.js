import crypto from 'node:crypto';
const CHALLENGE_KEY_CONTEXT = 'recorddrive/webauthn-challenge/v1';
const CHALLENGE_SESSION_KEY_CONTEXT = 'recorddrive/webauthn-challenge-session/v1';
const CHALLENGE_PURPOSES = new Set(['authentication', 'registration']);
const CHALLENGE_ID_BYTES = 32;

function normalizeSecret(secret) {
  const candidate = Array.isArray(secret) ? secret[0] : secret;
  const normalized = String(candidate || '');
  if (!normalized) throw new Error('A session secret is required for WebAuthn challenge protection.');
  return normalized;
}

function normalizeUserId(userId) {
  const normalized = Number(userId);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error('A valid user identifier is required for a WebAuthn challenge.');
  }
  return normalized;
}

function normalizePurpose(purpose) {
  const normalized = String(purpose || '');
  if (!CHALLENGE_PURPOSES.has(normalized)) {
    throw new Error('A valid WebAuthn challenge purpose is required.');
  }
  return normalized;
}

function normalizeChallenge(challenge) {
  const normalized = String(challenge || '');
  if (!normalized) throw new Error('A WebAuthn challenge value is required.');
  return normalized;
}

function normalizeExpiry(expiresAt) {
  const normalized = Number(expiresAt);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error('A valid WebAuthn challenge expiry is required.');
  }
  return normalized;
}


function challengeSessionKey(sessionId, secret) {
  const normalizedSessionId = String(sessionId || '');
  if (!normalizedSessionId) throw new Error('A session identifier is required for a WebAuthn challenge.');
  const key = crypto.createHmac('sha256', normalizeSecret(secret))
    .update(CHALLENGE_SESSION_KEY_CONTEXT)
    .digest();
  return crypto.createHmac('sha256', key).update(normalizedSessionId).digest('hex');
}

function challengeDigest({ challenge, sessionKey, userId, purpose }, secret) {
  const key = crypto.createHmac('sha256', normalizeSecret(secret))
    .update(CHALLENGE_KEY_CONTEXT)
    .digest();
  return crypto.createHmac('sha256', key)
    .update(String(sessionKey))
    .update('\0')
    .update(String(userId))
    .update('\0')
    .update(String(purpose))
    .update('\0')
    .update(normalizeChallenge(challenge))
    .digest('hex');
}

export function ensureWebAuthnChallengeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('authentication', 'registration')),
      challenge_hash TEXT NOT NULL,
      expires INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry
      ON webauthn_challenges(expires);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_challenges_session_purpose
      ON webauthn_challenges(session_key, purpose);
  `);
}

export function issueWebAuthnChallenge(db, options) {
  const now = Number(options?.now ?? Date.now());
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('A valid current time is required.');

  const userId = normalizeUserId(options?.userId);
  const purpose = normalizePurpose(options?.purpose);
  const expires = normalizeExpiry(options?.expiresAt);
  if (expires <= now) throw new Error('The WebAuthn challenge expiry must be in the future.');

  const sessionKey = challengeSessionKey(options?.sessionId, options?.sessionSecret);
  const hash = challengeDigest({
    challenge: options?.challenge,
    sessionKey,
    userId,
    purpose
  }, options?.sessionSecret);
  const challengeId = crypto.randomBytes(CHALLENGE_ID_BYTES).toString('base64url');

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM webauthn_challenges WHERE expires < ?').run(now);
    db.prepare(`
      DELETE FROM webauthn_challenges
      WHERE session_key = ? AND purpose = ?
    `).run(sessionKey, purpose);
    db.prepare(`
      INSERT INTO webauthn_challenges (
        id, session_key, user_id, purpose, challenge_hash, expires
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(challengeId, sessionKey, userId, purpose, hash, expires);
    db.exec('COMMIT;');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    throw error;
  }

  return challengeId;
}

export function consumeWebAuthnChallenge(db, options) {
  const now = Number(options?.now ?? Date.now());
  if (!Number.isSafeInteger(now) || now < 0) return false;

  let sessionKey;
  let userId;
  let purpose;
  let hash;
  try {
    sessionKey = challengeSessionKey(options?.sessionId, options?.sessionSecret);
    userId = normalizeUserId(options?.userId);
    purpose = normalizePurpose(options?.purpose);
    hash = challengeDigest({
      challenge: options?.challenge,
      sessionKey,
      userId,
      purpose
    }, options?.sessionSecret);
  } catch {
    return false;
  }

  const challengeId = String(options?.challengeId || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(challengeId)) return false;

  const result = db.prepare(`
    DELETE FROM webauthn_challenges
    WHERE id = ?
      AND session_key = ?
      AND user_id = ?
      AND purpose = ?
      AND challenge_hash = ?
      AND expires >= ?
  `).run(challengeId, sessionKey, userId, purpose, hash, now);

  return result.changes === 1;
}
