import crypto from 'node:crypto';
import { requestWantsJson } from '../utils.js';
import { anonymousCsrfCookieName } from '../cookie-security.js';

const MULTIPART_UPLOAD_PATH = /^\/repositories\/[1-9]\d*\/upload\/?$/;
const ANONYMOUS_CSRF_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CSRF_VALUE_LENGTH = 512;

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(headerValue) {
  const cookies = {};
  for (const pair of String(headerValue || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    if (!name || rawValue.length > MAX_CSRF_VALUE_LENGTH) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

function anonymousCsrfKey(req) {
  const secret = String(req.app?.recorddrive?.config?.sessionSecret || '');
  if (!secret) throw new Error('A session secret is required for anonymous CSRF protection.');
  return crypto.createHash('sha256').update(`recorddrive:anonymous-csrf:v1:${secret}`, 'utf8').digest();
}

function signAnonymousPayload(req, payload) {
  return crypto.createHmac('sha256', anonymousCsrfKey(req)).update(payload, 'utf8').digest('base64url');
}

function createAnonymousToken(req) {
  const payload = `${Date.now()}.${crypto.randomBytes(32).toString('base64url')}`;
  return `${payload}.${signAnonymousPayload(req, payload)}`;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validAnonymousToken(req, token) {
  const value = String(token || '');
  if (!value || value.length > MAX_CSRF_VALUE_LENGTH) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;

  const [issuedAtValue, randomValue, signature] = parts;
  if (!/^\d{13}$/.test(issuedAtValue) || !/^[A-Za-z0-9_-]{43}$/.test(randomValue)) return false;
  const issuedAt = Number(issuedAtValue);
  const age = Date.now() - issuedAt;
  if (!Number.isSafeInteger(issuedAt) || age < -60_000 || age > ANONYMOUS_CSRF_MAX_AGE_MS) return false;

  const payload = `${issuedAtValue}.${randomValue}`;
  return safeEqual(signature, signAnonymousPayload(req, payload));
}

function hasServerSessionState(req) {
  return Boolean(
    req.currentUser
    || req.session?.userId
    || req.session?.pendingMfa
    || req.session?.authenticationFlow?.userId
  );
}

function anonymousCookieToken(req) {
  return parseCookies(req.headers.cookie)[anonymousCsrfCookieName(req.app.recorddrive.config)] || '';
}

function setAnonymousCsrfCookie(req, res, token) {
  res.cookie(anonymousCsrfCookieName(req.app.recorddrive.config), token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.app.recorddrive.config.requireHttps ? true : req.secure,
    priority: 'high',
    maxAge: ANONYMOUS_CSRF_MAX_AGE_MS,
    path: '/'
  });
}

function renderCsrfFailure(req, res) {
  const message = req.t('The security token is invalid or has expired. Refresh the page and try again.');
  if (requestWantsJson(req)) {
    return res.status(403).json({ error: message });
  }
  return res.status(403).render('error', {
    title: req.t('Request could not be verified'),
    statusCode: 403,
    message
  });
}

export function csrfTokenMiddleware(req, res, next) {
  if (hasServerSessionState(req)) {
    if (!req.session.csrfToken) req.session.csrfToken = newSessionToken();
    res.locals.csrfToken = req.session.csrfToken;
    return next();
  }

  let token = anonymousCookieToken(req);
  if (!validAnonymousToken(req, token)) token = '';
  if (req.method === 'GET' && req.path === '/login' && !token) {
    token = createAnonymousToken(req);
    setAnonymousCsrfCookie(req, res, token);
  }
  res.locals.csrfToken = token;
  return next();
}

export function isValidCsrf(req) {
  const sent = String(req.body?._csrf || req.get('x-csrf-token') || '');
  if (!sent || sent.length > MAX_CSRF_VALUE_LENGTH) return false;

  if (hasServerSessionState(req)) {
    return safeEqual(sent, req.session?.csrfToken || '');
  }

  const cookieToken = anonymousCookieToken(req);
  return safeEqual(sent, cookieToken) && validAnonymousToken(req, cookieToken);
}

export function verifyCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  if (req.is('multipart/form-data')) {
    // The upload route validates the token after Multer parses its multipart fields.
    if (req.method === 'POST' && MULTIPART_UPLOAD_PATH.test(req.path)) return next();
    return renderCsrfFailure(req, res);
  }

  if (!isValidCsrf(req)) return renderCsrfFailure(req, res);
  return next();
}
