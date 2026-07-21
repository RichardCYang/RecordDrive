# RecordDrive Confidentiality Security Review — Final Hardening Pass

- Review date: 2026-07-21 (KST)
- Source archive: `RecordDrive.zip`
- Source SHA-256: `a2143389d7a76af46a463422cd495d6e4a885e0b520104574f5a5a2b2f576364`
- Scope: deployment defaults, transport confidentiality, authentication and sessions, secret handling, template exposure, repository authorization, stored-file access, uploads and previews, parser isolation, dependency advisories, and Git-history secret scanning
- Result: **One High-severity confidentiality weakness and one Medium-severity secret-exposure weakness were confirmed and remediated. One release-integrity defect affecting the hardened 7z preview dependency was also corrected. No unresolved Critical-severity confidentiality vulnerability was confirmed in the reviewed source.**

This report supplements the 2026-07-20 confidentiality review and the 2026-07-21 pure-JavaScript 7z parser review already present in this directory.

## 1. Methodology

1. Validated the uploaded ZIP structure, extracted it into an isolated review directory, and confirmed that the repository contained a `.git` directory.
2. Preserved a byte-level SHA-256 manifest for every file under `.git` before making source changes.
3. Traced the Express middleware order, login/MFA/session lifecycle, administrator routes, repository permission checks, download and preview authorization, upload handling, storage path validation, TLS settings, and Docker deployment path.
4. Searched the source for external command execution, unsafe template output, secret-bearing template locals, environment propagation, dynamic SQL interpolation, filesystem traversal and symbolic-link handling, sensitive logging, and high-confidence credential patterns.
5. Scanned the working tree and every Git blob object for private keys and high-confidence AWS, GitHub, Slack, and Google credential formats.
6. Checked current official Docker, Express/OWASP guidance, current package advisories, and the installed production dependency graph.
7. Added regression tests for each source-level remediation and ran the complete validation suite.

## 2. Confirmed and remediated findings

### RD-C-2026-05 — Development and known-secret settings could override the production image while the service was published on every host interface

- Severity: **High**
- Confidentiality impact: Credentials and authenticated session identifiers could be sent over plaintext HTTP, and an administrator account could be initialized with a publicly documented password if an operator followed the example deployment flow without replacing every relevant value.
- Root cause:
  - The Docker image declared `NODE_ENV=production`, but `docker-compose.yml` loaded `.env` without an explicit production override.
  - The supplied `.env.example` set `NODE_ENV=development`, disabled HTTPS, used a known session-secret placeholder, and used `ChangeMe123!` as the administrator password.
  - Compose published both application ports on all host interfaces.
  - In development mode, production-only TLS and secret validation did not run.
- Attack scenario:
  1. An operator copies `.env.example` to `.env` as documented and runs Docker Compose.
  2. The Compose environment overrides the image's production mode.
  3. The HTTP listener is published beyond the local machine.
  4. A network attacker can attempt the documented administrator password or observe credentials/session traffic on an unencrypted path.
- Remediation:
  - Docker Compose now explicitly sets `NODE_ENV=production` and the in-container listener addresses.
  - Host port publishing is restricted to `127.0.0.1` by default.
  - Development/test listener defaults now bind to loopback rather than every interface.
  - A new runtime confidentiality policy treats any non-loopback listener as externally reachable regardless of `NODE_ENV`.
  - External listeners fail before database initialization when the session secret, administrator password, or MFA key source is weak/default.
  - Production or external listeners reject every request not recognized as HTTPS before static serving, request-body parsing, sessions, or authentication.
  - Session cookies are `Secure` whenever HTTPS is required.
  - Saving administrator-managed TLS settings now applies the same external-listener policy before persistence.
- Regression coverage:
  - Loopback defaults are asserted.
  - Weak external settings are rejected before the database is created.
  - Strong external settings return HTTP 426 to plaintext requests without setting cookies.
  - A trusted proxied HTTPS request is accepted.

### RD-C-2026-06 — Secret-bearing runtime objects were stored in Express template locals

- Severity: **Medium**
- Confidentiality impact: A future template, error page, debugging helper, or third-party view integration could accidentally expose the complete configuration object, including the session secret, administrator bootstrap password, MFA encryption key source, and TLS passphrase, as well as direct database/runtime handles.
- Root cause:
  - `app.locals` contained `db`, `config`, `runtimeControl`, and `networkSettings`.
  - Express makes application locals available to rendered templates.
- Remediation:
  - Sensitive runtime objects were moved to a non-enumerable, immutable `app.recorddrive` namespace that is not part of template locals.
  - Middleware and server lifecycle code were updated to use `app.recorddrive`.
  - Templates now receive only specific non-secret values needed for rendering, such as the database path on the administrator storage page and the administrator-access-disabled flag in navigation.
- Regression coverage:
  - Tests assert that the sensitive objects are absent from `app.locals` and remain available only through `app.recorddrive`.

### RD-BUILD-2026-02 — The committed local `xz-compat` fork declared compiled exports that were missing from the archive

- Severity: **Medium (release integrity/availability; not a direct confidentiality finding)**
- Impact: Fresh installs and Docker builds could not load the pure-JavaScript decoder used by 7z metadata preview, causing preview failures and preventing the prior native-parser removal from being reliably reproduced from the archive.
- Root cause:
  - The local package exported files from `dist/`, but the root `.gitignore` excluded every `dist` directory and the compiled files were absent from the supplied archive.
- Remediation:
  - Added the official `xz-compat` 1.2.7 JavaScript distribution files required by the local fork.
  - Replaced both ESM and CommonJS native loaders with hard no-op implementations.
  - Omitted source maps and retained no runtime native installer or external executable path.
  - Added narrow `.gitignore` exceptions only for `vendor/xz-compat-purejs/dist/**`.
- Regression coverage:
  - 7z preview tests verify parsing behavior and the absence of child-process/native-WASM execution paths.

## 3. Reviewed areas with no additional confirmed severe confidentiality defect

- Repository routes revalidate view, upload, download, delete, and management permissions; file preview/download lookups are scoped to the authorized repository.
- Stored files use randomized storage names outside the public web root.
- Storage-root and database-path validation rejects unsafe overlap, path traversal, and symbolic-link substitution; file opening uses no-follow protections where supported.
- Login and MFA completion rotate sessions, server-side sessions have idle and absolute limits, and sensitive security changes invalidate other sessions as documented in the earlier review.
- CSRF verification covers URL-encoded, JSON, and streaming multipart upload requests.
- TOTP secrets and stored TLS passphrases use authenticated encryption; recovery codes are stored as hashes.
- EJS templates contain no unescaped user-data output (`<%- ... %>` was not found).
- Dynamic SQL interpolation found during the review is restricted to constant query fragments, generated placeholder counts, or fixed sort whitelists; user values remain bound parameters.
- Application runtime code contains no child-process execution path for file previews.
- No high-confidence credential or private-key pattern was found in the working tree or Git blob history.

## 4. Validation results

- `npm run check`: **passed**
- Complete Node test suite: **62/62 passed, 0 failed**
- Dedicated security-hardening tests: **22/22 passed**
- Preview/parser tests: **10/10 passed**
- `npm audit --omit=dev`: **0 known vulnerabilities** across 280 production dependencies
- Full dependency graph reported by npm: 299 packages, 0 known vulnerabilities
- Secret scan: **0 high-confidence findings** in the working tree and **0 high-confidence findings** across Git blob objects
- Original repository integrity: `git fsck --full --no-reflogs` completed without an integrity error before remediation
- Test runtime: Node.js `v22.16.0`, npm `10.9.2`

The tested Node.js runtime is below the project's declared minimum patch version. All checks passed, but deployment should use a version within the declared engine range or the Docker image version configured by the project.

## 5. `.git` preservation

The final package was produced by copying the original ZIP and overlaying only changed or newly added non-`.git` files. The original `.git` entries were not deleted, regenerated, or replaced. Final validation compares every `.git` path and file byte against the uploaded archive.

## 6. Main files changed

- `.env.example`
- `.gitignore`
- `docker-compose.yml`
- `README.md`
- `src/app.js`
- `src/config.js`
- `src/tls-settings.js`
- `src/network-server.js`
- `src/server.js`
- `src/middleware/auth.js`
- `src/middleware/csrf.js`
- `src/routes/admin.js`
- `views/admin-storage.ejs`
- `views/partials/nav.ejs`
- affected tests under `test/`
- `vendor/xz-compat-purejs/dist/**`

## 7. Residual risks and operational requirements

- Native HTTPS was not exercised with a real production certificate, and no live reverse-proxy deployment was available for dynamic penetration testing. Validate the final deployment with its actual certificate chain, proxy trust boundary, and forwarded-protocol behavior.
- Uploaded files are not malware-scanned. Encrypted archives and malformed documents can remain opaque to application-level validation; use a separate scanning/quarantine service when required by the environment.
- Confidentiality of the SQLite database, upload volume, backups, environment file, and TLS key material still depends on host/container filesystem permissions and backup access controls.
- Binding RecordDrive directly to a public interface is intentionally fail-closed unless strong secrets are configured and requests are recognized as HTTPS. Keep the default loopback publication and place a correctly configured TLS reverse proxy in front, or enable native HTTPS.
- Dependency advisories can change after this review date; continue automated lockfile auditing and timely upgrades.

## 8. External references consulted

- Docker documentation: Compose environment-variable precedence and service `environment` versus `env_file` behavior
- OWASP Authentication Cheat Sheet: login and authenticated pages must use TLS
- OWASP Session Management Cheat Sheet: use TLS for the entire session and set the `Secure` cookie attribute
- Express API documentation: application locals are available to application templates
- Current npm/GitHub advisories relevant to the installed upload and archive-processing packages
