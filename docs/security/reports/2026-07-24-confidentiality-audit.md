# RecordDrive Confidentiality Security Audit — 2026-07-24

## Executive result

- Reviewed artifact: supplied `RecordDrive.zip` snapshot, application version 2.0.6.
- Remediated artifact version: 2.0.7.
- Confirmed result: **one High-severity, deployment-dependent confidentiality vulnerability** was reproduced and fixed.
- No unresolved Critical-severity confidentiality vulnerability was confirmed in the reviewed source.
- The original `.git` directory was excluded from every edit. All 28 `.git` files extracted from the original ZIP retained identical contents and Unix permission bits. The original Git object database also passed `git fsck --full` when checked through a disposable copy.

## Scope and methodology

The review traced configuration loading, listener/TLS behavior, Express proxy trust, Host validation, login/MFA and WebAuthn flows, session persistence/revocation, CSRF, repository authorization, upload storage, path validation, preview parsers, downloads, response caching, logging/error handling, dependency versions, working-tree secrets, and all Git blob objects.

Validation combined:

1. source and middleware-order review;
2. a dependency-light baseline PoC using the supplied 2.0.6 configuration logic and Express's documented numeric proxy-hop behavior;
3. focused fail-closed regression tests after remediation;
4. existing dependency-free confidentiality, authorization, streaming-revocation, WebAuthn, password, and race tests;
5. syntax checks for every JavaScript/MJS file;
6. targeted current-advisory review against the locked top-level versions;
7. high-confidence secret scanning of the working tree and 737 Git blob objects; and
8. byte/permission comparison of `.git` files against the original ZIP.

## Confirmed vulnerability

### RD-C-06 — Numeric reverse-proxy trust allowed forwarded-protocol spoofing

**Severity:** High, when the application HTTP listener is reachable through a direct or shorter path than the configured proxy chain.

**Affected configuration:** positive numeric `TRUST_PROXY` values such as `1`. The supplied `.env.example` explicitly recommended this form, and multiple integration tests used it.

**Root cause:** RecordDrive enforces mandatory HTTPS with `req.secure`. Express derives `req.protocol` and therefore `req.secure` from `X-Forwarded-Proto` when the immediate peer is considered trusted. Numeric trust treats hop index zero as trusted for every direct connection whenever the configured count is greater than zero. A client that reaches the app without the intended proxy can therefore send `X-Forwarded-Proto: https` over a plaintext socket.

**Confidentiality impact:** The app's HTTP 426 gate accepts the plaintext request as HTTPS. Login passwords, MFA codes, manually supplied session cookies, and authorized file/preview responses can then cross the network without transport encryption. A `Secure` response-cookie attribute does not protect credentials already submitted in the accepted plaintext request.

### Baseline reproduction

The isolated baseline PoC loaded strong secrets with `HTTP_HOST=0.0.0.0`, `TRUST_PROXY=1`, and an allowed Host, then evaluated the supplied policy and Express's numeric trust rule for the direct peer:

```json
{
  "trustProxy": 1,
  "externallyReachable": true,
  "requireHttps": true,
  "directSocketEncrypted": false,
  "attackerHeader": "X-Forwarded-Proto: https",
  "expressProtocol": "https",
  "reqSecure": true,
  "applicationHttpsGateAllows": true,
  "impact": "PLAINTEXT_APPLICATION_REQUEST_ACCEPTED"
}
```

The supplied pre-fix integration tests independently encoded the same real-route behavior: with `trustProxy: 1`, `/login` was expected to return HTTP 200 after only adding `X-Forwarded-Proto: https`.

## Remediation applied

- Positive numeric proxy-hop counts are rejected during environment parsing.
- Programmatically supplied runtime configuration is revalidated, preventing callers from bypassing environment parsing with `trustProxy: 1`.
- Boolean/universal trust, `*`, `all`, and IPv4/IPv6 `/0` ranges are rejected.
- Explicit trusted proxy IP addresses, bounded CIDR subnets, and bounded Express named ranges such as `loopback` remain supported.
- `.env.example` and README deployment guidance now require an explicit proxy identity allowlist and state that forwarded headers must be overwritten by the final trusted proxy.
- Added a focused regression test, a repeatable PoC, baseline evidence, and this audit report.
- Bumped the application version from 2.0.6 to 2.0.7.

## Other confidentiality controls reviewed

### Authentication and sensitive session state

- Session identifiers stored in SQLite are protected rather than stored as reusable browser SIDs.
- Session payloads, MFA enrollment data, recovery-code display bundles, WebAuthn challenges, and saved TLS passphrases have dedicated confidentiality controls and expiry/replay protections.
- Password changes, recovery-code use/regeneration, and other security-state changes revoke affected sessions.
- Login, MFA, and security reauthentication have race-aware rate limiting.

### Authorization and object binding

- Repository access is deny-by-default and evaluated using the current user, owner/admin status, and per-repository grant.
- Repository/file/folder identifiers are bound to the already authorized repository in database lookups.
- Unauthorized repository access uses generic 404 responses to reduce object and repository-name enumeration.
- Download and preview disclosure callbacks recheck live session state, password-change state, current repository permission, and file membership.

### File storage, upload, preview, and download

- Uploaded content is stored outside the public web root under generated stored names with restrictive permissions.
- Canonical path and symbolic-link defenses protect stored-file opening and storage-root changes.
- Multipart authorization occurs before file bytes are accepted; CSRF failures and quota failures clean temporary files.
- ZIP/XLSX/7z preview processing is bounded by compressed/uncompressed size, entry count, name/text size, concurrency, and runtime constraints. Archive previews read metadata and do not extract archive paths.
- File and generated-preview response streams reauthorize before each disclosure chunk and terminate after session or permission revocation.
- Authenticated pages, previews, and file responses use private/no-store caching behavior.

### Deployment boundary and error disclosure

- Exact Host allowlisting runs before static serving, parsers, sessions, and authentication.
- Externally reachable or proxy-published deployments require strong secrets, an explicit Host allowlist, HTTPS recognition, Secure cookies, and generic error behavior.
- The remediation closes the remaining numeric/wildcard proxy-trust escape hatch.

## Dependency review

Locked direct versions include Express 5.2.1, express-session 1.19.0, Multer 2.2.0, yauzl 3.4.0, EJS 6.0.1, and ExcelJS 4.4.0.

- Multer 2.2.0 is the patched release for the June 2026 incomplete-cleanup and deeply nested field-name advisories; the project also sets `fieldNestingDepth` to zero.
- The reviewed yauzl advisory affects only 3.2.0 and is patched in 3.2.1; the lock uses 3.4.0.
- A complete npm advisory resolution could not be executed because the environment's configured npm audit endpoint returned HTTP 503. The entire transitive dependency graph therefore requires a successful `npm ci` and `npm audit` in network-enabled CI before release.

## Validation results

| Check | Result |
| --- | --- |
| Focused trust-proxy regression | 2 passed, 0 failed |
| Dependency-free existing security/unit tests | 29 passed, 0 failed |
| All JavaScript/MJS syntax checks | Passed |
| `npm run check` | Passed |
| Fixed PoC | `patchedConfiguration.blocked=true` |
| Working-tree high-confidence secret scan | No matches |
| Git blob high-confidence secret scan | 737 blobs, no matches |
| Disposable-copy `git fsck --full` | Passed |
| Original `.git` file content/mode comparison | 28 files, 0 differences |
| Full dependency-backed test suite | Not executed: packages could not be installed in this environment |
| `npm audit --package-lock-only --omit=dev` | Not completed: audit endpoint HTTP 503 |

The host Node.js runtime is 22.16.0, while the project declares `^22.23.0 || ^24.17.0 || ^26.3.1`. Release CI should use a declared supported runtime.

## Files changed

- `.env.example`
- `README.md`
- `package.json`
- `package-lock.json`
- `src/config.js`
- `test/security-hardening.test.js`
- `test/trust-proxy-hop-count-confidentiality.test.js`
- `security-poc/trust-proxy-hop-count-https-bypass.mjs`
- `docs/security/evidence/2026-07-24-trust-proxy-hop-count-baseline.json`
- `docs/security/reports/2026-07-24-trust-proxy-hop-count-confidentiality-hardening.md`
- `docs/security/reports/2026-07-24-confidentiality-audit.md`

No `.git` path was edited, removed, regenerated, staged, refreshed, or used as a source of patched files.

## Residual operational risks

- The final trusted proxy must overwrite `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`; network policy must prevent bypass paths to the app listener.
- Uploaded content is not malware-scanned. High-risk environments should quarantine and scan uploads and isolate preview processing at the OS/container boundary.
- File contents and SQLite data are not application-level encrypted at rest. Use encrypted volumes and encrypted/protected backups when host or storage-admin compromise is in scope.
- Run the complete test suite and npm audit after installing the lockfile on a supported Node.js runtime in network-enabled CI.
