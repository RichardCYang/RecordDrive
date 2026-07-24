import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_ANONYMOUS_CSRF_COOKIE_NAME,
  HOST_SESSION_COOKIE_NAME,
  LEGACY_ANONYMOUS_CSRF_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  anonymousCsrfCookieName,
  clearSessionCookies,
  sessionCookieName,
  sessionCookieOptions
} from '../src/cookie-security.js';
import { csrfTokenMiddleware } from '../src/middleware/csrf.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('external HTTPS deployments use origin-bound __Host- security cookies', () => {
  const config = { requireHttps: true };
  const options = sessionCookieOptions(config, 60_000);

  assert.equal(sessionCookieName(config), HOST_SESSION_COOKIE_NAME);
  assert.equal(anonymousCsrfCookieName(config), HOST_ANONYMOUS_CSRF_COOKIE_NAME);
  assert.equal(options.secure, true);
  assert.equal(options.path, '/');
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'strict');
  assert.equal(options.priority, 'high');
  assert.equal(options.maxAge, 60_000);
  assert.equal(Object.hasOwn(options, 'domain'), false);
});

test('loopback HTTP development retains compatible unprefixed cookie names', () => {
  const config = { requireHttps: false };
  const options = sessionCookieOptions(config);

  assert.equal(sessionCookieName(config), LEGACY_SESSION_COOKIE_NAME);
  assert.equal(anonymousCsrfCookieName(config), LEGACY_ANONYMOUS_CSRF_COOKIE_NAME);
  assert.equal(options.secure, 'auto');
  assert.equal(options.path, '/');
  assert.equal(Object.hasOwn(options, 'domain'), false);
});

test('session-cookie clearing uses the exact active path and expires the legacy host cookie', () => {
  const calls = [];
  const response = {
    clearCookie(name, options) {
      calls.push({ name, options });
    }
  };

  clearSessionCookies(response, { requireHttps: true });
  assert.deepEqual(calls.map(({ name }) => name), [HOST_SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME]);
  for (const { options } of calls) {
    assert.equal(options.secure, true);
    assert.equal(options.path, '/');
    assert.equal(Object.hasOwn(options, 'domain'), false);
  }
});

test('application code centralizes session and anonymous CSRF cookie names', () => {
  const files = [
    'src/app.js',
    'src/middleware/auth.js',
    'src/middleware/csrf.js',
    'src/routes/auth.js'
  ];
  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /['"]recorddrive\.sid['"]/);
    assert.doesNotMatch(source, /['"]recorddrive\.csrf['"]/);
  }

  const csrfSource = fs.readFileSync(path.join(projectRoot, 'src/middleware/csrf.js'), 'utf8');
  assert.match(csrfSource, /anonymousCsrfCookieName\(req\.app\.recorddrive\.config\)/);
  assert.match(csrfSource, /path: '\/'/);
});


test('anonymous login CSRF cookie is __Host- scoped in external mode', () => {
  const setCookies = [];
  const req = {
    app: { recorddrive: { config: {
      requireHttps: true,
      sessionSecret: 'cookie-prefix-test-secret-with-more-than-thirty-two-characters'
    } } },
    currentUser: null,
    session: {},
    headers: {},
    method: 'GET',
    path: '/login',
    secure: true
  };
  const res = {
    locals: {},
    cookie(name, value, options) {
      setCookies.push({ name, value, options });
    }
  };
  let nextCalled = false;

  csrfTokenMiddleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(setCookies.length, 1);
  assert.equal(setCookies[0].name, HOST_ANONYMOUS_CSRF_COOKIE_NAME);
  assert.equal(setCookies[0].options.secure, true);
  assert.equal(setCookies[0].options.path, '/');
  assert.equal(Object.hasOwn(setCookies[0].options, 'domain'), false);
  assert.equal(res.locals.csrfToken, setCookies[0].value);
});
