# RecordDrive Request-Error Log Confidentiality Hardening

| Field | Value |
| --- | --- |
| Review date | 2026-07-22 (KST) |
| Reviewed archive | `RecordDrive.zip` |
| Source SHA-256 | `064053d8b3973aaa727bed7c527e5a85f645ee8106d16ac1ae023970bebe2bdf` |
| Scope | Request parsing, authentication and MFA inputs, centralized error handling, logging, error responses, repository/file authorization, secret handling, dependency posture, working-tree and Git-history secret scanning |
| Outcome | One serious confidentiality weakness was confirmed and remediated. No additional unresolved Critical-severity confidentiality defect was confirmed in the reviewed source. |

## 1. Executive summary

Malformed JSON and URL-encoded requests could reach the global Express error handler before authentication. The handler passed the complete Error object to `console.error(error)`. Express/body-parser parse errors carry the entity that failed parsing in an enumerable `body` property. Node's console formatting includes custom Error properties, so a malformed password, MFA, passkey, token, or recovery-code request could place the submitted secret and field names into service logs, container logs, log-forwarding systems, alert payloads, backups, and support exports.

The weakness is mapped to **CWE-532: Insertion of Sensitive Information into Log File**. Its confidentiality impact can be high when operational logs are available to a broader set of people or third-party systems than the primary credential store. Practical exploitability is conditional because another user's secret must be present in a malformed request and the adversary must obtain log access; the review therefore rates it **Medium-High overall / High confidentiality impact**.

## 2. Methodology

1. Validated the uploaded ZIP before extraction for traversal, symbolic links, and abnormal expansion.
2. Recorded path, mode, size, timestamp, and SHA-256 for every file under `.git` before any non-Git source change.
3. Traced middleware order, authentication, MFA, passkeys, session state, repository authorization, upload/download/preview paths, error propagation, and every application console logging sink.
4. Searched the source for dynamic command execution, outbound network clients, SQL interpolation, wildcard secret-bearing user queries, raw EJS output, dangerous browser DOM sinks, and high-confidence private keys/tokens.
5. Scanned a byte-for-byte copy of the Git object database with `git fsck` and high-confidence secret signatures.
6. Built a local synthetic PoC that exactly models the documented parser-error fields and compares the original raw-object logger with the hardened logger without emitting the synthetic credential itself.
7. Added a full Express route regression test for environments where dependencies are installed, plus dependency-free logger, source-order, and localization tests.

## 3. Confirmed and remediated finding

### RD-C-2026-13 — Request parser errors could disclose credentials and tokens through logs

- Severity: **Medium-High overall; High confidentiality impact where logs cross the credential trust boundary**
- CWE: **CWE-532**
- Affected path:
  - `express.urlencoded()` and `express.json()` execute before route authentication.
  - The original global handler called `console.error(error)` for unrecognized errors.
  - JSON parser errors expose the failed entity as `error.body`; console inspection prints that custom property.
- Sensitive inputs at risk:
  - current and new passwords;
  - TOTP and recovery codes;
  - passkey/WebAuthn response data;
  - CSRF tokens, bearer-style tokens, and any future JSON secrets handled by the service.
- Secondary robustness defect:
  - `languageMiddleware` originally ran after body parsing, so parser failures reached the error handler before `req.t` existed. The error handler could throw a second exception while handling the first one, bypassing the intended application error response.
- Exposure channels:
  - process stdout/stderr;
  - service manager and container logs;
  - centralized collectors/SIEM;
  - alert notifications, support bundles, and retained log backups.

#### Local PoC result

The synthetic Error object used `status: 400`, `type: entity.parse.failed`, and a `body` containing a fake `currentPassword` marker. Formatting it as the original logger did showed the marker, submitted field name, and `body` property. The hardened logger retained only the parser classification and status; the marker, field name, parser message fragment, and raw body were absent. Exact boolean results are stored in `docs/security/evidence/2026-07-22-request-error-log-confidentiality-results.txt`.

#### Remediation

- Added `src/request-error-security.js` with an allowlist-based log record containing only bounded `name`, `code`, `type`, and HTTP status values.
- The original Error object is never passed to `console.error` for request failures.
- Error messages are excluded from request-error logs because modern JSON parser messages can quote attacker-controlled request fragments.
- Only conventional stack frames are retained, and the first stack line containing `Error.message` is discarded.
- Recognized request-body client failures now return their proper 400-series status instead of becoming HTTP 500 responses.
- `languageMiddleware` now executes before body parsers, and the global error handler has a translation fallback to prevent error-on-error behavior for failures raised by earlier middleware.
- Added localized invalid-body responses for Japanese, Korean, French, Spanish, and Portuguese.
- Added deterministic unit tests and both dependency-free and full-application PoC/regression paths.

## 4. Additional confidentiality review results

No additional unresolved severe confidentiality defect was confirmed in the reviewed source:

- Repository view, upload, preview, download, delete, folder, settings, and permission routes retain server-side authorization middleware and repository-scoped file lookup.
- Uploaded files remain outside the public web root, use random stored names, restrictive file modes, exclusive creation, canonical path checks, and no-follow protections where available.
- No application-runtime child-process execution or outbound HTTP client was found in `src/`.
- Raw EJS output remains limited to fixed partial includes; no browser `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, or dynamic Function sink was found in public JavaScript.
- No SQL statement containing template interpolation and no wildcard `SELECT * FROM users` was found in the reviewed source.
- High-confidence working-tree secret scan: 252 files, zero private-key/cloud-token/source-control-token/API-key/JWT finding. Documented development examples remain intentionally present and are rejected for externally reachable operation by configuration policy.
- Git-copy validation: `git fsck --full --no-reflogs` passed; 614 reachable blobs were scanned with zero high-confidence key/token/private-key finding.
- Multer is locked to 2.2.0, the patched release for the June 2026 aborted-upload cleanup and deeply nested field-name advisories; the application also configures `fieldNestingDepth: 0`.

## 5. Validation performed

| Check | Result |
| --- | --- |
| Request-error logger PoC, vulnerable model | Credential marker, field name, and raw body reproduced |
| Request-error logger PoC, hardened implementation | Secret-bearing values absent; parser class retained |
| Dependency-free focused tests | 3/3 passed |
| JavaScript syntax check for every project `.js`/`.mjs` file | Passed |
| Working-tree high-confidence secret scan | 252 files; zero findings |
| Git-copy object integrity | Passed |
| Git-history high-confidence secret scan | 614 blobs; zero findings |
| Original working `.git` pre/post content and metadata manifest | Identical before packaging |
| Full dependency installation and full npm test suite | Not executed: package registry returned HTTP 503; full route test is included for normal CI |

The local runtime was Node.js `v22.16.0`, below the project's declared engine range. Production and CI should use a supported engine version from `package.json`.

## 6. Files changed

- `package.json`
- `src/app.js`
- `src/i18n-extended.js`
- `src/request-error-security.js`
- `test/request-error-confidentiality.test.js`
- `security-poc/request-error-log-confidentiality.mjs`
- `security-poc/request-error-log-object-poc.mjs`
- `docs/security/README.md`
- `docs/security/evidence/security-poc-guide.md`
- `docs/security/evidence/2026-07-22-request-error-log-confidentiality-results.txt`
- `docs/security/reports/2026-07-22-request-error-log-confidentiality-hardening.md`

## 7. Residual risks and operational requirements

- Treat logs as sensitive security data. Restrict readers, minimize retention, encrypt transport/storage, and prevent alerting or support tooling from automatically exporting request content.
- The application protects uploaded files through authorization and filesystem controls but does not itself encrypt file contents at rest. Use encrypted storage when host or storage administrators are outside the trust boundary.
- Protect session/MFA keys, TLS private keys, the SQLite database, the upload volume, and backups separately.
- Run `npm ci --ignore-scripts`, `npm audit`, the full test suite, and `npm run test:security` in CI with a supported Node.js release and a reachable trusted registry.
- Revalidate native TLS/reverse-proxy configuration in the real deployment, including exact Host allowlisting and forwarded-protocol trust.

## 8. Primary references

- Express/body-parser middleware documentation — parser errors and the `body` property
- OWASP Logging Cheat Sheet — data that should not be recorded directly in logs
- MITRE CWE-532 — Insertion of Sensitive Information into Log File
- GitHub Advisory Database — Multer GHSA-3p4h-7m6x-2hcm and GHSA-72gw-mp4g-v24j
