const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function loginRateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = attempts.get(key);

  if (!record || now - record.startedAt > WINDOW_MS) {
    attempts.set(key, { count: 1, startedAt: now });
    return next();
  }

  record.count += 1;
  if (record.count > MAX_ATTEMPTS) {
    const retrySeconds = Math.max(1, Math.ceil((WINDOW_MS - (now - record.startedAt)) / 1000));
    res.set('Retry-After', String(retrySeconds));
    return res.status(429).render('login', {
      title: 'Sign in',
      error: `Too many sign-in attempts. Try again in about ${Math.ceil(retrySeconds / 60)} minute(s).`,
      username: req.body?.username || ''
    });
  }

  return next();
}

export function clearLoginAttempts(req) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  attempts.delete(key);
}
