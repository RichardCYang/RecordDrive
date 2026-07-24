import assert from 'node:assert/strict';
import {
  HOST_SESSION_COOKIE_NAME,
  sessionCookieName,
  sessionCookieOptions
} from '../src/cookie-security.js';

function cookieMatches(cookie, host, requestPath, secureRequest = true) {
  if (cookie.secure && !secureRequest) return false;
  const cookieDomain = String(cookie.domain || host).replace(/^\./, '').toLowerCase();
  const requestHost = host.toLowerCase();
  if (cookie.hostOnly) {
    if (requestHost !== cookieDomain) return false;
  } else if (requestHost !== cookieDomain && !requestHost.endsWith(`.${cookieDomain}`)) {
    return false;
  }
  return requestPath === cookie.path
    || requestPath.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`);
}

function cookieHeader(cookies, host, requestPath) {
  return cookies
    .filter((cookie) => cookieMatches(cookie, host, requestPath))
    .sort((left, right) => right.path.length - left.path.length || left.createdAt - right.createdAt)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function parseLikeCookiePackage(header) {
  const parsed = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!Object.hasOwn(parsed, name)) parsed[name] = part.slice(separator + 1).trim();
  }
  return parsed;
}

function prefixAccepts(cookie) {
  if (!cookie.name.startsWith('__Host-')) return true;
  return cookie.secure === true && cookie.path === '/' && cookie.hostOnly === true;
}

const requestHost = 'app.example.test';
const requestPath = '/repositories/42/upload';
const vulnerableCookies = [
  {
    name: 'recorddrive.sid', value: 'attacker-session', domain: 'example.test',
    path: '/repositories', secure: true, hostOnly: false, createdAt: 1
  },
  {
    name: 'recorddrive.sid', value: 'victim-session', domain: requestHost,
    path: '/', secure: true, hostOnly: true, createdAt: 2
  }
];
const vulnerableHeader = cookieHeader(vulnerableCookies, requestHost, requestPath);
const vulnerableSelectedSession = parseLikeCookiePackage(vulnerableHeader)['recorddrive.sid'];

const attemptedSiblingCookie = {
  name: HOST_SESSION_COOKIE_NAME, value: 'attacker-session', domain: 'example.test',
  path: '/repositories', secure: true, hostOnly: false, createdAt: 1
};
const validHostCookie = {
  name: HOST_SESSION_COOKIE_NAME, value: 'victim-session', domain: requestHost,
  path: '/', secure: true, hostOnly: true, createdAt: 2
};
const patchedCookies = [attemptedSiblingCookie, validHostCookie].filter(prefixAccepts);
const patchedHeader = cookieHeader(patchedCookies, requestHost, requestPath);
const patchedSelectedSession = parseLikeCookiePackage(patchedHeader)[HOST_SESSION_COOKIE_NAME];

const externalConfig = { requireHttps: true };
const options = sessionCookieOptions(externalConfig, 60_000);
const result = {
  vulnerable: {
    cookieHeader: vulnerableHeader,
    selectedSession: vulnerableSelectedSession
  },
  patched: {
    attemptedSiblingCookieAccepted: prefixAccepts(attemptedSiblingCookie),
    cookieHeader: patchedHeader,
    selectedSession: patchedSelectedSession,
    configuredName: sessionCookieName(externalConfig),
    configuredOptions: options
  }
};

assert.equal(vulnerableSelectedSession, 'attacker-session');
assert.equal(prefixAccepts(attemptedSiblingCookie), false);
assert.equal(patchedSelectedSession, 'victim-session');
assert.equal(sessionCookieName(externalConfig), HOST_SESSION_COOKIE_NAME);
assert.equal(options.secure, true);
assert.equal(options.path, '/');
assert.equal(Object.hasOwn(options, 'domain'), false);

console.log(JSON.stringify(result, null, 2));
