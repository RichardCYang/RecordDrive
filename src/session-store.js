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
