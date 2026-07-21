# RecordDrive Reverse-Proxy Confidentiality Review — 2026-07-21

## Executive summary

- Reviewed build: `RecordDrive.zip`, upgraded to application version `2.0.2` by this remediation.
- Scope: authentication boundaries, deployment classification, reverse-proxy trust, HTTPS enforcement, session-cookie behavior, repository authorization, stored-file access, upload/preview handling, dependency advisories, secret exposure, and Git-history integrity.
- Result: **one High-severity confidentiality vulnerability was confirmed, reproduced through the real login route, and remediated. No unresolved Critical-severity confidentiality vulnerability was confirmed in the reviewed source.**
- Release integrity: the original `.git` directory was preserved byte-for-byte. A path-keyed SHA-256 manifest of 43 `.git` entries was identical before and after remediation: `e22d5648336d8a87435d100a36ab563cb22ef745469447302bec531a07af4a6b`.

## Methodology

1. Validated the uploaded ZIP structure and extracted it into an isolated working directory.
2. Captured a byte-level manifest of every file, directory, mode, size, and symbolic-link target under `.git` before modifying source files.
3. Traced Express middleware ordering, configuration loading, TLS and proxy handling, session storage, login/MFA flows, repository access middleware, file download/preview queries, storage-path validation, and upload streaming.
4. Exercised the vulnerable deployment path with `supertest` through the real login and CSRF flow.
5. Searched the working tree and every reachable Git blob for private keys and high-confidence AWS, GitHub, Slack, and Google credential formats.
6. Ran `git fsck --full`, syntax checks, the complete Node.js test suite, and both full and production-only `npm audit` checks.
7. Reviewed current primary guidance from Express, OWASP, and the GitHub Advisory Database.

## Confirmed finding

### RD-C-05 — Loopback reverse-proxy deployments bypassed external confidentiality controls

- Severity: **High**
- Affected configuration: `NODE_ENV=development` or `NODE_ENV=test`, loopback HTTP/HTTPS bind addresses, and any enabled `TRUST_PROXY` setting.
- Impact: A service intentionally published through a TLS-terminating reverse proxy was treated as local-only because the application classified reachability solely from the listener bind address. The service therefore allowed the known example administrator password, the example session-secret value, development-grade error disclosure, and non-mandatory HTTPS policy even though users could reach it through the proxy. An external attacker could authenticate as the bootstrap administrator when the example password remained unchanged and then access all repositories and files.

### Baseline reproduction

The review created an isolated database and upload directory, configured the application with a loopback listener and `TRUST_PROXY=1`, requested the login page using the forwarded HTTPS protocol, and submitted the real CSRF-protected login form with the documented bootstrap credentials.

Observed before remediation:

```json
{
  "configExternallyReachable": false,
  "requireHttps": false,
  "detailedErrors": true,
  "loginPageStatus": 200,
  "defaultAdminLoginStatus": 302,
  "defaultAdminLoginLocation": "/",
  "sessionCookieIssued": true
}
```

### Root cause

`applyRuntimeConfidentialityPolicy()` considered only whether the active listener address was non-loopback. A reverse proxy normally connects to a loopback-bound application, so the presence of an explicitly trusted proxy was not treated as evidence that the service crossed a deployment boundary.

Express documents that enabling `trust proxy` changes security-sensitive request properties based on reverse-proxy headers, including protocol and host information. The setting therefore represents an explicit proxy deployment boundary and must participate in confidentiality policy selection, rather than being treated only as a request-parsing option.

### Remediation

- Added trusted-proxy exposure detection to `applyRuntimeConfidentialityPolicy()`.
- Any enabled `TRUST_PROXY` value now classifies the deployment as externally reachable, even when every listener binds to loopback.
- Externally reachable deployments now fail before database initialization when the session secret, MFA encryption-key source, or administrator bootstrap password is unsafe.
- HTTPS recognition, `Secure` session cookies, and non-detailed error behavior are enforced for trusted-proxy deployments.
- Updated the configuration and deployment documentation to describe the new fail-closed behavior.
- Bumped the application version from `2.0.1` to `2.0.2`.

### Regression evidence

The original vulnerable configuration now fails before creating a database:

```json
{
  "blocked": true,
  "message": "An externally reachable deployment requires a unique SESSION_SECRET of at least 32 UTF-8 bytes.",
  "databaseCreated": false
}
```

A strong-secret loopback reverse-proxy configuration was also verified to:

- set `externallyReachable=true`;
- set `requireHttps=true`;
- set `exposeDetailedErrors=false`;
- reject a request without trusted HTTPS forwarding with HTTP 426; and
- accept the same route when a trusted proxy reports HTTPS.

## Other confidentiality areas verified

No additional severe confidentiality bypass was confirmed in the following reviewed paths:

- Repository access is evaluated on each route, and file/folder lookups bind object identifiers to the authorized repository.
- Unauthorized repository requests use a generic not-found response.
- Stored files use generated names outside the public web root, canonical path checks, owner-only permissions, and no-follow opening where supported.
- PDF previews carry a sandboxing CSP; ZIP, XLSX, and 7z metadata previews have size, entry, text, memory, and runtime bounds.
- Session identifiers stored in SQLite are keyed values rather than reusable browser session IDs; MFA and saved TLS secrets use authenticated encryption.
- Uploaded multipart field nesting is disabled, and the project uses Multer `2.2.0`, which contains the June 2026 fixes for the reviewed Multer advisories.
- No high-confidence credentials or private keys were found in the working tree or reachable Git blobs.

## Validation results

- `npm run check`: passed.
- Full test suite: **64 passed, 0 failed** on the final parallel rerun.
- The proxy confidentiality regression is covered by `test/security-hardening.test.js`.
- `npm audit`: 0 Critical, 0 High, 0 Moderate, 0 Low, 0 Informational.
- `npm audit --omit=dev`: 0 Critical, 0 High, 0 Moderate, 0 Low, 0 Informational.
- `git fsck --full`: passed.
- `.git` path/content/mode manifest comparison: 43 entries, 0 differences.

One earlier parallel test execution produced a transient timeout-style failure in the pre-existing PM2 legacy-entrypoint test. The failing test passed immediately in isolation, and the subsequent complete parallel rerun passed all 64 tests.

## Residual operational risks

- `TRUST_PROXY` must match the exact proxy topology, and the last trusted proxy must overwrite forwarded headers. Do not expose the application listener directly while it trusts a proxy.
- Uploaded files are not malware-scanned. High-risk deployments should scan or quarantine uploads and isolate preview processing at the operating-system or container boundary.
- File contents and the SQLite database are protected by application authorization and filesystem permissions but are not application-level encrypted at rest. Use encrypted storage and protected backups when the host-storage threat model requires it.
- The supplied environment used Node.js `22.16.0`, while the project declares `^22.23.0 || ^24.17.0 || ^26.3.1`; release deployment should use a declared supported runtime.

## Primary references

- Express, “Express behind proxies”: https://expressjs.com/en/guide/behind-proxies/
- Express, “session middleware”: https://expressjs.com/en/resources/middleware/session/
- OWASP Web Security Testing Guide, application platform configuration: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/02-Test_Application_Platform_Configuration
- GitHub Advisory Database, Multer incomplete cleanup advisory: https://github.com/advisories/GHSA-3p4h-7m6x-2hcm
- GitHub Advisory Database, Multer nested-field advisory: https://github.com/advisories/GHSA-72gw-mp4g-v24j
