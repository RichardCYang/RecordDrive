# Recovery-Code Session Revocation Hardening

**Assessment date:** 2026-07-24  
**Affected build:** supplied RecordDrive 2.0.6 snapshot  
**Remediated build:** hardened RecordDrive 2.0.6 assessment build  
**Primary impact:** High confidentiality impact after authenticated-session theft  
**Relevant weakness class:** CWE-613 (Insufficient Session Expiration)

## Executive summary

A serious session-lifecycle inconsistency was confirmed in the MFA recovery-key settings flow. RecordDrive revoked every other session after password changes, TOTP enable/disable operations, and passkey registration/deletion, but did not revoke other sessions after recovery keys were added or regenerated.

The issue is not an unauthenticated entry point. An attacker must already possess a valid authenticated session identifier. The confidentiality impact appears when the account owner responds to suspected compromise by replacing recovery keys: the stolen session remains valid and can continue reading repositories and files until it expires or is revoked by another mechanism. On a file server, this defeats the expected containment effect of an account-recovery credential rotation.

A deterministic PoC reproduced the condition and then exercised the repaired session policy. The original model kept the attacker-controlled session active after recovery-key rotation. The patched model revoked that session while preserving the account owner's current browser session.

## Root cause

The settings router already had a shared `revokeOtherUserSessions()` helper backed by the encrypted SQLite session store and revocation tombstones. It was invoked after:

- password replacement;
- TOTP enablement;
- TOTP disablement;
- passkey registration; and
- passkey deletion.

The following two state-changing routes omitted that call:

```text
POST /settings/security/recovery-codes/add
POST /settings/security/recovery-codes/regenerate
```

Both routes required recent password verification, which protects the operation itself. That control did not invalidate an attacker session that had been stolen before the legitimate user performed the recovery action.

A second defect existed in `replaceRecoveryCodes()`: it deleted all existing rows before opening the transaction used to generate replacements. An insertion or database failure could therefore leave the account with no recovery keys. This was primarily an integrity/availability defect, but it weakened the safety of the same account-recovery path and was corrected in the same patch.

## Deterministic PoC

Run:

```bash
node security-poc/recovery-code-session-revocation.mjs
```

Expected result:

```json
{
  "finding": "Recovery-key rotation did not revoke other authenticated sessions",
  "baseline": {
    "recoveryKeysRotated": true,
    "stolenSessionStillActive": true,
    "verdict": "VULNERABLE"
  },
  "patched": {
    "revokedOtherSessions": 1,
    "stolenSessionStillActive": false,
    "currentSessionActive": true,
    "verdict": "BLOCKED"
  },
  "transactionalReplacement": {
    "forcedInsertionFailure": true,
    "previousRecoveryKeyRowsRetained": 1,
    "verdict": "ROLLED_BACK"
  }
}
```

The PoC uses the production HMAC-indexed, AES-GCM-protected SQLite session store. It creates an owner session and a second attacker-controlled session for the same user, rotates the recovery-key set, and evaluates server-side session activity before and after the patched revocation policy. A SQLite trigger then forces replacement insertion failure to verify rollback of the original recovery-key row.

## Remediation

### 1. Revoke other sessions after recovery-key changes

Both recovery-key routes now call `revokeOtherUserSessions(req, db, config)` after a successful key mutation. The helper excludes the current session identifier, so the account owner can see the newly generated keys while every other authenticated session for that user is tombstoned and deleted.

This uses the same policy and race-resistant revocation mechanism already applied to password, TOTP, and passkey changes.

### 2. Make recovery-key creation and replacement transactional

Recovery-key slot calculation, insertion, and full replacement now execute inside one `BEGIN IMMEDIATE` transaction. `replaceRecoveryCodes()` deletes the previous set and inserts the replacement set in that same transaction. Any failure rolls the operation back and preserves the prior keys.

Moving the active-key count into the write transaction also prevents parallel creation requests from observing the same stale slot count and exceeding the configured active-key cap.

### 3. Add permanent regression coverage

The new test group verifies:

- both recovery-key routes invoke other-session revocation;
- the current browser remains active while a second session is invalidated;
- a forced replacement insertion failure preserves the previous key rows; and
- a successful replacement commits only the requested bounded key set.

The new PoC and test are included in `npm run test:security`.

## Validation results

Focused patch tests:

```text
tests 4
pass 4
fail 0
```

Wider dependency-light confidentiality regression group:

```text
tests 38
pass 38
fail 0
```

All JavaScript, ESM, and CommonJS files under `src/`, `test/`, and `security-poc/` passed `node --check`.

## Broader confidentiality review

No additional severe remotely exploitable confidentiality defect was confirmed in the supplied current source after reviewing authentication, MFA state, session persistence, repository authorization, file lookup scoping, upload storage, downloads, previews, request logging, TLS configuration, administrative storage paths, and reachable Git objects.

Controls reconfirmed include:

- deny-by-default repository middleware that returns a non-enumerating 404 for unavailable repositories;
- per-chunk authorization and live encrypted-session checks during file and generated-preview disclosure;
- HMAC-indexed session identifiers, AES-GCM session payloads, server-side idle/absolute expiry, and revocation tombstones;
- randomized exclusive upload filenames, no-follow file opens, canonical path checks, restrictive directory/file modes, bounded multipart dimensions, and `fieldNestingDepth: 0`;
- fail-closed externally reachable configuration, exact Host allowlisting, HTTPS enforcement, secure/HttpOnly/SameSite cookies, CSRF validation, and no-store responses for authenticated state;
- generic external errors and structured logging that excludes submitted bodies and arbitrary error-object fields;
- bounded non-executing archive/spreadsheet previews and sandboxed inline PDF responses.

The reachable Git-object scan found no private-key blocks, AWS access keys, GitHub tokens, Slack tokens, or JWT-shaped bearer values. No production `.env`, private-key, keystore, or certificate bundle was present in the current tree.

## Dependency review

The locked Multer version is `2.2.0`, and upload parsing sets `limits.fieldNestingDepth` to `0`. GitHub's reviewed CVE-2026-5079 advisory identifies versions before `2.2.0` as affected and recommends both upgrading to `2.2.0` and setting the minimum required nesting depth, so the supplied configuration is outside that advisory's affected range and applies the recommended parser limit.

EJS templates use fixed server-selected template names. The reviewed routes do not pass request query objects as render options or allow users to provide templates, consistent with EJS's published security boundary.

## Residual risks and operational recommendations

- Uploaded file contents remain plaintext at rest. Filesystem permissions reduce local exposure, but full-volume or application-layer encryption is required against storage-media theft, privileged host compromise, snapshots, and forensic recovery.
- Cross-filesystem repository-root migration can report `cleanupRequired` if the old directory cannot be removed. Administrators must treat that message as a confidentiality warning and securely remove the old copy after verifying the active target.
- Authentication throttles are process-local. The supplied PM2 configuration uses one process; a custom clustered or horizontally scaled deployment should use a shared atomic rate-limit store.
- Already transmitted response bytes cannot be recalled after authorization changes. The application rechecks before every subsequent protected output chunk.
- MFA factor-change notifications through an independent channel are not implemented. High-value deployments should add out-of-band alerts.

## Validation limitations

The assessment environment provided Node.js 22.16.0, while this project declares `^22.23.0 || ^24.17.0 || ^26.3.1`. The configured package registry returned HTTP 503 and direct public-registry access failed DNS resolution, so `npm ci`, a registry-backed `npm audit`, and the complete dependency-backed Supertest suite could not be completed.

The deterministic production-session PoC, focused patch tests, 38-test dependency-light confidentiality group, full JavaScript syntax checks, source/lock review, targeted current advisory review, and Git-history secret scan were completed. Temporary audit-only module stubs were removed and are not included in the delivered archive.

## Standards references

- OWASP Multifactor Authentication Cheat Sheet, “Changing MFA Factors”: require reauthentication, do not rely only on an active session, and treat factor replacement as high risk.
- OWASP Session Management Cheat Sheet, “Reauthentication After Risk Events”: reauthenticate around account recovery and compromised-account flows to mitigate session hijacking.
- OWASP Forgot Password Cheat Sheet: invalidate existing sessions automatically or offer that action after recovery credential changes.
- GitHub Advisory Database GHSA-72gw-mp4g-v24j / CVE-2026-5079: Multer nested-field denial of service, patched in 2.2.0 with a recommended `fieldNestingDepth` limit.
- EJS security guidance: never give end users unfettered template/render control or pass request query objects directly as render options.

## Files changed

- `src/routes/settings.js`
- `src/security-service.js`
- `security-poc/recovery-code-session-revocation.mjs` (new)
- `test/recovery-code-session-revocation.test.js` (new)
- `package.json`
- this report, companion evidence, PoC guide, and security documentation index

The delivered archive preserves every `.git` entry from the uploaded ZIP without replacement, deletion, recompression, metadata change, or content change. Exact verification is recorded in the companion evidence file.
