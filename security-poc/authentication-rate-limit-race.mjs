import {
  checkMfaRateLimit,
  loginRateLimit,
  recordLoginFailure,
  recordMfaFailure,
  recordSecurityPasswordFailure,
  resetAuthenticationRateLimits,
  securityPasswordRateLimit
} from '../src/middleware/login-rate-limit.js';

const ATTEMPTS = Math.max(1, Number.parseInt(process.env.ATTEMPTS || '100', 10));

function makeRequest(username = 'victim') {
  return {
    ip: '198.51.100.25',
    body: { username, returnTo: '/' },
    currentUser: { id: 7 },
    session: {},
    t: (message) => message
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    render() { return this; },
    redirect() { this.redirected = true; return this; }
  };
}

function legacyCheckThenRecord(maximum) {
  const record = { count: 0 };
  let admitted = 0;
  const admittedRequests = [];

  for (let index = 0; index < ATTEMPTS; index += 1) {
    if (record.count >= maximum) continue;
    admitted += 1;
    admittedRequests.push(index);
  }
  for (const _request of admittedRequests) record.count += 1;
  return admitted;
}

resetAuthenticationRateLimits();
const loginRequests = [];
for (let index = 0; index < ATTEMPTS; index += 1) {
  const req = makeRequest();
  loginRateLimit(req, makeResponse(), () => loginRequests.push(req));
}
for (const req of loginRequests) recordLoginFailure(req, 'victim');

resetAuthenticationRateLimits();
const mfaRequests = [];
for (let index = 0; index < ATTEMPTS; index += 1) {
  const req = makeRequest();
  if (!checkMfaRateLimit(req, 7, { reserve: true }).blocked) mfaRequests.push(req);
}
for (const req of mfaRequests) recordMfaFailure(req, 7);

resetAuthenticationRateLimits();
const securityRequests = [];
for (let index = 0; index < ATTEMPTS; index += 1) {
  const req = makeRequest();
  securityPasswordRateLimit(req, makeResponse(), () => securityRequests.push(req));
}
for (const req of securityRequests) recordSecurityPasswordFailure(req, 7);

const result = {
  attempts: ATTEMPTS,
  legacy: {
    loginAcceptedBeforeAnyFailureCompletes: legacyCheckThenRecord(10),
    mfaAcceptedBeforeAnyFailureCompletes: legacyCheckThenRecord(10),
    securityReauthAcceptedBeforeAnyFailureCompletes: legacyCheckThenRecord(5)
  },
  patched: {
    loginAcceptedBeforeAnyFailureCompletes: loginRequests.length,
    mfaAcceptedBeforeAnyFailureCompletes: mfaRequests.length,
    securityReauthAcceptedBeforeAnyFailureCompletes: securityRequests.length
  },
  limits: {
    loginAccount: 10,
    mfaUser: 10,
    securityReauthUser: 5
  }
};
result.legacyBypassed = result.legacy.loginAcceptedBeforeAnyFailureCompletes > result.limits.loginAccount
  && result.legacy.mfaAcceptedBeforeAnyFailureCompletes > result.limits.mfaUser
  && result.legacy.securityReauthAcceptedBeforeAnyFailureCompletes > result.limits.securityReauthUser;
result.patchedBounded = result.patched.loginAcceptedBeforeAnyFailureCompletes === Math.min(ATTEMPTS, result.limits.loginAccount)
  && result.patched.mfaAcceptedBeforeAnyFailureCompletes === Math.min(ATTEMPTS, result.limits.mfaUser)
  && result.patched.securityReauthAcceptedBeforeAnyFailureCompletes === Math.min(ATTEMPTS, result.limits.securityReauthUser);

console.log(JSON.stringify(result, null, 2));
if (!result.legacyBypassed || !result.patchedBounded) process.exitCode = 1;
