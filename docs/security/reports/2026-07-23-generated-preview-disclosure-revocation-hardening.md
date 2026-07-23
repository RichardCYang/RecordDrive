# Generated Preview Disclosure Revocation Hardening — 2026-07-23

## Executive summary

A confidentiality-focused follow-up review of RecordDrive 2.0.3 confirmed one high-impact, race-dependent authorization-lifecycle weakness in generated XLSX, ZIP, and 7z previews. The application correctly rechecked current authorization after preview generation, but then passed the complete sensitive preview object to `res.json()`. That one-shot response queued the serialized body without any further current-state authorization decision. If download permission, the live session, the account, repository, or file record was revoked immediately after response transmission began, the requester could continue receiving the complete generated preview.

The issue did not allow an initially unauthorized requester to start a preview. Exploitation required a currently authorized user or stolen authenticated session and a revocation event during an active response. Its confidentiality impact is significant because XLSX previews contain cell values and spreadsheet metadata, while ZIP and 7z previews contain file and directory names. The configured preview limits permit approximately 1 MiB of spreadsheet text or visible archive-name data, plus structural metadata.

RecordDrive 2.0.4 replaces the one-shot structured-preview response with a revocation-aware protected buffer pump. The server serializes the preview once, then emits it in 16 KiB chunks, applies a fresh authorization decision before every chunk, observes writable-stream backpressure, and retains the existing periodic fail-closed authorization timer. Permission/session revocation or an authorization backend error destroys the response instead of continuing disclosure.

## Scope and methodology

The review prioritized confidentiality and current-state access control across:

1. authentication, MFA, password changes, session rotation, session storage, logout, administrator disablement, and session purge paths;
2. repository and file object authorization, IDOR resistance, upload and stored-file path handling, symlink boundaries, downloads, PDF previews, and generated XLSX/ZIP/7z previews;
3. server and browser output sinks, cache controls, error handling, activity/request logging, stored secrets, and template escaping;
4. direct dependency versions and applicable upstream advisories available on the review date;
5. current-tree and all reachable Git-history high-confidence secret patterns;
6. local before/after PoC execution, repeated timing validation, regression tests, syntax/JSON validation, archive integrity, and `.git` preservation.

This was a source-assisted assessment. It does not claim that every deployment-specific condition or vulnerability class has been exhaustively proven absent.

## Confirmed finding

### High impact — generated preview continues after revocation

**Affected endpoint:** `GET /repositories/:repositoryId/files/:fileId/preview`

**Affected preview kinds:** XLSX, ZIP, and 7z

**Security property:** confidentiality after permission/session/account/file revocation

**Related weaknesses:** incorrect authorization lifecycle / insufficient session expiration / exposure of sensitive information

### Root cause

The original route performed a current-state authorization check immediately before this response:

```js
if (!authorizeDisclosure()) {
  return res.status(404).json({ error: req.t('The requested file does not exist.') });
}
return res.json(preview);
```

The final pre-response check prevented disclosure if revocation had already completed. It did not protect the disclosure after `res.json(preview)` began. The complete object was serialized and handed to the HTTP writable as one body. Later permission/session changes could not influence that queued write.

This was a residual gap in the earlier in-flight disclosure hardening: downloads and PDF previews already used a revocation-aware file pump, while generated previews only rechecked immediately before returning JSON.

### Confidential data exposed

- XLSX previews expose worksheet names, cell values, style information, merge ranges, dimensions, and sheet metadata. Text output is bounded to 1 MiB, excluding JSON structure and style metadata.
- ZIP previews expose up to 2,500 visible entry names, with up to 1 MiB of visible name data and related size/time/type metadata.
- 7z previews expose a similarly bounded metadata tree for non-encrypted archives.

### Exploitation sequence

1. A user or stolen authenticated session has download permission and requests a structured preview.
2. Preview generation completes and the final authorization check succeeds.
3. The server starts a one-shot JSON response.
4. The owner/administrator revokes download permission, deletes the file/repository/account, or invalidates the session.
5. The already queued JSON body continues to the requester.

The attacker cannot use this issue to initiate a new unauthorized preview after revocation. The issue extends an already-started disclosure beyond the system's intended current-state revocation boundary.

## Proof of concept

The dependency-free PoC models the exact response distinction:

- **Baseline:** one serialized preview body is passed to `Writable.end(payload)`, matching the one-shot body behavior relevant to the original `res.json(preview)` path.
- **Patched:** the production `streamProtectedBuffer()` implementation emits 16 KiB chunks through a slow writable, rechecking authorization before each chunk.

The synthetic payload is 1,048,680 bytes and represents a confidential XLSX preview. Revocation occurs as soon as the first write begins.

```json
{
  "baseline": {
    "permissionRevocation": {
      "payloadBytes": 1048680,
      "receivedBytes": 1048680,
      "fullDisclosure": true
    },
    "sessionRevocation": {
      "payloadBytes": 1048680,
      "receivedBytes": 1048680,
      "fullDisclosure": true
    }
  },
  "patched": {
    "permissionRevocation": {
      "payloadBytes": 1048680,
      "receivedBytes": 16384,
      "fullDisclosure": false,
      "revoked": true
    },
    "sessionRevocation": {
      "payloadBytes": 1048680,
      "receivedBytes": 16384,
      "fullDisclosure": false,
      "revoked": true
    }
  },
  "verdict": "BLOCKED"
}
```

Twenty consecutive PoC runs produced the same patched byte counts and `BLOCKED` verdict.

## Remediation

### Revocation-aware generated-response pump

`src/protected-file-stream.js` now exports `streamProtectedBuffer()`. It:

- requires an explicit authorization callback and fails closed when it is absent, false, or throws;
- checks authorization before the first byte;
- checks authorization before every generated-response chunk;
- also retains the periodic authorization timer while waiting on a slow client;
- observes `write()` backpressure and waits for `drain` instead of unbounded queuing;
- destroys the destination when authorization is revoked; and
- reports completion through the same control shape as the protected file stream.

### Route integration

`src/routes/repositories.js` now:

- serializes generated preview JSON once;
- sets the JSON content type and exact content length;
- emits the payload through `streamProtectedBuffer()` in 16 KiB chunks; and
- uses the same current-state disclosure authorizer that validates the live session, revocation tombstone, account, repository, file record, and current download permission.

The existing final post-generation authorization check remains in place as defense in depth.

## Validation

- New generated-preview suite: **4 passed, 0 failed**.
- Combined focused confidentiality and race regression subset: **23 passed, 0 failed** after the final test additions.
- Repeated PoC stability: **20/20 `BLOCKED`** with a consistent 16 KiB partial disclosure in the controlled sink.
- JavaScript/ESM/CommonJS syntax: **127 files checked, 0 failures**.
- JSON parsing: **6 files checked, 0 failures**.
- Project `npm run check`: **passed**.
- High-confidence current-tree and 44 reachable-commit secret scan: **0 private keys, AWS access keys, GitHub tokens, Slack tokens, Google API keys, or OpenAI-style keys detected** outside test/documentation fixtures.
- `.git` extracted-tree content hash remained identical to the supplied baseline throughout analysis.

A complete `npm ci`, registry-backed `npm audit`, and full integration suite could not be completed in the sandbox. The available Node.js runtime was 22.16.0 while the project requires at least 22.23.0 in that release line, and the configured package registry returned HTTP 503 for the locked `zip-stream@4.1.1` artifact. This limitation is recorded rather than treated as a successful full dependency audit.

Multer remains locked at 2.2.0 and the upload route sets `fieldNestingDepth: 0` plus explicit field, part, header, file-count, and size limits. The reviewed Multer advisories identify 2.2.0 as the patched release for the incomplete-cleanup and nested-field issues.

## Changed files

- `README.md`
- `package.json`
- `package-lock.json`
- `src/protected-file-stream.js`
- `src/routes/repositories.js`
- `security-poc/generated-preview-disclosure-revocation.mjs`
- `test/generated-preview-disclosure-revocation.test.js`
- `test/in-flight-disclosure-revocation.test.js`
- `docs/security/evidence/security-poc-guide.md`
- `docs/security/evidence/2026-07-23-generated-preview-disclosure-revocation-results.txt`
- `docs/security/sbom/recorddrive-security-sbom.cdx.json`
- this report and `docs/security/README.md`

## Residual risk

No server can retract bytes that have already reached the client or have already been accepted by lower network buffers before revocation is observed. The fix bounds generated-preview output to a 16 KiB application chunk and performs a fresh decision before every later chunk, but the first authorized chunk may still be disclosed.

The preview is still serialized in memory before streaming; existing output limits bound this allocation. Local operating-system administrators, processes running as the service account, database/storage compromise, malicious dependencies, and deployment-layer TLS/proxy failures remain outside this application-level revocation control.

Repeat full installation, complete integration tests, and software-composition analysis on a declared supported Node.js version before production deployment.

## References

- OWASP Authorization Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html>
- OWASP Session Management Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html>
- Node.js Stream documentation: <https://nodejs.org/api/stream.html>
- Node.js HTTP documentation: <https://nodejs.org/api/http.html>
- Multer incomplete-upload cleanup advisory: <https://github.com/advisories/GHSA-3p4h-7m6x-2hcm>
- Multer nested-field advisory: <https://github.com/advisories/GHSA-72gw-mp4g-v24j>
