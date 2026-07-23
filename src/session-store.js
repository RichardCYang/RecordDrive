import crypto from 'node:crypto';
import session from 'express-session';

const SESSION_STORE_KEY_CONTEXT = 'recorddrive/session-store/v1';
const SESSION_PAYLOAD_KEY_CONTEXT = 'recorddrive/session-payload/v1';
const SESSION_PAYLOAD_AAD_CONTEXT = 'recorddrive/session-payload/v1';
const SESSION_PAYLOAD_VERSION = 'v1';
const SESSION_PAYLOAD_IV_BYTES = 12;
const SESSION_PAYLOAD_TAG_BYTES = 16;
const MINIMUM_REVOCATION_TTL_MS = 60_000;

function normalizeSessionSecret(secret) {
  const candidate = Array.isArray(secret) ? secret[0] : secret;
  const normalized = String(candidate || '');
  if (!normalized) throw new Error('A session secret is required for protected session storage.');
  return normalized;
}

function deriveKey(secret, context) {
  return crypto.createHmac('sha256', normalizeSessionSecret(secret))
    .update(context)
    .digest();
}

function createSessionStorageKeyFactory(secret) {
  const derivedKey = deriveKey(secret, SESSION_STORE_KEY_CONTEXT);
  return (sid) => {
    const normalizedSid = String(sid || '');
    if (!normalizedSid) throw new Error('A session identifier is required.');
    return crypto.createHmac('sha256', derivedKey).update(normalizedSid).digest('hex');
  };
}

function normalizeStorageId(storageId) {
  const normalized = String(storageId || '');
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new Error('A protected session storage identifier is required.');
  }
  return normalized.toLowerCase();
}

function sessionPayloadAdditionalData(storageId) {
  return Buffer.from(`${SESSION_PAYLOAD_AAD_CONTEXT}\0${normalizeStorageId(storageId)}`, 'utf8');
}

export function createSessionPayloadProtector(secret) {
  const encryptionKey = deriveKey(secret, SESSION_PAYLOAD_KEY_CONTEXT);

  return {
    encrypt(storedSession, storageId) {
      const iv = crypto.randomBytes(SESSION_PAYLOAD_IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv, {
        authTagLength: SESSION_PAYLOAD_TAG_BYTES
      });
      cipher.setAAD(sessionPayloadAdditionalData(storageId));
      const plaintext = Buffer.from(JSON.stringify(storedSession), 'utf8');
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authenticationTag = cipher.getAuthTag();
      return [
        SESSION_PAYLOAD_VERSION,
        iv.toString('base64url'),
        authenticationTag.toString('base64url'),
        ciphertext.toString('base64url')
      ].join('.');
    },

    decrypt(serializedSession, storageId) {
      const serialized = String(serializedSession || '');
      if (!serialized.startsWith(`${SESSION_PAYLOAD_VERSION}.`)) {
        return { session: JSON.parse(serialized), legacyPlaintext: true };
      }

      const parts = serialized.split('.');
      if (parts.length !== 4 || parts[0] !== SESSION_PAYLOAD_VERSION) {
        throw new Error('The protected session payload has an invalid format.');
      }
      const iv = Buffer.from(parts[1], 'base64url');
      const authenticationTag = Buffer.from(parts[2], 'base64url');
      const ciphertext = Buffer.from(parts[3], 'base64url');
      if (
        iv.length !== SESSION_PAYLOAD_IV_BYTES
        || authenticationTag.length !== SESSION_PAYLOAD_TAG_BYTES
        || ciphertext.length < 1
      ) {
        throw new Error('The protected session payload has invalid cryptographic parameters.');
      }

      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv, {
        authTagLength: SESSION_PAYLOAD_TAG_BYTES
      });
      decipher.setAAD(sessionPayloadAdditionalData(storageId));
      decipher.setAuthTag(authenticationTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return { session: JSON.parse(plaintext.toString('utf8')), legacyPlaintext: false };
    }
  };
}

export function sessionStorageKey(sid, secret) {
  return createSessionStorageKeyFactory(secret)(sid);
}

export function encryptSessionPayload(storedSession, storageId, secret) {
  return createSessionPayloadProtector(secret).encrypt(storedSession, storageId);
}

export function parseStoredSessionPayload(serializedSession, storageId, secret) {
  return createSessionPayloadProtector(secret).decrypt(serializedSession, storageId);
}

export function ensureSessionRevocationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS revoked_sessions (
      sid TEXT PRIMARY KEY,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expires
      ON revoked_sessions(expires);
  `);
}

export function createStoredSessionActivityChecker(db, sid, secret, options = {}) {
  ensureSessionRevocationSchema(db);
  const storageId = sessionStorageKey(sid, secret);
  const payloadProtector = createSessionPayloadProtector(secret);
  const expectedUserId = Number(options.userId);
  const requiresExpectedUser = Number.isSafeInteger(expectedUserId) && expectedUserId > 0;
  const absoluteTtlMs = Number(options.absoluteTtlMs) > 0
    ? Number(options.absoluteTtlMs)
    : 0;
  const statement = db.prepare(`
    SELECT sess
    FROM sessions
    WHERE sid = ?
      AND expires >= ?
      AND NOT EXISTS (
        SELECT 1
        FROM revoked_sessions
        WHERE sid = ? AND expires >= ?
      )
    LIMIT 1
  `);

  return (now = Date.now()) => {
    const checkedAt = Number(now);
    if (!Number.isFinite(checkedAt)) return false;

    const row = statement.get(storageId, checkedAt, storageId, checkedAt);
    if (!row) return false;

    let storedSession;
    try {
      storedSession = payloadProtector.decrypt(row.sess, storageId).session;
    } catch {
      return false;
    }

    if (requiresExpectedUser) {
      if (Number(storedSession?.userId) !== expectedUserId) return false;
      const createdAt = authenticatedSessionCreatedAt(storedSession);
      if (createdAt === null) return false;
      if (absoluteTtlMs > 0 && checkedAt - createdAt > absoluteTtlMs) return false;
    }

    return true;
  };
}

function revocationExpiry(storedSession, storedExpiry, defaultTtlMs = 0, now = Date.now()) {
  const durationCandidates = [
    defaultTtlMs,
    storedSession?.cookie?.originalMaxAge,
    storedSession?.cookie?.maxAge
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const duration = Math.max(MINIMUM_REVOCATION_TTL_MS, ...durationCandidates);
  const persistedExpiry = Number(storedExpiry);
  return Math.max(
    now + duration,
    Number.isFinite(persistedExpiry) ? persistedExpiry : 0
  );
}

function authenticatedSessionCreatedAt(storedSession) {
  const candidates = [
    storedSession?.sessionCreatedAt,
    storedSession?.authenticatedAt,
    storedSession?.pendingMfa?.createdAt,
    storedSession?.authenticationFlow?.createdAt
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.min(...candidates) : null;
}

export function revokeStoredSession(db, storageId, options = {}) {
  ensureSessionRevocationSchema(db);
  let normalizedStorageId;
  try {
    normalizedStorageId = normalizeStorageId(storageId);
  } catch {
    // Rows from versions predating HMAC-indexed session identifiers are not
    // reachable by the current store and therefore cannot be resurrected by
    // touch(). Delete them without copying the raw identifier into a tombstone.
    return db.prepare('DELETE FROM sessions WHERE sid = ?').run(String(storageId || '')).changes;
  }
  const expires = revocationExpiry(
    options.storedSession,
    options.expires,
    options.defaultTtlMs
  );

  // Write the tombstone before deleting the live row. A concurrent writer will
  // then either observe the tombstone and refuse the write, or finish first and
  // have its row removed by the delete below.
  db.prepare(`
    INSERT INTO revoked_sessions (sid, expires)
    VALUES (?, ?)
    ON CONFLICT(sid) DO UPDATE SET
      expires = MAX(revoked_sessions.expires, excluded.expires)
  `).run(normalizedStorageId, expires);
  return db.prepare('DELETE FROM sessions WHERE sid = ?').run(normalizedStorageId).changes;
}


export function migrateLegacySessionPayloads(db, sessionSecret) {
  const payloadProtector = createSessionPayloadProtector(sessionSecret);
  const rows = db.prepare(`
    SELECT sid, sess, expires
    FROM sessions
    WHERE substr(sess, 1, 3) <> ?
  `).all(`${SESSION_PAYLOAD_VERSION}.`);
  if (rows.length === 0) return { migrated: 0, discarded: 0 };

  db.exec('PRAGMA secure_delete = ON;');
  const updateSession = db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE sid = ?');
  let migrated = 0;
  let discarded = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      try {
        const storedSession = JSON.parse(row.sess);
        updateSession.run(payloadProtector.encrypt(storedSession, row.sid), row.sid);
        migrated += 1;
      } catch {
        discarded += deleteSession.run(row.sid).changes;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // The encrypted rows are already committed; checkpointing can be retried by SQLite later.
  }
  return { migrated, discarded };
}

export class SQLiteSessionStore extends session.Store {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.defaultTtlMs = options.defaultTtlMs || 1000 * 60 * 60 * 12;
    this.absoluteTtlMs = Number(options.absoluteTtlMs) > 0
      ? Number(options.absoluteTtlMs)
      : 0;
    this.revocationTtlMs = Math.max(
      this.defaultTtlMs,
      Number(options.revocationTtlMs) > 0 ? Number(options.revocationTtlMs) : 0,
      this.absoluteTtlMs
    );
    this.storageKey = createSessionStorageKeyFactory(options.secret);
    this.payloadProtector = createSessionPayloadProtector(options.secret);
    ensureSessionRevocationSchema(db);

    this.getStatement = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStatement = db.prepare(`
      INSERT INTO sessions (sid, sess, expires)
      SELECT ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1
        FROM revoked_sessions
        WHERE sid = ? AND expires >= ?
      )
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this.touchStatement = db.prepare(`
      UPDATE sessions
      SET expires = ?
      WHERE sid = ?
        AND NOT EXISTS (
          SELECT 1
          FROM revoked_sessions
          WHERE sid = ? AND expires >= ?
        )
    `);
    this.destroyStatement = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.getRevocationStatement = db.prepare('SELECT expires FROM revoked_sessions WHERE sid = ?');
    this.deleteRevocationStatement = db.prepare('DELETE FROM revoked_sessions WHERE sid = ?');
    this.cleanupStatement = db.prepare('DELETE FROM sessions WHERE expires < ?');
    this.cleanupRevocationsStatement = db.prepare('DELETE FROM revoked_sessions WHERE expires < ?');

    this.cleanupTimer = setInterval(() => {
      try {
        const now = Date.now();
        this.cleanupStatement.run(now);
        this.cleanupRevocationsStatement.run(now);
      } catch (error) {
        this.emit('disconnect', error);
      }
    }, options.cleanupIntervalMs || 1000 * 60 * 15);
    this.cleanupTimer.unref();
  }

  calculateExpiry(sess) {
    const cookieExpiry = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
    if (Number.isFinite(cookieExpiry)) return cookieExpiry;
    const maxAge = Number(sess?.cookie?.maxAge);
    return Date.now() + (Number.isFinite(maxAge) ? maxAge : this.defaultTtlMs);
  }

  isPastAbsoluteExpiry(sess, now = Date.now()) {
    if (!(this.absoluteTtlMs > 0)) return false;
    const createdAt = authenticatedSessionCreatedAt(sess);
    return createdAt !== null && now - createdAt > this.absoluteTtlMs;
  }

  get(sid, callback) {
    try {
      const storageId = this.storageKey(sid);
      const now = Date.now();
      const revocation = this.getRevocationStatement.get(storageId);
      if (revocation) {
        if (Number(revocation.expires) >= now) {
          this.destroyStatement.run(storageId);
          return callback(null, null);
        }
        this.deleteRevocationStatement.run(storageId);
      }

      const row = this.getStatement.get(storageId);
      if (!row || row.expires < now) {
        if (row) this.destroyStatement.run(storageId);
        return callback(null, null);
      }

      let parsed;
      try {
        parsed = this.payloadProtector.decrypt(row.sess, storageId);
      } catch {
        this.destroyStatement.run(storageId);
        return callback(null, null);
      }

      if (parsed.legacyPlaintext) {
        const migrationResult = this.setStatement.run(
          storageId,
          this.payloadProtector.encrypt(parsed.session, storageId),
          row.expires,
          storageId,
          Date.now()
        );
        if (migrationResult.changes === 0) {
          this.destroyStatement.run(storageId);
          return callback(null, null);
        }
      }
      return callback(null, parsed.session);
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const storageId = this.storageKey(sid);
      const now = Date.now();
      if (this.isPastAbsoluteExpiry(sess, now)) {
        revokeStoredSession(this.db, storageId, {
          storedSession: sess,
          defaultTtlMs: this.revocationTtlMs
        });
        callback(null);
        return;
      }
      const result = this.setStatement.run(
        storageId,
        this.payloadProtector.encrypt(sess, storageId),
        this.calculateExpiry(sess),
        storageId,
        now
      );
      if (result.changes === 0) this.destroyStatement.run(storageId);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      const storageId = this.storageKey(sid);
      const row = this.getStatement.get(storageId);
      let storedSession = null;
      if (row) {
        try {
          storedSession = this.payloadProtector.decrypt(row.sess, storageId).session;
        } catch {
          // A corrupt payload must still be revoked and removed.
        }
      }
      revokeStoredSession(this.db, storageId, {
        expires: row?.expires,
        storedSession,
        defaultTtlMs: this.revocationTtlMs
      });
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const storageId = this.storageKey(sid);
      const now = Date.now();
      if (this.isPastAbsoluteExpiry(sess, now)) {
        revokeStoredSession(this.db, storageId, {
          storedSession: sess,
          defaultTtlMs: this.revocationTtlMs
        });
        callback(null);
        return;
      }
      const result = this.touchStatement.run(
        this.calculateExpiry(sess),
        storageId,
        storageId,
        now
      );
      if (result.changes === 0) this.destroyStatement.run(storageId);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

function referencedUserId(storedSession) {
  const candidates = [
    storedSession?.userId,
    storedSession?.pendingMfa?.userId,
    storedSession?.webAuthnAuthentication?.userId,
    storedSession?.authenticationFlow?.userId
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function sessionActivityTime(storedSession, expires) {
  const candidates = [
    storedSession?.authenticatedAt,
    storedSession?.pendingMfa?.createdAt,
    storedSession?.webAuthnAuthentication?.createdAt,
    storedSession?.authenticationFlow?.createdAt,
    expires
  ].map(Number).filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

function parseSessionRow(row, payloadProtector) {
  try {
    return payloadProtector.decrypt(row.sess, row.sid).session;
  } catch {
    return null;
  }
}

export function pruneUserSessions(
  db,
  userId,
  currentSessionId,
  maximumSessions = 10,
  sessionSecret = '',
  revocationTtlMs = 0
) {
  const normalizedUserId = Number(userId);
  const limit = Math.max(1, Math.min(Number(maximumSessions) || 10, 100));
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId < 1) {
    throw new Error('A valid user identifier is required to limit sessions.');
  }
  const currentStorageId = sessionStorageKey(currentSessionId, sessionSecret);
  const payloadProtector = createSessionPayloadProtector(sessionSecret);

  const now = Date.now();
  const sessions = [];
  const deleteSession = db.prepare('DELETE FROM sessions WHERE sid = ?');
  for (const row of db.prepare('SELECT sid, sess, expires FROM sessions').all()) {
    if (Number(row.expires) <= now) {
      deleteSession.run(row.sid);
      continue;
    }

    const storedSession = parseSessionRow(row, payloadProtector);
    if (!storedSession || referencedUserId(storedSession) !== normalizedUserId) continue;
    sessions.push({
      sid: row.sid,
      current: row.sid === currentStorageId,
      activityTime: sessionActivityTime(storedSession, row.expires),
      expires: row.expires,
      storedSession
    });
  }

  sessions.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.activityTime !== right.activityTime) return right.activityTime - left.activityTime;
    return left.sid.localeCompare(right.sid);
  });

  for (const sessionRecord of sessions.slice(limit)) {
    revokeStoredSession(db, sessionRecord.sid, {
      expires: sessionRecord.expires,
      storedSession: sessionRecord.storedSession,
      defaultTtlMs: revocationTtlMs
    });
  }
  return Math.max(0, sessions.length - limit);
}

export function purgeUserSessions(
  db,
  userId,
  exceptSessionId = '',
  sessionSecret = '',
  revocationTtlMs = 0
) {
  const normalizedUserId = Number(userId);
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId < 1) {
    throw new Error('A valid user identifier is required to purge sessions.');
  }

  const excludedSessionId = exceptSessionId
    ? sessionStorageKey(exceptSessionId, sessionSecret)
    : '';
  const payloadProtector = createSessionPayloadProtector(sessionSecret);
  const now = Date.now();
  const deleteSession = db.prepare('DELETE FROM sessions WHERE sid = ?');
  let deleted = 0;

  for (const row of db.prepare('SELECT sid, sess, expires FROM sessions').all()) {
    if (Number(row.expires) <= now) {
      deleted += deleteSession.run(row.sid).changes;
      continue;
    }
    if (row.sid === excludedSessionId) continue;

    const storedSession = parseSessionRow(row, payloadProtector);
    if (!storedSession || referencedUserId(storedSession) !== normalizedUserId) continue;
    deleted += revokeStoredSession(db, row.sid, {
      expires: row.expires,
      storedSession,
      defaultTtlMs: revocationTtlMs
    });
  }
  return deleted;
}
