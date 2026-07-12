const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MFA_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_FAILURES_PER_IP = 20;
const MAX_LOGIN_FAILURES_PER_ACCOUNT = 10;
const MAX_MFA_FAILURES_PER_IP = 30;
const MAX_MFA_FAILURES_PER_USER = 10;
const MAX_TRACKED_KEYS = 20000;

const loginIpFailures = new Map();
const loginAccountFailures = new Map();
const mfaIpFailures = new Map();
const mfaUserFailures = new Map();

function clientAddress(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').trim() || 'unknown';
}

function accountKey(username) {
  return String(username || '').trim().toLowerCase().slice(0, 128) || '<empty>';
}

function userKey(userId) {
  const parsed = Number(userId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : '<unknown>';
}

function deleteExpired(map, now, windowMs) {
  for (const [key, record] of map) {
    if (now - record.startedAt >= windowMs) map.delete(key);
  }
}

function enforceMapLimit(map) {
  while (map.size > MAX_TRACKED_KEYS) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function recordFailure(map, key, now, windowMs) {
  const current = map.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    map.delete(key);
    map.set(key, { count: 1, startedAt: now });
  } else {
    current.count += 1;
  }
  enforceMapLimit(map);
}

function limitState(map, key, now, windowMs, maximum) {
  const record = map.get(key);
  if (!record) return { blocked: false, retrySeconds: 0 };
  const elapsed = now - record.startedAt;
  if (elapsed >= windowMs) {
    map.delete(key);
    return { blocked: false, retrySeconds: 0 };
  }
  if (record.count < maximum) return { blocked: false, retrySeconds: 0 };
  return {
    blocked: true,
    retrySeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000))
  };
}

function strongestLimit(...states) {
  return states.reduce((selected, state) => (
    state.blocked && state.retrySeconds > selected.retrySeconds ? state : selected
  ), { blocked: false, retrySeconds: 0 });
}

function renderLoginLimit(req, res, retrySeconds) {
  res.set('Retry-After', String(retrySeconds));
  return res.status(429).render('login', {
    title: req.t('Sign in'),
    error: req.t('Too many sign-in attempts. Try again in about {{minutes}} minute(s).', {
      minutes: Math.ceil(retrySeconds / 60)
    }),
    username: req.body?.username || ''
  });
}

export function loginRateLimit(req, res, next) {
  const now = Date.now();
  deleteExpired(loginIpFailures, now, LOGIN_WINDOW_MS);
  deleteExpired(loginAccountFailures, now, LOGIN_WINDOW_MS);

  const limit = strongestLimit(
    limitState(loginIpFailures, clientAddress(req), now, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES_PER_IP),
    limitState(loginAccountFailures, accountKey(req.body?.username), now, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES_PER_ACCOUNT)
  );
  if (limit.blocked) return renderLoginLimit(req, res, limit.retrySeconds);
  return next();
}

export function recordLoginFailure(req, username) {
  const now = Date.now();
  recordFailure(loginIpFailures, clientAddress(req), now, LOGIN_WINDOW_MS);
  recordFailure(loginAccountFailures, accountKey(username), now, LOGIN_WINDOW_MS);
}

export function clearLoginAttempts(username) {
  loginAccountFailures.delete(accountKey(username));
}

export function checkMfaRateLimit(req, userId) {
  const now = Date.now();
  deleteExpired(mfaIpFailures, now, MFA_WINDOW_MS);
  deleteExpired(mfaUserFailures, now, MFA_WINDOW_MS);
  return strongestLimit(
    limitState(mfaIpFailures, clientAddress(req), now, MFA_WINDOW_MS, MAX_MFA_FAILURES_PER_IP),
    limitState(mfaUserFailures, userKey(userId), now, MFA_WINDOW_MS, MAX_MFA_FAILURES_PER_USER)
  );
}

export function recordMfaFailure(req, userId) {
  const now = Date.now();
  recordFailure(mfaIpFailures, clientAddress(req), now, MFA_WINDOW_MS);
  recordFailure(mfaUserFailures, userKey(userId), now, MFA_WINDOW_MS);
}

export function clearMfaAttempts(userId) {
  mfaUserFailures.delete(userKey(userId));
}

export function resetAuthenticationRateLimits() {
  loginIpFailures.clear();
  loginAccountFailures.clear();
  mfaIpFailures.clear();
  mfaUserFailures.clear();
}
