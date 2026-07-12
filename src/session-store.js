import session from 'express-session';

export class SQLiteSessionStore extends session.Store {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.defaultTtlMs = options.defaultTtlMs || 1000 * 60 * 60 * 12;

    this.getStatement = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStatement = db.prepare(`
      INSERT INTO sessions (sid, sess, expires)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this.destroyStatement = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.cleanupStatement = db.prepare('DELETE FROM sessions WHERE expires < ?');

    this.cleanupTimer = setInterval(() => {
      try {
        this.cleanupStatement.run(Date.now());
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

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row || row.expires < Date.now()) {
        if (row) this.destroyStatement.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      this.setStatement.run(sid, JSON.stringify(sess), this.calculateExpiry(sess));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    this.set(sid, sess, callback);
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

export function pruneUserSessions(db, userId, currentSessionId, maximumSessions = 10) {
  const normalizedUserId = Number(userId);
  const limit = Math.max(1, Math.min(Number(maximumSessions) || 10, 100));
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId < 1) {
    throw new Error('A valid user identifier is required to limit sessions.');
  }

  const now = Date.now();
  const sessions = [];
  const deleteSession = db.prepare('DELETE FROM sessions WHERE sid = ?');
  for (const row of db.prepare('SELECT sid, sess, expires FROM sessions').all()) {
    if (Number(row.expires) <= now) {
      deleteSession.run(row.sid);
      continue;
    }

    let storedSession;
    try {
      storedSession = JSON.parse(row.sess);
    } catch {
      continue;
    }
    if (referencedUserId(storedSession) !== normalizedUserId) continue;
    sessions.push({
      sid: row.sid,
      current: row.sid === currentSessionId,
      activityTime: sessionActivityTime(storedSession, row.expires)
    });
  }

  sessions.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.activityTime !== right.activityTime) return right.activityTime - left.activityTime;
    return left.sid.localeCompare(right.sid);
  });

  for (const sessionRecord of sessions.slice(limit)) deleteSession.run(sessionRecord.sid);
  return Math.max(0, sessions.length - limit);
}
