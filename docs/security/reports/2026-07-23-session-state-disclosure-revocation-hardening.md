# Confidentiality Review: Live Session-State Disclosure Revocation Hardening — 2026-07-23

## Executive summary

A source-assisted confidentiality review of RecordDrive 2.0.4 confirmed one authorization-lifecycle weakness in the long-running file disclosure guard. RecordDrive already rechecked authorization while downloads, PDF previews, and generated preview JSON were in flight. However, the session portion of that check considered only whether the HMAC-indexed session row still existed, had a future idle expiry, and lacked a revocation tombstone.

That row-only decision did not verify the current encrypted session payload. Consequently, a response that started under user A could continue after the same session identifier was rewritten without an authenticated user, rewritten for a different user, or passed the configured absolute authenticated-session lifetime while its database row remained live.

The issue did **not** let an initially unauthorized requester start a disclosure. It weakened the expected confidentiality boundary after authentication state changed during an already-running response. Practical exploitation requires a protected response to be active before the state transition, so the finding is best characterized as **high confidentiality impact with constrained, medium practical severity**.

RecordDrive 2.0.5 fixes the issue by making each long-running disclosure recheck decrypt and authenticate the current session payload, bind it to the user captured at route entry, require authenticated-session creation state, and enforce the configured absolute lifetime. Corrupt or unparseable session payloads fail closed.

## Scope and method

The review covered:

- authentication, MFA, session creation, mutation, expiry, regeneration, destruction, and revocation tombstones;
- repository, file, and administrator authorization;
- active file downloads, inline PDF previews, and generated XLSX/ZIP/7z preview responses;
- file naming, storage-root containment, no-follow opens, regular-file checks, upload limits, and preview parser boundaries;
- request and activity logging, templates, static exposure, TLS secret handling, Host validation, and CSRF ordering;
- the working tree and reachable Git object history for committed credentials, private keys, databases, and production environment files;
- locked dependency versions against relevant upstream advisories available on 2026-07-23.

Validation combined manual source review, high-confidence source searches, a deterministic SQLite PoC that exercises the production authorizer, focused regression tests, JavaScript/JSON syntax validation, Git-history secret scanning, and exact `.git` filesystem manifest comparison.

## Confirmed finding

### RD-CONF-2026-07-23-02: Active disclosures trust a live session row after authenticated state is gone or absolutely expired

**Affected build:** RecordDrive 2.0.4  
**Remediated build:** RecordDrive 2.0.5  
**Impact:** High confidentiality impact; medium practical severity  
**Relevant weakness classes:** CWE-613 (Insufficient Session Expiration), CWE-863 (Incorrect Authorization)

`createFileDisclosureAuthorizer()` captured the authenticated `userId` at route entry and asked `createStoredSessionActivityChecker()` whether the session was still active before later chunks were written. The original checker queried only `sessions.sid`, `sessions.expires`, and `revoked_sessions`. It did not read or decrypt `sessions.sess`.

This produced two independently reproducible gaps:

1. **Authentication-state mutation:** the same server-side session row could remain alive after its encrypted payload no longer contained `userId`. The row-only checker returned true and the disclosure continued under the stale user identity captured when the response started.
2. **Absolute-timeout bypass for an active response:** the row's rolling idle expiry could remain in the future after the authenticated session's absolute lifetime elapsed. Because the in-flight checker did not inspect `sessionCreatedAt`/`authenticatedAt`, it continued authorizing the response until another revocation condition or transport termination occurred.

A realistic state-mutation path exists in the authentication router: a failed login attempt clears `userId`, `authenticatedAt`, and `sessionCreatedAt` while preserving a limited authentication-flow user reference in the same session. The patch is intentionally placed in the disclosure authorization boundary rather than relying on every possible session mutation path to destroy or regenerate the identifier.

## Deterministic PoC

Command:

```bash
node security-poc/session-state-disclosure-revocation.mjs
```

### Original 2.0.4 result

```json
{
  "absoluteTtlMs": 1000,
  "initial": {
    "legacyRowOnly": true,
    "currentAuthorizer": true
  },
  "afterAuthenticationRemoval": {
    "legacyRowOnly": true,
    "currentAuthorizer": true
  },
  "afterAbsoluteExpiry": {
    "legacyRowOnly": true,
    "currentAuthorizer": true
  },
  "vulnerable": true,
  "blocked": false
}
```

### Patched 2.0.5 result

```json
{
  "absoluteTtlMs": 1000,
  "initial": {
    "legacyRowOnly": true,
    "currentAuthorizer": true
  },
  "afterAuthenticationRemoval": {
    "legacyRowOnly": true,
    "currentAuthorizer": false
  },
  "afterAbsoluteExpiry": {
    "legacyRowOnly": true,
    "currentAuthorizer": false
  },
  "vulnerable": false,
  "blocked": true
}
```

The `legacyRowOnly` field deliberately models the original SQL decision. It remains true because the row and idle expiry remain live. The production authorizer changes from true to false only after the patch validates the encrypted payload and absolute session lifetime.

## Remediation

### 1. Bind the active disclosure to the current encrypted session identity

`src/session-store.js` now prepares the live-session query to return the encrypted payload and decrypts it using the same AES-256-GCM protector and storage-ID additional authenticated data used by the session store.

When a disclosure supplies an expected user, the checker now requires:

- a live, non-tombstoned HMAC-indexed session row;
- successful authenticated decryption and JSON parsing of that row;
- `storedSession.userId` to equal the positive integer user captured at route entry;
- an authenticated-session creation timestamp to be present;
- the timestamp to remain within the configured absolute TTL.

Any missing row, corrupt payload, identity mismatch, unauthenticated state, or expired absolute lifetime returns false.

### 2. Pass the disclosure identity and absolute lifetime into every recheck

`src/disclosure-authorization.js` now passes `{ userId, absoluteTtlMs }` to the session checker. The TTL is derived from `config.sessionAbsoluteHours`, with the application's 168-hour default used if a partial configuration object omits the setting.

The existing protected file and protected buffer pumps already call the authorizer repeatedly. Therefore the new session-state decision automatically applies to downloads, PDF previews, and generated XLSX/ZIP/7z preview JSON without reopening paths or changing the bounded streaming design.

### 3. Update existing PoC fixtures to represent a real authenticated session

The existing in-flight disclosure PoC previously inserted a plaintext `{}` row because the old checker only needed row existence. Its fixture now inserts an AES-GCM-protected authenticated session with `userId`, `authenticatedAt`, and `sessionCreatedAt`, preserving the intent of the earlier permission/session revocation regression under the stronger checker.

## Regression validation

New regression coverage:

- same session row loses its authenticated identity: disclosure denied;
- live row exceeds absolute authenticated-session lifetime: disclosure denied;
- encrypted session payload is corrupt: disclosure denied fail-closed.

Focused production-path tests:

```text
test/in-flight-disclosure-revocation.test.js
test/session-state-disclosure-revocation.test.js

5 passed, 0 failed
```

Additional dependency-free confidentiality and security suites:

```text
33 passed, 0 failed
```

All JavaScript/ESM/CommonJS files under `src`, `test`, `security-poc`, `public`, and `vendor` passed `node --check` (128 files). All project JSON files outside `.git` and `node_modules` parsed successfully (6 files). `npm run check` passed.

## Broader confidentiality review

No additional severe confidentiality vulnerability was confirmed in the reviewed current source. The independent pass reconfirmed:

- repository-scoped object lookup and deny-by-default download/upload/delete permissions;
- active reauthorization for file and generated-preview disclosures;
- randomized stored names, canonical storage roots, restrictive permissions, no-follow opens, stable descriptor identity checks, and symbolic-link rejection;
- pre-session strict Host validation, externally reachable HTTPS fail-closed behavior, strict/secure cookies, HMAC-indexed session identifiers, AES-GCM session payloads, revocation tombstones, idle timeout, and absolute timeout middleware;
- global CSRF before multipart file creation, bounded fields/files/parts, Multer `fieldNestingDepth: 0`, cleanup on parser failure/connection abort, and quota-aware exclusive file creation;
- bounded non-executing spreadsheet/archive previews, sandboxed PDF framing, and safe DOM text insertion;
- generic external errors and request-error logging that excludes submitted bodies and secret-bearing properties;
- encrypted TLS private-key passphrases that are not rendered back to administrators;
- no production private key, live cloud/API/service token, production `.env`, password database, or committed application database in the supplied working tree or reachable Git history. Matches were examples, documentation, or synthetic tests/PoCs.

## Dependency review and limitations

The locked versions reviewed include Express 5.2.1, Multer 2.2.0, yauzl 3.4.0, EJS 6.0.1, ExcelJS 4.4.0, and uuid 11.1.1. The current Multer advisories identify 2.2.0 as the patched release for incomplete aborted-upload cleanup and deeply nested field-name denial of service; RecordDrive also explicitly sets `fieldNestingDepth: 0`. The yauzl 2026 advisory affects only 3.2.0 and is patched in 3.2.1; the lock resolves 3.4.0. The uuid buffer-bounds advisory affects versions below 11.1.1 on that release line; the lock resolves 11.1.1.

A complete `npm ci`, full Supertest-backed integration suite, and registry-backed `npm audit` could not be completed because the configured package proxy returned HTTP 503 for the locked `zip-stream@4.1.1` artifact. This is an assessment-environment dependency availability failure, not an application assertion failure. The temporary `express-session` import-shape stub used for isolated tests was deleted and is not included in the final archive.

The assessment runtime was Node.js 22.16.0, while the project declares Node.js 22.23.0 or later in the 22.x line. The focused SQLite/session/streaming code and syntax checks succeeded, but the complete suite should be repeated on a declared engine version with a healthy trusted package registry before production rollout.

## Standards and upstream references

- OWASP Authorization Cheat Sheet: validate permissions on every request and fail closed.
- OWASP Session Management Cheat Sheet: enforce expiration server-side and implement an absolute timeout regardless of activity.
- GitHub Advisory Database GHSA-3p4h-7m6x-2hcm and GHSA-72gw-mp4g-v24j: Multer 2.2.0 patched releases.
- GitHub Advisory Database GHSA-gmq8-994r-jv83: yauzl 3.2.1 patch for the 3.2.0 off-by-one issue.
- GitHub Advisory Database GHSA-w5hq-g745-h8pq: uuid 11.1.1 patch on the 11.x line.

## Files changed

- `src/session-store.js`
- `src/disclosure-authorization.js`
- `security-poc/session-state-disclosure-revocation.mjs` (new)
- `security-poc/in-flight-disclosure-revocation.mjs`
- `test/session-state-disclosure-revocation.test.js` (new)
- `package.json`
- `package-lock.json`
- `docs/security/sbom/recorddrive-security-sbom.cdx.json`
- this report, evidence, PoC guide, and security documentation index

No `.git` file or directory was deleted, rewritten, chmodded, or timestamp-modified in the fixed working copy. Exact manifest and archive verification are recorded in the companion evidence file.
