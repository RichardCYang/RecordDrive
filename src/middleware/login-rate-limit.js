import { safeInternalPath } from '../utils.js';

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MFA_WINDOW_MS = 10 * 60 * 1000;
const SECURITY_PASSWORD_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_FAILURES_PER_IP = 20;
const MAX_LOGIN_FAILURES_PER_ACCOUNT = 10;
const MAX_MFA_FAILURES_PER_IP = 30;
const MAX_MFA_FAILURES_PER_USER = 10;
const MAX_SECURITY_PASSWORD_FAILURES_PER_IP = 20;
const MAX_SECURITY_PASSWORD_FAILURES_PER_USER = 5;
const MAX_TRACKED_KEYS = 20000;

const loginIpFailures = new Map();
const loginAccountFailures = new Map();
const mfaIpFailures = new Map();
const mfaUserFailures = new Map();
const securityPasswordIpFailures = new Map();
const securityPasswordUserFailures = new Map();

const LOGIN_RESERVATION = Symbol('recorddrive.loginRateLimitReservation');
const MFA_RESERVATION = Symbol('recorddrive.mfaRateLimitReservation');
const SECURITY_PASSWORD_RESERVATION = Symbol('recorddrive.securityPasswordRateLimitReservation');

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

function normalizeRecord(record) {
  if (!Number.isSafeInteger(record.count) || record.count < 0) record.count = 0;
  if (!Number.isSafeInteger(record.inFlight) || record.inFlight < 0) record.inFlight = 0;
  return record;
}

function activeRecord(map, key, now, windowMs) {
  const record = map.get(key);
  if (!record) return null;
  normalizeRecord(record);
  if (now - record.startedAt < windowMs) return record;

  if (record.inFlight > 0) {
    record.count = 0;
    record.startedAt = now;
    return record;
  }

  map.delete(key);
  return null;
}

function deleteExpired(map, now, windowMs) {
  for (const key of map.keys()) activeRecord(map, key, now, windowMs);
}

function enforceMapLimit(map) {
  if (map.size <= MAX_TRACKED_KEYS) return;

  for (const [key, record] of map) {
    if (map.size <= MAX_TRACKED_KEYS) break;
    normalizeRecord(record);
    if (record.inFlight === 0) map.delete(key);
  }
}

function recordFailure(map, key, now, windowMs) {
  let record = activeRecord(map, key, now, windowMs);
  if (!record) {
    record = { count: 0, inFlight: 0, startedAt: now };
    map.set(key, record);
  }
  record.count += 1;
  enforceMapLimit(map);
}

function limitState(map, key, now, windowMs, maximum) {
  const record = activeRecord(map, key, now, windowMs);
  if (!record) return { blocked: false, retrySeconds: 0 };
  const attemptCount = record.count + record.inFlight;
  if (attemptCount < maximum) return { blocked: false, retrySeconds: 0 };
  return {
    blocked: true,
    retrySeconds: Math.max(1, Math.ceil((windowMs - (now - record.startedAt)) / 1000))
  };
}

function strongestLimit(...states) {
  return states.reduce((selected, state) => (
    state.blocked && state.retrySeconds > selected.retrySeconds ? state : selected
  ), { blocked: false, retrySeconds: 0 });
}

function reserveAttempts(specifications, now) {
  const limit = strongestLimit(...specifications.map((specification) => limitState(
    specification.map,
    specification.key,
    now,
    specification.windowMs,
    specification.maximum
  )));
  if (limit.blocked) return { limit, reservation: null };

  const entries = specifications.map((specification) => {
    let record = activeRecord(specification.map, specification.key, now, specification.windowMs);
    if (!record) {
      record = { count: 0, inFlight: 0, startedAt: now };
      specification.map.set(specification.key, record);
    }
    record.inFlight += 1;
    enforceMapLimit(specification.map);
    return { ...specification, record };
  });

  return {
    limit: { blocked: false, retrySeconds: 0 },
    reservation: { active: true, entries }
  };
}

function completeReservation(reservation, failed) {
  if (!reservation?.active) return false;
  reservation.active = false;
  const now = Date.now();

  for (const entry of reservation.entries) {
    const current = entry.map.get(entry.key);
    if (current !== entry.record) {
      if (failed) recordFailure(entry.map, entry.key, now, entry.windowMs);
      continue;
    }

    normalizeRecord(current);
    if (now - current.startedAt >= entry.windowMs) {
      current.count = 0;
      current.startedAt = now;
    }
    current.inFlight = Math.max(0, current.inFlight - 1);
    if (failed) current.count += 1;
    if (current.count === 0 && current.inFlight === 0) entry.map.delete(entry.key);
  }

  return true;
}

function takeReservation(req, symbol) {
  const reservation = req?.[symbol];
  if (req) delete req[symbol];
  return reservation;
}

function clearFailures(map, key) {
  const record = map.get(key);
  if (!record) return;
  normalizeRecord(record);
  record.count = 0;
  if (record.inFlight === 0) map.delete(key);
}

function renderLoginLimit(req, res, retrySeconds) {
  res.set('Retry-After', String(retrySeconds));
  return res.status(429).render('login', {
    title: req.t('Sign in'),
    error: req.t('Too many sign-in attempts. Try again in about {{minutes}} minute(s).', {
      minutes: Math.ceil(retrySeconds / 60)
    }),
    username: req.body?.username || '',
    returnTo: safeInternalPath(req.body?.returnTo, '/')
  });
}

export function loginRateLimit(req, res, next) {
  const now = Date.now();
  deleteExpired(loginIpFailures, now, LOGIN_WINDOW_MS);
  deleteExpired(loginAccountFailures, now, LOGIN_WINDOW_MS);

  const { limit, reservation } = reserveAttempts([
    {
      map: loginIpFailures,
      key: clientAddress(req),
      windowMs: LOGIN_WINDOW_MS,
      maximum: MAX_LOGIN_FAILURES_PER_IP
    },
    {
      map: loginAccountFailures,
      key: accountKey(req.body?.username),
      windowMs: LOGIN_WINDOW_MS,
      maximum: MAX_LOGIN_FAILURES_PER_ACCOUNT
    }
  ], now);
  if (limit.blocked) return renderLoginLimit(req, res, limit.retrySeconds);

  req[LOGIN_RESERVATION] = reservation;
  return next();
}

export function recordLoginFailure(req, username) {
  if (completeReservation(takeReservation(req, LOGIN_RESERVATION), true)) return;

  const now = Date.now();
  recordFailure(loginIpFailures, clientAddress(req), now, LOGIN_WINDOW_MS);
  recordFailure(loginAccountFailures, accountKey(username), now, LOGIN_WINDOW_MS);
}

export function clearLoginAttempts(username, req) {
  completeReservation(takeReservation(req, LOGIN_RESERVATION), false);
  clearFailures(loginAccountFailures, accountKey(username));
}

export function releaseLoginAttempt(req) {
  completeReservation(takeReservation(req, LOGIN_RESERVATION), false);
}

export function checkMfaRateLimit(req, userId, options = {}) {
  const now = Date.now();
  deleteExpired(mfaIpFailures, now, MFA_WINDOW_MS);
  deleteExpired(mfaUserFailures, now, MFA_WINDOW_MS);

  const specifications = [
    {
      map: mfaIpFailures,
      key: clientAddress(req),
      windowMs: MFA_WINDOW_MS,
      maximum: MAX_MFA_FAILURES_PER_IP
    },
    {
      map: mfaUserFailures,
      key: userKey(userId),
      windowMs: MFA_WINDOW_MS,
      maximum: MAX_MFA_FAILURES_PER_USER
    }
  ];

  if (options.reserve !== true) {
    return strongestLimit(...specifications.map((specification) => limitState(
      specification.map,
      specification.key,
      now,
      specification.windowMs,
      specification.maximum
    )));
  }

  const { limit, reservation } = reserveAttempts(specifications, now);
  if (!limit.blocked) req[MFA_RESERVATION] = reservation;
  return limit;
}

export function recordMfaFailure(req, userId) {
  if (completeReservation(takeReservation(req, MFA_RESERVATION), true)) return;

  const now = Date.now();
  recordFailure(mfaIpFailures, clientAddress(req), now, MFA_WINDOW_MS);
  recordFailure(mfaUserFailures, userKey(userId), now, MFA_WINDOW_MS);
}

export function clearMfaAttempts(userId, req) {
  completeReservation(takeReservation(req, MFA_RESERVATION), false);
  clearFailures(mfaUserFailures, userKey(userId));
}

export function releaseMfaAttempt(req) {
  completeReservation(takeReservation(req, MFA_RESERVATION), false);
}

function renderSecurityPasswordLimit(req, res, retrySeconds) {
  res.set('Retry-After', String(retrySeconds));
  req.session.flash = {
    type: 'error',
    message: req.t('Too many password confirmation attempts. Try again later.')
  };
  return res.redirect('/settings#security-verification');
}

export function securityPasswordRateLimit(req, res, next) {
  const now = Date.now();
  deleteExpired(securityPasswordIpFailures, now, SECURITY_PASSWORD_WINDOW_MS);
  deleteExpired(securityPasswordUserFailures, now, SECURITY_PASSWORD_WINDOW_MS);

  const { limit, reservation } = reserveAttempts([
    {
      map: securityPasswordIpFailures,
      key: clientAddress(req),
      windowMs: SECURITY_PASSWORD_WINDOW_MS,
      maximum: MAX_SECURITY_PASSWORD_FAILURES_PER_IP
    },
    {
      map: securityPasswordUserFailures,
      key: userKey(req.currentUser?.id),
      windowMs: SECURITY_PASSWORD_WINDOW_MS,
      maximum: MAX_SECURITY_PASSWORD_FAILURES_PER_USER
    }
  ], now);
  if (limit.blocked) return renderSecurityPasswordLimit(req, res, limit.retrySeconds);

  req[SECURITY_PASSWORD_RESERVATION] = reservation;
  return next();
}

export function recordSecurityPasswordFailure(req, userId) {
  if (completeReservation(takeReservation(req, SECURITY_PASSWORD_RESERVATION), true)) return;

  const now = Date.now();
  recordFailure(securityPasswordIpFailures, clientAddress(req), now, SECURITY_PASSWORD_WINDOW_MS);
  recordFailure(securityPasswordUserFailures, userKey(userId), now, SECURITY_PASSWORD_WINDOW_MS);
}

export function clearSecurityPasswordAttempts(userId, req) {
  completeReservation(takeReservation(req, SECURITY_PASSWORD_RESERVATION), false);
  clearFailures(securityPasswordUserFailures, userKey(userId));
}

export function releaseSecurityPasswordAttempt(req) {
  completeReservation(takeReservation(req, SECURITY_PASSWORD_RESERVATION), false);
}

export function resetAuthenticationRateLimits() {
  loginIpFailures.clear();
  loginAccountFailures.clear();
  mfaIpFailures.clear();
  mfaUserFailures.clear();
  securityPasswordIpFailures.clear();
  securityPasswordUserFailures.clear();
}
