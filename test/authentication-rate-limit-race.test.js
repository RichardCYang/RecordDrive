import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMfaRateLimit,
  clearLoginAttempts,
  loginRateLimit,
  recordLoginFailure,
  recordMfaFailure,
  recordSecurityPasswordFailure,
  resetAuthenticationRateLimits,
  securityPasswordRateLimit
} from '../src/middleware/login-rate-limit.js';

function makeRequest({ username = 'victim', userId = 7 } = {}) {
  return {
    ip: '198.51.100.25',
    body: { username, returnTo: '/' },
    currentUser: { id: userId },
    session: {},
    t: (message) => message
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    rendered: false,
    redirected: false,
    set(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    render() {
      this.rendered = true;
      return this;
    },
    redirect() {
      this.redirected = true;
      return this;
    }
  };
}

test.afterEach(() => resetAuthenticationRateLimits());

test('counts concurrent password checks before asynchronous verification completes', () => {
  const accepted = [];
  const blocked = [];

  for (let index = 0; index < 100; index += 1) {
    const req = makeRequest();
    const res = makeResponse();
    loginRateLimit(req, res, () => accepted.push(req));
    if (res.statusCode === 429) blocked.push(res);
  }

  assert.equal(accepted.length, 10);
  assert.equal(blocked.length, 90);
  assert.ok(blocked.every((res) => Number(res.headers['retry-after']) > 0));

  for (const req of accepted) recordLoginFailure(req, 'victim');
  const finalResponse = makeResponse();
  loginRateLimit(makeRequest(), finalResponse, () => assert.fail('The account should remain limited'));
  assert.equal(finalResponse.statusCode, 429);
});

test('preserves other in-flight password checks when one concurrent request succeeds', () => {
  const accepted = [];
  for (let index = 0; index < 10; index += 1) {
    const req = makeRequest();
    loginRateLimit(req, makeResponse(), () => accepted.push(req));
  }
  assert.equal(accepted.length, 10);

  clearLoginAttempts('victim', accepted.shift());

  const replacement = makeRequest();
  loginRateLimit(replacement, makeResponse(), () => accepted.push(replacement));
  assert.equal(accepted.length, 10);

  const blockedResponse = makeResponse();
  loginRateLimit(makeRequest(), blockedResponse, () => assert.fail('Only one replacement should be admitted'));
  assert.equal(blockedResponse.statusCode, 429);

  for (const req of accepted) recordLoginFailure(req, 'victim');
});

test('counts concurrent MFA checks before TOTP or passkey verification completes', () => {
  const accepted = [];
  let blocked = 0;

  for (let index = 0; index < 100; index += 1) {
    const req = makeRequest();
    const limit = checkMfaRateLimit(req, 7, { reserve: true });
    if (limit.blocked) blocked += 1;
    else accepted.push(req);
  }

  assert.equal(accepted.length, 10);
  assert.equal(blocked, 90);
  for (const req of accepted) recordMfaFailure(req, 7);
  assert.equal(checkMfaRateLimit(makeRequest(), 7).blocked, true);
});

test('counts concurrent security reauthentication checks independently of session writes', () => {
  const accepted = [];
  const blocked = [];

  for (let index = 0; index < 100; index += 1) {
    const req = makeRequest();
    const res = makeResponse();
    securityPasswordRateLimit(req, res, () => accepted.push(req));
    if (res.redirected) blocked.push(res);
  }

  assert.equal(accepted.length, 5);
  assert.equal(blocked.length, 95);
  assert.ok(blocked.every((res) => Number(res.headers['retry-after']) > 0));
  for (const req of accepted) recordSecurityPasswordFailure(req, 7);
});
