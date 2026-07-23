# Confidentiality Review: Session Tombstone Expiry Hardening — 2026-07-23

## Executive summary

A source-assisted confidentiality review of the supplied RecordDrive 2.0.2 project confirmed one high-impact session-revocation flaw that remained after the 2026-07-22 tombstone remediation. A revoked authenticated session could be recreated after its revocation tombstone expired if an older in-flight request later completed and `express-session` called the custom store's `touch()` method.

The original store implemented `touch()` by delegating to `set()`. The `set()` statement is intentionally an UPSERT, so once the time-limited tombstone no longer blocked writes, the stale request recreated the deleted server-side session row. This undermined logout, password-change, MFA-change, session-limit eviction, administrator-disable, and account-deletion revocation guarantees when an attacker retained a stolen session cookie and a stale request completed late enough.

The fix makes `touch()` update-only, enforces the configured absolute session lifetime at the persistence boundary, and keeps revocation tombstones active for at least the configured absolute session lifetime across every revocation path. The deterministic original-code PoC changed from `VULNERABLE` to `BLOCKED`, and all eight focused session-revocation race tests passed.

## Assessment scope

The review prioritized unauthorized disclosure and continued access to private repository data. The examined attack surface included:

- authentication, MFA, session creation, rolling idle expiry, absolute expiry, logout, regeneration, and cross-request revocation races;
- repository-level and file-level authorization, guessed identifiers, owner/permission checks, and deny-by-default behavior;
- upload destination handling, stored-name validation, canonical path enforcement, symlink and non-regular-file defenses, and file-open flags;
- browser rendering and preview paths for text, PDF, spreadsheet, ZIP, and 7z content;
- CSRF placement, Host validation, HTTPS enforcement, cookie attributes, security headers, and error/log redaction;
- current-tree and reachable-Git-history searches for private keys, production environment files, database artifacts, and common token formats;
- locked dependency versions and directly relevant upstream security advisories available during the review.

This was a source-assisted assessment of the supplied archive, not a guarantee that every deployment-specific weakness or all unknown vulnerabilities are absent.

## Confirmed finding

### High — revoked session resurrection after tombstone expiry

**Affected component:** `src/session-store.js`

**Security property:** confidentiality and authenticated-session revocation

**Exploit preconditions:** an attacker has retained a valid session cookie, the corresponding session is revoked, and a request that loaded the session before revocation later completes after the tombstone is no longer active.

### Root cause

The supplied implementation contained:

```js
touch(sid, sess, callback = () => {}) {
  this.set(sid, sess, callback);
}
```

`set()` executes an `INSERT ... ON CONFLICT DO UPDATE`. Tombstones temporarily prevented this UPSERT, but their lifetime was derived from the idle/cookie lifetime with a one-minute minimum. After expiry, the stale `touch()` was indistinguishable from a legitimate `set()` and recreated the deleted row.

This conflicts with the store-operation distinction documented by `express-session`: `set()` is the session UPSERT operation, while `touch()` signals that an existing session is active and may reset only its idle timer. A touch operation must not create a server-side session that no longer exists.

### Deterministic original-code PoC

The PoC uses the production `SQLiteSessionStore` implementation with an in-memory SQLite database. Time is accelerated past the original tombstone expiry, then the stale in-flight session executes `touch()`.

```json
{
  "tombstoneExpiredAt": 1800000060000,
  "simulatedCompletionAt": 1800000060001,
  "delayedTouchResurrected": true,
  "resurrectedUserId": 7,
  "verdict": "VULNERABLE"
}
```

The restored row contained the authenticated `userId`, proving that server-side revocation could be undone and private repositories could again be accessed with the retained cookie.

## Remediation

### 1. Update-only `touch()`

`SQLiteSessionStore.touch()` now runs an `UPDATE sessions SET expires = ? WHERE sid = ?` guarded by the active-tombstone check. It never inserts or UPSERTs. A missing row therefore stays missing even after tombstone cleanup.

### 2. Persistence-layer absolute-expiry enforcement

The store now accepts `absoluteTtlMs` and rejects stale `set()` and `touch()` operations whose authenticated-session creation time exceeds that lifetime. This is defense in depth for delayed responses that modified session state and would otherwise call `set()` instead of `touch()`.

### 3. Revocation lifetime aligned to absolute session lifetime

The store and all password, MFA, administrator, account-deletion, and per-user session-limit purge paths now pass the configured absolute session duration to the common revocation helper. This keeps a revoked identifier blocked for the full period in which a legitimate session could otherwise remain valid.

### 4. Regression coverage and local PoC

Added coverage proves that:

- delayed `touch()` cannot recreate a row after its tombstone expires;
- an absolutely expired stale `set()` cannot recreate a revoked authenticated session;
- active tombstones still block delayed writes;
- identifier reuse remains possible after an expired tombstone for a legitimate non-stale session;
- logout, user purge, session-limit eviction, and administrator purge remain protected.

The executable regression PoC is `security-poc/session-tombstone-expiry.mjs`.

## Patched PoC result

```json
{
  "delayedTouch": {
    "tombstoneForcedExpired": true,
    "delayedTouchAttempted": true,
    "delayedTouchResurrected": false,
    "storedRows": 0
  },
  "staleSet": {
    "tombstoneForcedExpired": true,
    "absoluteLifetimeExceeded": true,
    "staleSetResurrected": false,
    "storedRows": 0
  },
  "verdict": "BLOCKED"
}
```

## Broader confidentiality review results

No additional severe confidentiality vulnerability was confirmed in the reviewed paths. The supplied project already contained substantial controls, including:

- centralized repository authorization and repository-scoped file queries with not-found behavior for unauthorized objects;
- canonical repository directories, numeric repository identifiers, validated stored names, no-follow opens, regular-file verification, restrictive directory/file modes, and symlink rejection;
- CSRF validation before multipart body processing, bounded upload fields/parts/files, quotas enforced while streaming, and exclusive/no-follow destination creation;
- bounded, non-executing archive and document preview behavior; sandboxed PDF framing; spreadsheet cells rendered as text; and no archive extraction into repository storage;
- encrypted server-side session payloads, HMAC-derived database identifiers, strict cookies, fail-closed HTTPS/Host controls, and authenticated-response cache prevention;
- generic external errors and request-error logging that excludes submitted bodies and secret-bearing fields.

A high-confidence search of the supplied working tree and all reachable Git objects found no production private key, real service token, production `.env`, or committed database object. Matches were placeholders, documentation, or test/PoC fixtures.

## Dependency review and limitation

The locked direct dependency versions were reviewed against directly relevant upstream advisories. For example, the project uses Multer 2.2.0, which is newer than the fixed 2.0.0 release identified in the reviewed official stream-cleanup advisory. This does not substitute for a complete registry-backed vulnerability audit.

A complete `npm ci`, full test suite, and `npm audit` could not be completed in the assessment environment because the configured package registry repeatedly returned HTTP 503 for the locked `zip-stream@4.1.1` artifact. The unavailable tests failed on missing imports rather than application assertions. This limitation is explicitly retained in the evidence.

Focused execution used Node.js 22.16.0, while the project declares Node.js 22.23.0 or later in the 22.x line. Syntax and focused SQLite/store behavior were verified, but the complete validation should be repeated on a declared engine version.

## Validation summary

- Original implementation tombstone-expiry PoC: **VULNERABLE**.
- Patched implementation PoC: **BLOCKED**.
- Focused session-revocation suite: **8 passed, 0 failed**.
- Additional dependency-free confidentiality/unit checks: **16 passed**; one Supertest-dependent case was unavailable because dependencies could not be installed.
- Project `npm run check`: **passed**.
- All JavaScript/ESM/CommonJS files outside `.git` and `node_modules`: **121 files checked, 0 failed**.
- Final `.git` path/type/mode/size/content comparison: **43 filesystem entries matched the original manifest exactly by path, type, mode, modification time, byte size, and SHA-256**.

## Changed files

- `src/config.js`
- `src/session-store.js`
- `src/admin-access.js`
- `src/app.js`
- `src/database.js`
- `src/routes/auth.js`
- `src/routes/settings.js`
- `src/routes/admin.js`
- `test/session-revocation-race.test.js`
- `security-poc/session-tombstone-expiry.mjs`
- `docs/security/evidence/2026-07-23-confidentiality-audit-results.txt`
- this report and `docs/security/README.md`

## Residual risk

Revocation cannot undo bytes already disclosed by a request that completed authorization before revocation. Extremely sensitive deployments should consider a revocation epoch re-check immediately before beginning or continuing long-running disclosure operations. Operational testing should also be repeated on the supported Node.js version with a healthy trusted registry, followed by `npm ci`, the complete test suite, and `npm audit` or an equivalent software-composition-analysis process.

## References

- Express `express-session` store API: <https://expressjs.com/en/resources/middleware/session/>
- OWASP Session Management Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html>
- OWASP Authorization Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html>
- Official Multer advisory reviewed: <https://github.com/expressjs/multer/security/advisories/GHSA-44fp-w29j-9vj5>
