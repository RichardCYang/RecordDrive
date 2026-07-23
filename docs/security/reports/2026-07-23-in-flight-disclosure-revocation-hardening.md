# Confidentiality Review: In-Flight Disclosure Revocation Hardening — 2026-07-23

## Executive summary

A source-assisted confidentiality review of the supplied RecordDrive 2.0.2 project confirmed one high-impact authorization-lifecycle weakness. A user or stolen authenticated session that had already started a large file download or inline PDF preview could continue receiving the entire file after the repository owner or administrator revoked download permission, removed the file or account, disabled administrator access, logged the session out, or invalidated sessions through a password/security change.

The finding did **not** allow an initially unauthorized requester to start a download. It broke the confidentiality guarantee expected after a legitimate revocation event because authorization was evaluated only once at route entry and the resulting file descriptor continued streaming without consulting current server state.

RecordDrive 2.0.3 fixes the issue by using a fail-closed disclosure authorizer and a revocation-aware file pump. The implementation rechecks the live server-side session, revocation tombstone, account state, repository, file record, and current download permission before disclosure, before/after bounded reads when the recheck interval has elapsed, and every 250 milliseconds while a transfer remains active. Structured XLSX, ZIP, and 7z previews are rechecked immediately before their JSON metadata is returned.

## Scope and method

The review covered:

- authentication and server-side session persistence;
- repository and object authorization;
- file lookup, no-follow opening, preview, and download paths;
- revocation operations triggered by logout, password/MFA changes, account changes, permission changes, file/repository deletion, and administrator disablement;
- logging, templates, public/static paths, storage path validation, archive/document preview boundaries, configuration defaults, and reachable Git history;
- direct dependency versions and relevant upstream security advisories available during the review.

Validation combined manual source review, high-confidence pattern searches, a deterministic local SQLite/file-stream PoC, focused regression tests, all-source syntax checks, secret/history scans, and an exact `.git` filesystem manifest comparison.

## Confirmed finding

### RD-CONF-2026-07-23-01: In-flight file disclosure survives authorization and session revocation

**Impact:** High confidentiality impact  
**Affected build:** RecordDrive 2.0.2  
**Remediated build:** RecordDrive 2.0.3  
**Relevant weakness classes:** CWE-863 (Incorrect Authorization), CWE-613 (Insufficient Session Expiration)

The download and PDF-preview routes used repository middleware to confirm `download` permission once, opened the stored file safely, and then called `fs.createReadStream(...).pipe(res)`. The route never consulted the permission row or server-side session again. The file descriptor remained readable even if the database file record, repository permission, user account, or session row was removed while the response was still active.

An attacker could deliberately keep a large response in flight by reading slowly. If the legitimate owner then removed access, or the account owner responded to a suspected session theft by logging out or changing credentials, the already-open response continued disclosing bytes until EOF.

### Original-code reproduction model

The local PoC models the original route exactly at the relevant security boundary: authorize once, start the file stream, then revoke permission or the server-side session after the first chunk.

```json
{
  "fileSize": 2097152,
  "baseline": {
    "permissionRevocation": {
      "receivedBytes": 2097152,
      "completed": true,
      "fullDisclosure": true
    },
    "sessionRevocation": {
      "receivedBytes": 2097152,
      "completed": true,
      "fullDisclosure": true
    }
  }
}
```

Both revocation scenarios disclosed the complete 2 MiB synthetic confidential file.

## Remediation

### 1. Current-state disclosure authorizer

`src/disclosure-authorization.js` creates a request-bound, fail-closed callback that verifies:

- the HMAC-derived server-side session row still exists and has not expired;
- no active revocation tombstone exists for that session;
- the user account still exists and is not in forced-password-change state;
- the repository still exists;
- administrator-disable, owner, and explicit grant rules still allow `download`;
- the same file record still exists in the same repository.

`src/session-store.js` now exports a prepared session-activity checker so long-running disclosures use the same HMAC session identifier and tombstone semantics as the session store.

### 2. Revocation-aware bounded file pump

`src/protected-file-stream.js` replaces the unmonitored `ReadStream.pipe()` path for confidential responses. It:

- reads only from the already validated/no-follow file descriptor, avoiding a path reopen;
- caps disclosure to the stable size captured by the original `fstat`, so later appended bytes cannot be exposed;
- keeps at most one bounded 64 KiB output chunk in the application-level pump;
- revalidates authorization before and after reads when due and on a 250 ms timer;
- stops writing and destroys the HTTP response when authorization becomes false or the check fails;
- waits for an outstanding asynchronous file read to finish before updating access time and closing the descriptor, preventing descriptor-reuse races;
- preserves backpressure and client-disconnect behavior.

Bytes already accepted by the network stack cannot be recalled. The remediation prevents the remainder of a long-running response from continuing after the application observes revocation and bounds the application-level post-check chunk to 64 KiB.

### 3. Preview response recheck

PDF previews use the same protected stream as downloads. XLSX, ZIP, and 7z preview generation does not send file bytes while parsing, so those routes perform a fresh disclosure authorization check immediately before returning metadata JSON.

## Patched PoC result

Command:

```bash
node security-poc/in-flight-disclosure-revocation.mjs
```

Result:

```json
{
  "fileSize": 2097152,
  "baseline": {
    "permissionRevocation": {
      "receivedBytes": 2097152,
      "completed": true,
      "fullDisclosure": true
    },
    "sessionRevocation": {
      "receivedBytes": 2097152,
      "completed": true,
      "fullDisclosure": true
    }
  },
  "patched": {
    "permissionRevocation": {
      "receivedBytes": 65536,
      "completed": false,
      "fullDisclosure": false,
      "revoked": true
    },
    "sessionRevocation": {
      "receivedBytes": 65536,
      "completed": false,
      "fullDisclosure": false,
      "revoked": true
    }
  },
  "verdict": "BLOCKED"
}
```

The patched implementation terminated both transfers after one 64 KiB chunk instead of disclosing the complete file.

## Broader confidentiality review

No additional severe confidentiality vulnerability was confirmed in the reviewed source paths. In particular, the independent pass reconfirmed:

- deny-by-default repository authorization and repository-scoped object queries;
- generic not-found behavior for unauthorized repositories/files;
- generated storage names, canonical storage roots, restrictive modes, no-follow opens, regular-file verification, and symbolic-link rejection;
- pre-session Host validation, externally reachable HTTPS fail-closed behavior, strict/secure cookies, rolling and absolute session lifetimes, HMAC-indexed session rows, encrypted session payloads, and authenticated-response `no-store` caching;
- CSRF checks before multipart processing, streaming quotas, bounded fields/files/parts, disabled multipart field nesting, and exclusive/no-follow upload creation;
- non-executing bounded archive/document previews, sandboxed PDF framing, and text-only spreadsheet/archive rendering;
- generic external errors and request-error logging that excludes submitted bodies and secret-bearing properties;
- no production private key, real API/service token, production `.env`, password database, or committed application database in the supplied working tree or reachable Git history. Matches were examples, documentation, or synthetic tests/PoCs.

## Dependency review and environment limitation

The locked direct dependencies and relevant upstream advisories were reviewed. Multer 2.2.0 is the patched release for the reviewed incomplete-upload and nested-field advisories, and RecordDrive sets `fieldNestingDepth: 0` with strict field/part limits. This targeted review does not replace registry-backed software-composition analysis.

A complete `npm ci`, full integration suite, and `npm audit` could not run because the configured registry returned HTTP 503 for the locked `zip-stream@4.1.1` artifact during the assessment. One Supertest-backed request-error test was therefore unavailable; its failure was a missing-package import, not an application assertion. Focused tests used a minimal local `express-session` Store import-shape stub because registry installation was unavailable. The stub is not included in the final archive.

The assessment runtime was Node.js 22.16.0 while the project declares Node.js 22.23.0 or later in the 22.x line. Syntax, Node SQLite behavior, session state, and the production disclosure helper were exercised, but the complete suite should be repeated on a declared engine version with a healthy trusted registry.

## Validation summary

- Original authorize-once model: **VULNERABLE**; full file disclosed after permission and session revocation.
- Patched production authorizer/file pump: **BLOCKED**; both transfers terminated after 65,536 of 2,097,152 bytes.
- New focused disclosure tests: **2 passed, 0 failed**.
- Existing focused session-revocation tests: **8 passed, 0 failed**.
- Additional dependency-free confidentiality/unit tests: **16 passed, 0 application assertion failures**.
- Supertest-backed request-error route case: **1 unavailable** because dependencies could not be installed.
- Project `npm run check`: **passed**.
- All JavaScript/ESM/CommonJS files outside `.git` and `node_modules`: **125 checked, 0 syntax failures**.
- JSON files outside `.git` and `node_modules`: **6 parsed, 0 failures**.
- Original-versus-fixed project comparison: **6 files added, 8 files modified, 0 files deleted**.
- Final `.git` comparison: **43 descendants plus the `.git` directory matched the extracted original for path, type, mode, owner IDs, modification time, size, symlink target, and content hash**. The final ZIP copies every `.git` entry byte-for-byte with the original ZIP entry metadata.
- Temporary dependency stub / `node_modules`: **absent from the final tree**.

## Changed files

- `package.json`
- `package-lock.json`
- `README.md`
- `src/session-store.js`
- `src/disclosure-authorization.js`
- `src/protected-file-stream.js`
- `src/routes/repositories.js`
- `test/in-flight-disclosure-revocation.test.js`
- `security-poc/in-flight-disclosure-revocation.mjs`
- `docs/security/evidence/security-poc-guide.md`
- `docs/security/evidence/2026-07-23-in-flight-disclosure-revocation-results.txt`
- `docs/security/sbom/recorddrive-security-sbom.cdx.json`
- this report and `docs/security/README.md`

## Residual risk

Revocation cannot retract bytes already sent or buffered before the server observes the changed state. The 250 ms/current-chunk design intentionally balances prompt revocation against synchronous SQLite query overhead. Environments requiring tighter controls can reduce the interval in a future configurable design or use an event/epoch invalidation mechanism, but they should measure database and transfer performance.

Local operating-system administrators, processes running as the RecordDrive service account, database compromise, malicious dependencies, and compromise of the configured secret/storage volume remain outside this application-level control. Repeat full installation, integration, and software-composition testing on the declared Node.js engine before production deployment.

## References

- OWASP Authorization Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html>
- OWASP Session Management Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html>
- OWASP Business Logic Security Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Business_Logic_Security_Cheat_Sheet.html>
- Multer incomplete-upload advisory: <https://github.com/advisories/GHSA-3p4h-7m6x-2hcm>
- Multer nested-field advisory: <https://github.com/advisories/GHSA-72gw-mp4g-v24j>
