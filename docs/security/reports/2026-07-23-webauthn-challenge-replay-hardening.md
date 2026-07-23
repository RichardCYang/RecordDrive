# Confidentiality Review: WebAuthn Challenge Replay Hardening — 2026-07-23

## Executive summary

A source-assisted confidentiality review of the supplied RecordDrive 2.0.6 archive confirmed one additional authentication-concurrency weakness in the WebAuthn authentication and registration flows.

RecordDrive stored each WebAuthn challenge only inside the encrypted Express session and deleted that session field after a verification request read it. Two parallel requests carrying the same pending session could therefore deserialize independent copies of the same challenge before either request saved its deletion. Both requests could proceed to cryptographic verification with the same expected challenge. The authentication route also updated the authenticator counter without comparing the value that had been read, so a concurrent stale update was not rejected at the database boundary.

The issue did not expose credential private keys and did not let an attacker invent a valid WebAuthn assertion. Exploitation requires access to both a valid pending-MFA session and a valid assertion for its challenge, followed by a carefully timed parallel replay. Those prerequisites make exploitability constrained, but a successful race could leave an additional authenticated application session after a relayed or captured assertion was expected to be single-use. The resulting confidentiality impact is material because the additional session could retain access to protected repositories and files.

This patched audit deliverable introduces an atomic, database-backed one-time challenge ledger for both authentication and registration. The ledger binds a challenge to the session, user, purpose, value, and expiry; stores only HMAC-derived session/challenge bindings; and consumes the record with a single conditional `DELETE` before cryptographic verification. The authenticator counter update now uses compare-and-swap semantics and fails closed if another request changed the stored counter first.

## Scope and method

The review covered:

- password, TOTP, recovery-code, and WebAuthn authentication state transitions;
- encrypted server-side sessions, session identity binding, revocation tombstones, idle expiry, and absolute expiry;
- repository/file/download/preview authorization and in-flight revocation;
- upload handling, multipart limits, path canonicalization, no-follow file access, and parser isolation;
- Host validation, HTTPS/cookie policy, CSRF, error/log confidentiality, and secret material handling;
- locked direct dependencies and relevant public advisories available on 2026-07-23;
- high-confidence credential/token patterns in the working tree and every reachable Git blob;
- the supplied `.git` directory and final archive-preservation requirement.

Validation combined manual source/data-flow review, a deterministic before/after concurrency PoC, production-helper tests using Node SQLite, focused dependency-free security regressions, all-source JavaScript syntax checks, secret scans, and exact original-versus-fixed `.git` filesystem/archive comparisons.

## Confirmed finding

### RD-CONF-2026-07-23-04: Session-only WebAuthn challenge deletion is not an atomic replay barrier

**Severity:** Medium  
**Confidentiality impact:** High if the constrained race succeeds  
**Exploitability:** High complexity; requires a valid pending session and valid assertion  
**Affected source:** Supplied RecordDrive 2.0.6 archive  
**Remediated source:** This patched audit deliverable  
**Relevant weakness classes:** CWE-294 (Authentication Bypass by Capture-replay), CWE-362 (Concurrent Execution using Shared Resource with Improper Synchronization), CWE-613 (Insufficient Session Expiration)

The original flow generated a WebAuthn challenge and stored it in `req.session.webAuthnAuthentication` or `req.session.webAuthnRegistration`. Verification read that object, awaited asynchronous work, and deleted the field from its request-local session object.

That deletion was not a global, atomic consume operation. With server-side session stores, concurrent requests can load the same serialized session state before either request persists its mutation. Each request then holds an independent in-memory copy of the same challenge. Deleting the field in one copy does not prevent the other request from using its already-loaded copy.

For passkey authentication, both requests could therefore call `verifyAuthenticationResponse()` with the same expected challenge. The original credential update wrote the new counter by credential ID only. It did not require the stored counter still to equal the value used during verification, so the database did not independently reject a stale concurrent update.

WebAuthn challenges are replay defenses. The W3C WebAuthn Level 3 specification describes randomized challenges as preventing replay and requires the relying party to retain ceremony state through completion. Google's server-side passkey guidance is more explicit: generate a new challenge for every attempt, discard it after every attempt, and never accept the same challenge response more than once. SimpleWebAuthn also instructs relying parties to persist the returned counter so it can help detect replay or cloned authenticators.

Relevant upstream references:

- https://www.w3.org/TR/webauthn-3/
- https://developers.google.com/identity/passkeys/developer-guides/server-authentication
- https://simplewebauthn.dev/docs/packages/server#verifyauthenticationresponse

## Deterministic reproduction

Command:

```bash
node security-poc/webauthn-challenge-replay.mjs
```

Observed result:

```json
{
  "baseline": {
    "parallelRequests": 2,
    "acceptedWithSessionOnlyDeletion": 2,
    "vulnerable": true
  },
  "patched": {
    "parallelRequests": 2,
    "acceptedWithAtomicLedger": 1,
    "replayBlocked": true,
    "rawSessionIdStored": false,
    "rawChallengeStored": false,
    "counterCompareAndSwapPresent": true
  },
  "verdict": "BLOCKED"
}
```

The baseline portion models two request-local snapshots loaded from the same serialized session and deterministically demonstrates why local field deletion allows both requests to pass the one-time-state check. The patched portion exercises the production `issueWebAuthnChallenge()` and `consumeWebAuthnChallenge()` helpers against a real in-memory SQLite database. Exactly one of two parallel consume attempts succeeds.

The PoC does not emulate a physical authenticator or generate a hardware-backed assertion. It establishes the server-side race and validates the atomic replay barrier. A browser/authenticator integration test remains appropriate for deployment acceptance, but it is not necessary to demonstrate the original session-store synchronization defect.

## Remediation

### Atomic one-time challenge ledger

`src/webauthn-challenge-store.js` adds a `webauthn_challenges` table and two narrow helpers:

- `issueWebAuthnChallenge()` uses `BEGIN IMMEDIATE`, removes expired records, invalidates the previous challenge for the same session and purpose, and inserts one new bounded-lifetime record.
- `consumeWebAuthnChallenge()` performs one conditional `DELETE` bound to challenge ID, HMAC-derived session key, user ID, purpose, HMAC-derived challenge value, and unexpired timestamp. Success requires exactly one deleted row.

The record is consumed before either `verifyAuthenticationResponse()` or `verifyRegistrationResponse()`. The encrypted session copy is also deleted immediately. A failed cryptographic verification does not restore the challenge, so every attempt—successful or unsuccessful—is single-use.

### Protected ledger contents

The ledger does not persist the raw session ID or raw challenge. It stores:

- a 256-bit random challenge-record identifier;
- an HMAC-derived session binding using the configured session secret and a domain-separated context;
- an HMAC-derived challenge binding over session, user, purpose, and challenge;
- user, purpose, creation time, and expiry metadata.

This design avoids introducing a new plaintext authentication-state disclosure if the SQLite file is read without the session secret.

### Counter compare-and-swap

The passkey authentication route now updates the credential only when the row still has the counter value used during verification:

```sql
UPDATE webauthn_credentials
SET counter = ?, backed_up = ?, last_used_at = CURRENT_TIMESTAMP
WHERE id = ? AND user_id = ? AND counter = ?
```

A zero-row update is treated as a rejected passkey counter and the login fails closed. This closes the stale-write window independently of challenge consumption.

### Registration flow

The same ledger and consume-before-verify ordering protects passkey registration. Only the most recently issued registration challenge for a session is valid, and a registration response cannot be accepted twice.

## Validation summary

- Deterministic baseline: **VULNERABLE**; two parallel request snapshots accepted the same session-held challenge.
- Patched production challenge ledger: **BLOCKED**; exactly one of two parallel consume attempts succeeded.
- New WebAuthn regression suite: **5 passed, 0 failed**.
- Focused dependency-free security suite: **24 passed, 0 failed**.
- Broader source-test attempt: **27 passed, 0 failed, 2 unavailable** because `dotenv` and `supertest` were not installed.
- JavaScript/ESM/CommonJS syntax: **141 files checked, 0 failures**.
- Working-tree high-confidence secret scan: **0 findings**.
- Reachable Git-history high-confidence secret scan: **0 findings**.
- Full registry-backed `npm audit`: **not completed** because the configured registry returned HTTP 503.
- Full dependency installation/integration suite: **not completed** because registry installation was unavailable; no `node_modules` directory is included in the deliverable.
- Assessment runtime: Node.js **22.16.0**, below the project's declared `^22.23.0 || ^24.17.0 || ^26.3.1` engine range.

## Broader confidentiality findings

No additional severe confidentiality vulnerability was confirmed in the reviewed source after this fix. The independent pass reconfirmed the existing protections for:

- tenant/object-scoped repository and file authorization with generic failure responses;
- HMAC-indexed AES-GCM server-side sessions, fail-closed corruption handling, absolute lifetime, live identity checks, and revocation tombstones;
- per-chunk live authorization for file/PDF responses and protected streaming for generated previews;
- canonical storage roots, generated stored names, exclusive/no-follow upload creation, no-follow regular-file opens, and stable file-size checks;
- pre-session Host allowlisting, external HTTPS fail-closed behavior, secure cookies, authenticated `no-store`, CSP, and framing restrictions;
- pre-multipart CSRF validation, strict file/part/field/size limits, and disabled multipart field nesting;
- bounded non-executing document/archive previews and sanitized parser/request error handling;
- forced temporary-password replacement, bounded MFA-sensitive-material disclosure, and tenant-scoped repository names.

## Dependency and runtime review

The lockfile resolves Multer 2.2.0, the patched release for the 2026 incomplete-aborted-upload and nested multipart field-name issues. RecordDrive additionally sets `limits.fieldNestingDepth: 0` and strict multipart limits. The lockfile resolves yauzl 3.4.0, newer than the 3.2.1 correction for CVE-2026-31988, and ExcelJS 4.4.0, far newer than the historical pre-1.6.0 worksheet-name XSS issue.

The assessment environment could not obtain a healthy registry response, so these conclusions are lockfile/source applicability checks rather than a successful fresh `npm audit`. Repeat the full install, test, and audit workflow on a declared Node.js version against a trusted available registry before production release.

## Residual risks

1. A valid assertion and pending session that have already been exfiltrated remain sensitive until the challenge expires or is consumed; transport security, origin validation, secure cookies, and endpoint hardening remain essential.
2. The new ledger is process-shared only through the configured SQLite database. Any future multi-database or sharded deployment must keep challenge consumption globally atomic for a given session.
3. Authenticator counters are not guaranteed to advance on every passkey implementation. The atomic challenge consume is the primary replay barrier; the compare-and-swap counter is defense in depth.
4. Rows are expired opportunistically whenever a new challenge is issued. Continuous normal issuance keeps the table bounded to the configured lifetime window, but operators may add periodic cleanup if deployment characteristics require it.
5. Stored file contents are protected by filesystem permissions and application authorization but are not encrypted at rest by RecordDrive itself.
6. Full dependency-backed browser/WebAuthn integration and registry audit should be repeated in the target deployment environment.

## Files changed

- `src/webauthn-challenge-store.js`
- `src/database.js`
- `src/routes/auth.js`
- `src/routes/settings.js`
- `test/webauthn-challenge-replay.test.js`
- `security-poc/webauthn-challenge-replay.mjs`
- `package.json`
- `docs/security/README.md`
- `docs/security/evidence/security-poc-guide.md`
- `docs/security/reports/2026-07-23-webauthn-challenge-replay-hardening.md`
- `docs/security/evidence/2026-07-23-webauthn-challenge-replay-results.txt`

A Git inspection command refreshed the stat-cache bytes of the copied worktree’s `.git/index`. The baseline manifest detected the change immediately, and the index plus directory timestamp were restored byte-for-byte from the untouched original extraction. The uploaded archive itself was never altered. The deliverable is created by copying the original ZIP and overlaying only the non-`.git` paths listed above; final filesystem and ZIP comparisons show zero `.git` differences. Exact integrity values are recorded in the evidence file.
