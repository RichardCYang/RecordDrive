# Confidentiality Review: Chunk-Boundary Disclosure Revocation Hardening — 2026-07-23

## Executive summary

A source-assisted confidentiality review of the supplied RecordDrive 2.0.5 project confirmed one additional high-impact authorization-lifecycle weakness in the protected file pump introduced by the earlier in-flight revocation hardening.

The pump rechecked live authorization on a 250 ms timer, but its checks immediately before and after each asynchronous read reused a cached positive decision until that interval elapsed. A fast download or inline PDF response could therefore send many 64 KiB chunks—and, for files small enough to complete inside the cache window, the complete file—after the underlying session or repository permission had already been revoked.

The weakness did **not** let an initially unauthorized requester start a transfer. Exploitation required a transfer that was authorized at route entry and a permission/session revocation while that response was active. The confidentiality impact remained high because revocation is a primary containment action for stolen sessions, accidental sharing, deleted files, disabled users, password/security changes, and administrator access removal.

RecordDrive 2.0.6 fixes the issue by forcing a current authorization decision after every asynchronous file read and immediately before the next output chunk can leave the process. The interval timer remains in place so idle or backpressured transfers are also terminated promptly. The change bounds application-level disclosure after an observed revocation to the chunk already authorized or accepted by the destination; with the default configuration, that bound is 64 KiB.

## Scope and method

The review covered:

- authentication, encrypted server-side sessions, revocation tombstones, rolling expiry, and absolute expiry;
- repository, file, preview, and download authorization;
- protected file and generated-preview response pumps, backpressure, disconnects, and descriptor lifecycle;
- upload processing, path canonicalization, symbolic-link defenses, storage permissions, error/log handling, Host validation, CSRF, MFA material, and tenant-scoped names;
- locked direct dependencies and relevant public security advisories available on 2026-07-23;
- the supplied `.git` directory and final archive preservation requirements.

Validation combined manual source/data-flow review, a deterministic local before/after PoC, production-helper regression tests, prior confidentiality PoCs, all-source JavaScript syntax checks, JSON parsing checks, and exact original-versus-fixed `.git` filesystem/archive comparisons.

## Confirmed finding

### RD-CONF-2026-07-23-03: Cached authorization decision permits multi-chunk disclosure after revocation

**Impact:** High confidentiality impact  
**Exploitability:** Constrained to an already-authorized active transfer  
**Affected build:** RecordDrive 2.0.5  
**Remediated build:** RecordDrive 2.0.6  
**Relevant weakness classes:** CWE-863 (Incorrect Authorization), CWE-613 (Insufficient Session Expiration)

`src/protected-file-stream.js` maintained `nextAuthorizationCheckAt`. Calls to `verifyAuthorization()` returned `true` without consulting `isAuthorized()` while the cached decision remained inside the configured recheck interval.

The file pump used these non-forced calls in the transfer loop. An asynchronous `fs.read()` yielded to other requests, so an owner or administrator could revoke the session or permission at that point. When the read completed, however, the post-read check still accepted the cached decision and wrote the chunk. A fast destination could repeat the loop and finish the response before the 250 ms timer performed another live check.

This defeated the intended statement that active disclosures are bounded to one application chunk after revocation. The actual bound was time-based and therefore depended on file size, storage speed, destination speed, event-loop scheduling, and timer latency.

## Deterministic reproduction

The PoC uses a 1 MiB synthetic confidential file and 64 KiB chunks. The destination revokes authorization immediately after accepting the first chunk while the cached-decision window is set to 60 seconds, making the race deterministic rather than timing-sensitive.

Command:

```bash
node security-poc/chunk-boundary-disclosure-revocation.mjs
```

Result:

```json
{
  "scenario": {
    "payloadBytes": 1048576,
    "chunkBytes": 65536,
    "revocationMoment": "immediately after the first destination write",
    "cachedDecisionWindowMs": 60000
  },
  "originalModel": {
    "writes": 16,
    "disclosedBytes": 1048576,
    "revoked": false
  },
  "patchedModel": {
    "writes": 1,
    "disclosedBytes": 65536,
    "revoked": true
  },
  "verdict": "BLOCKED"
}
```

The original behavior disclosed all 16 chunks. The patched production helper accepted only the first 64 KiB chunk and then destroyed the response when the next fresh authorization decision observed revocation.

## Remediation

### Fresh authorization at the chunk boundary

The post-read check in `streamProtectedFile()` now calls `verifyAuthorization(true)` immediately before `destination.write(...)`.

This placement is deliberate:

- the file descriptor and stable file size remain those validated at route entry;
- asynchronous disk reads may complete, but their bytes cannot leave the process without a fresh live authorization decision;
- permission, account, file, repository, tombstone, encrypted session identity, and absolute session lifetime checks are all evaluated through the existing fail-closed request-bound authorizer;
- an authorization exception terminates the response rather than falling back to the cached state;
- the existing timer still covers transfers paused on backpressure or otherwise idle;
- descriptor completion, access-time updates, client disconnect handling, and error precedence remain unchanged.

Bytes already written to the HTTP/network stack cannot be recalled. A revocation that occurs after a successful live check may still race with the single chunk immediately written under that decision. With the default 64 KiB chunk size, the application-level residual exposure is therefore bounded to at most one chunk rather than all data transferable inside a time window.

### Regression coverage

`test/file-stream-chunk-revocation.test.js` exercises the production `streamProtectedFile()` implementation without third-party packages. It uses a destination whose first write immediately revokes the authorization callback and asserts:

- the transfer reports `revoked: true`;
- exactly one write occurs;
- exactly 65,536 bytes are disclosed;
- the complete 1 MiB file is not disclosed.

The test is included in `npm run test:security`.

## Broader confidentiality findings

No additional severe confidentiality vulnerability was confirmed in the reviewed source paths after this fix. The independent pass reconfirmed the existing defenses for:

- object- and tenant-scoped repository/file authorization with generic unauthorized/not-found handling;
- HMAC-indexed AES-GCM server-side sessions, tombstones, absolute lifetime, current encrypted identity binding, and fail-closed corruption handling;
- immediate reauthorization for generated JSON previews and per-chunk reauthorization for file/PDF responses;
- canonical storage roots, generated stored names, exclusive/no-follow upload creation, no-follow regular-file opens, and stable-size disclosure;
- pre-session Host validation, external HTTPS fail-closed defaults, secure cookies, `no-store` authenticated responses, and restrictive CSP/framing behavior;
- pre-multipart CSRF validation, strict upload counts/sizes/parts/fields, and disabled multipart field nesting;
- bounded, non-executing document/archive previews and sanitized parser/request error logs;
- MFA secret/recovery-code disclosure expiry and tenant-scoped repository-name uniqueness.

## Dependency and runtime review

The lockfile resolves Multer 2.2.0, which is the patched version for the June 2026 incomplete-aborted-upload and deeply nested field-name advisories. RecordDrive additionally sets `limits.fieldNestingDepth: 0` and strict multipart limits. The lockfile resolves yauzl 3.4.0, newer than the 3.2.1 fix for CVE-2026-31988.

The project declares Node.js `^22.23.0 || ^24.17.0 || ^26.3.1`, matching the patched release floors published in the Node.js June 18, 2026 security release. The assessment container provided Node.js 22.16.0, which is outside the declared support range, although dependency-free source tests and Node SQLite PoCs could still be run.

Relevant upstream references:

- [Node.js June 18, 2026 security releases](https://nodejs.org/en/blog/vulnerability/june-2026-security-releases)
- [Multer CVE-2026-5038 / GHSA-3p4h-7m6x-2hcm](https://github.com/advisories/GHSA-3p4h-7m6x-2hcm)
- [Multer CVE-2026-5079 / GHSA-72gw-mp4g-v24j](https://github.com/advisories/GHSA-72gw-mp4g-v24j)
- [yauzl CVE-2026-31988 / GHSA-gmq8-994r-jv83](https://github.com/advisories/GHSA-gmq8-994r-jv83)

## Validation summary

- New original cached-decision model: **VULNERABLE**; 1,048,576 of 1,048,576 bytes disclosed after revocation.
- Patched production file pump: **BLOCKED**; 65,536 of 1,048,576 bytes disclosed, then response terminated.
- Focused confidentiality/unit suite: **37 passed, 0 failed**.
- Prior disclosure/revocation PoCs: **BLOCKED/PASS**.
- `npm run check`: **passed**.
- JavaScript/ESM/CommonJS syntax: **138 files checked, 0 failures**.
- JSON parsing: **6 files checked, 0 failures**.
- Full dependency-backed integration suite and `npm audit`: **not executed**, because the assessment environment could not complete registry installation.
- Assessment runtime: Node.js **22.16.0**, below the declared supported 22.x floor of **22.23.0**.
- Temporary `express-session` import-shape stub: used only in the disposable test runtime and excluded from the deliverable.
- `.git`: **44 entries preserved with zero filesystem, ZIP metadata, uncompressed-data, or raw local-record differences**; exact hashes are in the evidence record.

## Residual risks

The following are architectural or operational residual risks rather than newly confirmed severe source defects:

1. Revocation cannot retract bytes already accepted by the response/network stack; one authorized output chunk may race with the revocation event.
2. Stored file contents are protected by filesystem permissions and application authorization but are not encrypted at rest by RecordDrive itself.
3. Login/security throttles are process-local unless deployment adds a shared external control for multi-instance operation.
4. The complete dependency-backed suite, registry audit, and production deployment tests should be repeated on a declared Node.js version with a healthy trusted registry.
5. Long downloads now perform a live server-side authorization check per 64 KiB chunk. Operators should monitor database load and latency; weakening the per-chunk decision would reintroduce the confidentiality gap unless replaced by an equally strong push-based revocation mechanism.

## Files changed

- `src/protected-file-stream.js`
- `test/file-stream-chunk-revocation.test.js`
- `security-poc/chunk-boundary-disclosure-revocation.mjs`
- `package.json`
- `package-lock.json`
- `docs/security/README.md`
- `docs/security/evidence/security-poc-guide.md`
- `docs/security/reports/2026-07-23-chunk-boundary-disclosure-revocation-hardening.md`
- `docs/security/evidence/2026-07-23-chunk-boundary-disclosure-revocation-results.txt`
- `docs/security/sbom/recorddrive-security-sbom.cdx.json`

The `.git` directory was not edited, deleted, regenerated, or used for write operations. The final filesystem and archive comparisons found zero differences across all 44 `.git` entries.
