# Session Revocation Race Hardening — 2026-07-22

## Executive summary

A confidentiality-focused review of RecordDrive 2.0.2 confirmed one high-severity session-lifecycle vulnerability: a session that had been intentionally revoked could be recreated by an older in-flight request as that request completed. The vulnerable behavior affected password-change, MFA-change, administrator-session purge, per-user session-limit eviction, logout, and session regeneration paths because all of them ultimately relied on deleting the SQLite session row while `SQLiteSessionStore.touch()` performed an unconditional UPSERT.

The issue was reproduced against the original implementation with a local proof of concept. The fix adds HMAC-keyed, expiring session-revocation tombstones and makes every `get`, `set`, and `touch` fail closed while a tombstone is active. Revocation writes the tombstone before deleting the live row, so either ordering of concurrent writes ends with the session revoked. Focused confidentiality and race-regression tests pass after remediation.

## Scope and methodology

The review prioritized loss of confidentiality and unauthorized continuation of access. It covered:

1. Express middleware ordering, cookie settings, session loading, persistence, rotation, logout, idle renewal, and absolute-expiration behavior.
2. Password, MFA, WebAuthn, recovery-code, administrator-disable, and user-session-limit invalidation paths.
3. Repository authorization, file preview and download scoping, upload destination handling, path canonicalization, symlink defenses, archive preview boundaries, and template/browser sinks.
4. Embedded secret patterns in the current tree and all reachable Git commits.
5. Locked direct and transitive dependency versions against relevant upstream security advisories available on the review date.
6. Local PoC execution, focused regression tests, JavaScript syntax validation, ZIP safety checks, and `.git` integrity checks.

This was a source-assisted assessment, not a claim that every possible vulnerability class or deployment-specific condition has been exhaustively proven absent.

## Confirmed finding

### High — revoked session resurrection through delayed `touch()`

**Affected component:** `src/session-store.js`

**Security property:** confidentiality and access control

**Related weakness:** insufficient session expiration / operation on a resource after revocation, with a race-condition trigger

### Root cause

The original custom store implemented:

```js
touch(sid, sess, callback = () => {}) {
  this.set(sid, sess, callback);
}
```

`set()` used an unconditional SQLite `INSERT ... ON CONFLICT DO UPDATE`. Revocation routines deleted matching rows from `sessions`, but did not record that the identifier had been revoked.

An attacker holding a stolen cookie could therefore create this ordering:

1. Request A loads the stolen session into memory.
2. The account owner changes a password or MFA factor in request B.
3. Request B deletes the attacker's server-side session row.
4. Request A finishes and the session middleware calls `touch()`.
5. `touch()` delegates to `set()`, whose UPSERT recreates the deleted row.
6. The stolen cookie remains usable for subsequent requests.

The same persistence primitive was used by logout/session regeneration and session-limit or administrator-session purges, so the weakness was systemic rather than route-specific.

### Original-code PoC result

The original implementation was exercised with two sessions for one user. One session was loaded to simulate an in-flight stolen-cookie request, the other session triggered user-session purge, and the stale request then executed `touch()`.

```json
{
  "purged": 1,
  "rowsAfterPurge": 0,
  "resurrected": true,
  "resurrectedUserId": 7
}
```

The deleted session was recreated and readable, confirming an authorization-continuation and confidentiality impact.

## Remediation

### Expiring revocation tombstones

A new table stores only the protected, HMAC-derived session storage identifier and a revocation expiry:

```sql
CREATE TABLE IF NOT EXISTS revoked_sessions (
  sid TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
```

No browser-visible raw session identifier or decrypted session payload is written to this table.

### Revocation ordering

`revokeStoredSession()` writes or extends the tombstone before deleting the live row. This handles both possible writer orderings:

- If a stale writer finishes first, the subsequent revocation delete removes its row.
- If revocation writes first, conditional `set()`/`touch()` refuses the stale write.

### Fail-closed store behavior

- `get()` returns no session while a non-expired tombstone exists and removes any inconsistent live row.
- `set()` and `touch()` use a conditional UPSERT that succeeds only when no active tombstone exists.
- `destroy()` tombstones even when no current row is found, preventing an already-running request from restoring it.
- User purge, administrator purge, and session-limit pruning all use the common revocation helper.
- Expired tombstones are cleaned periodically and do not permanently reserve an identifier.
- Legacy raw session rows are deleted without copying the browser-visible identifier into the tombstone table.

### Changed and added files

- `src/session-store.js`
- `src/admin-access.js`
- `src/database.js`
- `package.json`
- `security-poc/session-revocation-race.mjs`
- `test/session-revocation-race.test.js`
- `docs/security/evidence/2026-07-22-session-revocation-race-results.txt`
- this report and the security-documentation index

## Patched PoC result

```json
{
  "purged": 1,
  "rowsAfterPurge": 0,
  "tombstonesAfterPurge": 1,
  "delayedTouchAttempted": true,
  "resurrected": false,
  "rowsAfterDelayedTouch": 0,
  "verdict": "BLOCKED"
}
```

## Validation

### Focused automated tests

The combined session-confidentiality and session-revocation suites passed 11 of 11 tests. Covered cases include:

- encrypted SQLite session payloads and HMAC storage identifiers;
- valid legacy plaintext-payload migration;
- encrypted-payload purge inspection;
- delayed `touch()` after password/MFA-style user-session purge;
- delayed `touch()` after logout/store destruction;
- delayed `touch()` after session-limit pruning;
- delayed `touch()` after administrator-session purge;
- identifier reuse after tombstone expiration; and
- deletion of legacy raw identifiers without retaining them in revocation storage.

All 120 JavaScript, ESM, and CommonJS source/test/PoC files outside `.git` and `node_modules` passed `node --check`.

### Broader confidentiality review

No additional severe confidentiality vulnerability was confirmed in the reviewed paths. Existing controls observed in the supplied project included strict pre-session Host validation, fail-closed external HTTPS requirements, AES-256-GCM server-side session payload protection, HMAC-derived session database keys, `HttpOnly`/`Secure`/`SameSite=Strict` cookies, CSRF validation, generic external errors, repository-scoped file queries, canonical-path and symlink defenses, bounded archive/document previews, upload quotas, and fixed-only EJS raw includes.

High-confidence scans of the supplied working tree and all 41 reachable Git commits found no embedded private key, cloud credential, API-token, or equivalent production-secret pattern. Credential-like values that were present were development defaults or test/PoC fixtures.

### Dependency review and environment limitation

The locked versions relevant to recent advisories include Multer 2.2.0 and UUID 11.1.1. The project also configures Multer `fieldNestingDepth: 0` plus explicit file, field, part, header, and size limits. Upstream advisories identify Multer 2.2.0 as the fixed release for the reviewed nested-field and cleanup issues, and UUID 11.1.1 as a fixed release for the reviewed buffer-bounds issue.

A full `npm install`, full project test suite, and registry-backed `npm audit` could not be completed because the configured package registry repeatedly returned HTTP 503 for a locked package artifact. Focused tests used minimal local import-shape stubs only for unavailable modules; those stubs are excluded from the delivered archive. This limitation is recorded rather than treated as a successful full dependency audit.

## Residual risk

The fix prevents a revoked session from persisting or being reused after a delayed store write. It does not retroactively cancel application work that had already passed authentication and authorization before revocation. Deployments requiring immediate cancellation of every already-running sensitive operation should additionally use per-operation revocation epochs or request cancellation checks immediately before irreversible or disclosure-producing actions.

SQLite tombstones are intentionally retained only through the longest known session lifetime (with a one-minute minimum). Session-secret rotation still invalidates all current browser cookies as expected and also changes derived storage identifiers; normal operational procedures should continue to restart all application processes together when rotating the secret.

## Repository integrity

No `.git` change is retained in the delivered project. A read-only Git status check refreshed the extracted workspace's index metadata during analysis; `.git/index` was immediately restored from the supplied ZIP. After restoration, all 44 `.git` filesystem entries (28 regular files) again matched the pre-analysis manifest by relative path, file type/mode, byte size, and SHA-256. A copied Git directory passed `git fsck --full --strict` without errors. The final archive is constructed using the original ZIP's bytes and metadata for every `.git` entry and is independently verified against the original archive.
