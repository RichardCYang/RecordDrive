# MFA Sensitive Session Material Disclosure Hardening

**Assessment date:** 2026-07-23  
**Affected build:** supplied RecordDrive 2.0.5 snapshot  
**Remediated build:** hardened RecordDrive 2.0.5 assessment build  
**Primary impact:** High confidentiality impact with persistent account-takeover potential  
**Relevant weakness classes:** CWE-613 (Insufficient Session Expiration), CWE-863 (Incorrect Authorization)

## Executive summary

A serious confidentiality boundary defect was confirmed in the account-security settings flow. Creating a TOTP enrollment secret or a new recovery-code bundle required a recent password verification, but later disclosure by `GET /settings` was not bound to that verification's remaining lifetime.

The issue did not provide an unauthenticated entry point. Exploitation requires possession of a valid authenticated session identifier and a victim who generated MFA material near the end of the ten-minute security-verification window. Under those conditions, a stolen session could retrieve:

- the pending TOTP setup secret for the enrollment object's own ten-minute lifetime, even after the password-verification window expired; and
- newly generated recovery codes from the encrypted session payload without any disclosure-time reauthentication check.

These values are long-lived authentication material. A copied TOTP seed can clone an authenticator if the victim later completes enrollment, and copied recovery codes can be used for future sign-in. The result is materially more persistent than ordinary read access through the stolen session.

## Root cause

RecordDrive correctly placed `requireRecentSecurityVerification` on the state-changing TOTP, recovery-code, and passkey routes. However, the response that displayed the generated material was a later ordinary authenticated request:

```text
POST sensitive operation -> redirect or JSON success -> GET /settings -> decrypt and render
```

The original `pendingTotpFromSession()` validated only `pendingTotpEnrollment.createdAt`. The original `consumeNewRecoveryCodes()` decrypted any session bundle that existed and then deleted it. Neither function required the original password verification or sign-in timestamp to still be within `SECURITY_VERIFICATION_MAX_AGE_MS` when disclosure occurred.

This created a split authorization boundary: authorization was checked when the material was created, but not when the material was actually disclosed.

## Deterministic PoC

Run:

```bash
node security-poc/mfa-sensitive-session-material.mjs
```

The scenario uses fixed timestamps:

- sign-in/password verification: `1800000000000`;
- MFA material generated nine minutes later: `1800000540000`;
- stolen-session read fifteen minutes after authentication: `1800000900000`;
- the read occurs five minutes after security verification has expired, but only six minutes after the material was generated.

Expected result:

```json
{
  "originalModel": {
    "totpSecretDisclosed": true,
    "recoveryCodesDisclosed": true
  },
  "patchedModel": {
    "disclosureExpiresAt": 1800000600000,
    "securityVerificationExpiresAt": 1800000600000,
    "totpSecretDisclosed": false,
    "recoveryCodesDisclosed": false
  },
  "verdict": "BLOCKED"
}
```

The original model mirrors the supplied route's two disclosure decisions: TOTP depended only on enrollment age, while recovery codes had no separate display expiry. The patched model calls the production helper used by the repaired route.

## Remediation

### 1. Bind sensitive material to the active security-verification expiry

`src/sensitive-session-material.js` now calculates the end of the currently active security-verification window from `authenticatedAt` and `securityVerifiedAt`.

When TOTP setup data or recovery codes are created, RecordDrive stores an explicit disclosure expiry equal to the earlier of:

- the material's own maximum display lifetime; and
- the active password/sign-in security-verification expiry.

This prevents a new object created near the end of a verification window from silently extending that window.

### 2. Reauthorize at disclosure time, before decryption

`GET /settings` now requires all of the following before decrypting or rendering TOTP setup data or recovery codes:

- a valid, non-future security-verification timestamp;
- an active security-verification window at the time of the GET request;
- a positive, safe, explicit disclosure-expiry timestamp; and
- a disclosure expiry that has not elapsed.

Legacy session entries without the new expiry metadata, malformed values, future timestamps, and expired entries fail closed and are removed without disclosing their plaintext.
Because QR-code generation is asynchronous, both TOTP and recovery-code authorization are checked again immediately before the settings response is rendered.

### 3. Recheck after asynchronous authenticator operations

TOTP verification and WebAuthn registration verification are asynchronous. The route now rechecks recent security verification after those operations and before persisting a new factor or producing recovery codes. This closes the boundary where the ten-minute window could expire while the request was still processing.

### 4. Preserve existing response protections

The settings page already sends `Cache-Control: no-store`; this remains unchanged. The patch narrows server-side authorization and does not rely on browser caching behavior as the confidentiality control.

## Regression coverage

New dependency-free tests validate:

- disclosure expiry is capped at the active password/sign-in verification expiry;
- a newer valid password verification is honored without extending the material's own lifetime;
- legacy, malformed, expired, and future metadata fails closed; and
- the settings route stores and checks explicit expiries for both TOTP and recovery-code material.

Focused result:

```text
4 passed, 0 failed
```

A wider dependency-free security group passed:

```text
21 passed, 0 failed
```

The request-error confidentiality group also passed:

```text
3 passed, 0 failed
```

All 132 JavaScript, ESM, and CommonJS source/test/PoC files outside `.git` and `node_modules` passed `node --check`.
A deterministic randomized invariant check executed 100,000 timestamp combinations with zero failures.

## Broader confidentiality review

No additional severe confidentiality vulnerability was confirmed in the supplied current source after reviewing authentication state, server-side sessions, repository ACLs, file lookup scoping, uploads, downloads, previews, error logging, storage-root validation, TLS settings, and the reachable Git history.

Controls reconfirmed in the current source include:

- repository-scoped file and folder queries with deny-by-default permission middleware;
- current authorization and session-state rechecks during protected file and generated-preview output;
- randomized stored filenames, restrictive storage permissions, canonical storage-root validation, no-follow opens, and descriptor identity checks;
- strict pre-session Host validation, HTTPS enforcement for externally reachable configurations, strict/secure/HttpOnly session cookies, encrypted server-side session payloads, idle expiry, absolute expiry, and revocation tombstones;
- CSRF enforcement before multipart file creation, bounded upload dimensions, quota-aware exclusive creation, and partial-upload cleanup;
- bounded, non-executing spreadsheet/archive previews and sandboxed PDF framing;
- generic client errors and structured request-error logging that excludes submitted bodies and arbitrary secret-bearing properties.

The reachable Git object scan found no private keys, AWS access keys, GitHub tokens, Slack tokens, or JWT-shaped bearer values. The only high-risk-looking current filename was the documented `.env.example`; no production `.env` was present.

## Validation limitations

The assessment environment used Node.js 22.16.0, while the project declares Node.js 22.23.0 or later on the 22.x line. The Node.js project identifies 22.23.0 as a security release, so production validation should use a declared engine version or newer supported line.

Repeated `npm ci --ignore-scripts --no-audit --no-fund` attempts were rolled back because the configured package proxy returned HTTP 503 for locked package artifacts, including `zip-stream@4.1.1`. Consequently, the complete dependency-backed Supertest integration suite and a registry-backed `npm audit` could not be completed in this environment. This is an environment/package-availability limitation, not a successful full-suite result.

The deterministic PoC, production helper tests, dependency-free security tests, source syntax checks, static route assertions, source/lock review, and Git-history secret scan were completed.

## Standards references

- OWASP Authentication Cheat Sheet: reauthentication for sensitive features and risk events.
- OWASP Multifactor Authentication Cheat Sheet: MFA factor changes and fallback mechanisms must be strongly protected.
- OWASP Session Management Cheat Sheet: authentication state and session expiry must be enforced server-side.
- OWASP Secure Code Review Cheat Sheet: sensitive operations require reauthentication and fail-closed session lifecycle handling.

## Files changed

- `src/sensitive-session-material.js` (new)
- `src/security-service.js`
- `src/routes/settings.js`
- `security-poc/mfa-sensitive-session-material.mjs` (new)
- `test/sensitive-session-material.test.js` (new)
- `package.json`
- this report, companion evidence, PoC guide, and security documentation index

No `.git` file or directory was intentionally read-write opened, deleted, rewritten, chmodded, or timestamp-modified in the final working copy. Final byte, mode, and nanosecond timestamp verification is recorded in the companion evidence file.
