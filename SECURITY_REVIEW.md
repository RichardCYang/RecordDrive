# Security Review

Review date: 2026-07-12

## Scope

This review covered the supplied Node.js application, Express middleware order, authentication and MFA state transitions, session storage, CSRF enforcement, repository authorization, multipart upload streaming, file download and deletion paths, XLSX and ZIP preview processing, SQLite use, TLS and reverse-proxy behavior, dependency metadata, automated tests, deployment files, and the retained Git metadata in `.git`.

The supplied project already contained substantial security hardening. This review preserved those controls and focused on remaining high-impact failure modes that could expose credentials, destroy service data, bypass path policy through filesystem aliases, or grant excessive destructive authorization.

## Remediated findings

### High: Production accepted application requests over plaintext HTTP

Production session cookies were marked `Secure`, but the application still rendered the login page and parsed authentication requests over plaintext HTTP. A deployment with native HTTPS disabled, a missing redirect, or an incorrectly configured reverse proxy could therefore transmit passwords, TOTP codes, recovery keys, CSRF tokens, and uploaded data without transport encryption even though the resulting session cookie might not persist.

Production now rejects every request that Express does not recognize as HTTPS with HTTP 426 and an English plain-text response. The guard runs after security headers but before static serving, body parsers, language processing, sessions, CSRF, and authentication. Native HTTP-to-HTTPS redirection continues to work at the network-listener layer when enabled. Reverse-proxy deployments must configure a constrained `TRUST_PROXY` value and must not expose the trusted application listener directly.

### High: A database path inside the upload root could be deleted with a repository

The previous storage validation did not reject `DB_PATH` inside `UPLOAD_ROOT`. For example, a database configured as `<upload-root>/1/recorddrive.db` could be recursively removed when repository `1` was deleted. The same configuration could also place SQLite journal files inside repository-managed storage.

Startup now rejects any database path that is equal to or below the upload root. The validation is used by both application creation and direct database creation, so callers cannot bypass it by invoking the database module separately.

### High: Symbolic-link ancestors bypassed protected storage-path checks

Storage paths were compared lexically. A path such as `/temporary/project-link/public/uploads`, where `project-link` resolved to the application directory, could pass the original check even though the effective location was inside the public static directory. The same pattern could target source, views, Git metadata, or other protected paths.

Storage paths are now resolved through the nearest existing filesystem ancestor before policy checks. Final symbolic-link components remain forbidden. After directories are created, their real paths must match the validated canonical paths, and the upload root and repository directories are rechecked during file operations. This closes the ancestor-alias bypass while retaining support for paths whose final components do not exist at startup.

### High: Shared file-delete permission also allowed repository deletion

A shared user granted the `Delete` capability could delete individual files and also permanently delete the entire repository. This combined a routine content-management permission with an ownership-level destructive action and violated least privilege.

The `Delete` grant now applies only to stored files. Repository deletion requires repository-manager access, which is limited to the repository owner and enabled administrators. The repository page no longer displays the repository-delete control to a shared user, and the server independently rejects direct deletion requests with the same non-enumerating not-found behavior used by other unauthorized repository operations.

### Low: JSON responses did not enable Express character escaping

Express JSON character escaping was not enabled. Current JSON responses are consumed as JSON rather than embedded as executable HTML, but enabling escaping provides an additional defense against unsafe future embedding of user-controlled values.

The application now enables Express `json escape`, causing `<`, `>`, and `&` to be emitted as Unicode escape sequences in JSON responses.

### Medium: Audit records could grow without a retention boundary

Every successful security-sensitive action appended a row to `activity_logs`, but no maximum or retention mechanism existed. An authenticated user able to perform repeatable repository operations could grow the SQLite database indefinitely, eventually exhausting the database volume and disrupting availability. This is mapped to CWE-770, Allocation of Resources Without Limits or Throttling. No CVE identifier has been assigned to this private application-specific finding.

The application now retains a configurable maximum number of recent audit records through `MAX_ACTIVITY_LOG_ENTRIES` (default `100000`). Existing oversized databases are reduced at startup, and runtime inserts prune the oldest records in bounded batches while preserving the newest records.

## Previously hardened controls verified

The retained code already provided the following material protections:

- Anonymous login CSRF tokens do not create server-side sessions, and active authentication sessions are bounded per account.
- Password, TOTP, recovery-code, and WebAuthn flows use rate limiting, session regeneration, bounded input, and explicit state transitions.
- Session cookies use a non-default name, `HttpOnly`, `SameSite=Strict`, high priority, production `Secure`, rolling idle expiration, and a server-enforced absolute lifetime.
- Repository permissions are checked independently on every operation, and unauthorized repository access returns a generic not-found response.
- Multipart CSRF validation occurs before destination files are opened. Upload storage enforces per-file, per-request, repository, and service limits while streaming, removes partial files, and uses random exclusive names with owner-only permissions.
- Stored file names and repository identifiers are validated. File opens use `O_NOFOLLOW` where available and verify regular files with `fstat`.
- Database files, upload directories, repository directories, and uploaded files receive owner-only modes where supported.
- XLSX and ZIP previews enforce compressed-size, expansion, entry-count, metadata, output-text, and concurrency limits.
- TOTP secrets, saved TLS passphrases, and temporary recovery-code display bundles use authenticated encryption.
- Saved TLS settings fail closed when parsing or decryption fails.
- Production secrets, bootstrap credentials, proxy trust, WebAuthn origin, and supported Node.js runtime floors receive explicit validation.
- Helmet, a restrictive Content Security Policy, disabled `X-Powered-By`, safe internal redirects, bounded body parsers, CSRF checks, and non-cacheable authenticated responses are enabled.

## Dependency and supply-chain review

`npm ci --ignore-scripts` completed successfully. `npm audit --omit=dev --json` reported zero known vulnerabilities across 247 production dependencies and 266 total installed dependencies at review time.

Multer is pinned to 2.2.0, which contains the fix for malformed or incomplete multipart requests leaving orphaned files. The package engine floor is Node.js 22.23.0, 24.17.0, or 26.3.1 within those release lines, matching the security-patched runtime floors declared by the project. The Docker image uses Node.js 24.18.0.

The available analysis runtime was Node.js 22.16.0, which is below the declared production floor. All tests passed there, but deployment must use a supported patched runtime such as the provided Docker image or a version satisfying `package.json`.

The retained Git history was scanned for common private-key blocks, cloud credentials, GitHub tokens, OpenAI-style keys, and long secret assignments. Only documented sample values were found. Because `.git` intentionally remains in the deliverable, the archive must still be treated as source history and stored only in a trusted location.

## Validation performed

- All 32 Node.js integration and regression tests pass.
- New regression coverage verifies plaintext production rejection before static and authentication processing, secure cookies behind an explicitly trusted HTTPS proxy, canonical storage-path enforcement, protected-directory alias rejection, database/upload-root separation, file-only delegated deletion, and owner-only repository deletion.
- Every JavaScript source and test file passes `node --check`.
- Production dependency audit reports zero known vulnerabilities.
- Static searches found no child-process execution, shell command construction, dynamic code evaluation, or server-side URL-fetch functionality.
- SQL fragments built dynamically are limited to application-controlled allowlisted clauses; user data remains bound through SQLite parameters.
- Unescaped EJS output is limited to intentional partial includes; user-controlled values use escaped output or safe DOM text assignment.
- Git integrity and archive integrity are checked before packaging, and `.git` is retained.

## Residual operational risks

Uploaded files are not malware-scanned. Internet-facing deployments should quarantine and scan uploads before download and should run complex document preview processing in isolated workers with CPU, memory, file, and wall-clock limits.

Rate-limit state and in-flight upload reservations are process-local. Multi-instance deployments require shared rate limiting, coordinated quotas, shared sessions, a networked database, and shared object storage. Filesystem or volume quotas remain necessary for database growth, logs, backups, temporary files, and out-of-band writes.

A reverse proxy must strip untrusted forwarding headers, set the authoritative protocol header, and be the only network path to an application listener configured with `TRUST_PROXY`. A hop-count configuration is unsafe when clients can reach the application directly through a shorter path.

Storage-path checks materially reduce accidental exposure and destructive overlap, but they do not replace host permissions. An attacker who can rename validated parent directories or alter mount topology as the service account can still create filesystem time-of-check/time-of-use conditions. Keep the application directory, database parent, and upload parent non-writable by untrusted users.

Audit logs now have a bounded built-in retention policy, but operators that require longer forensic history should export records before they age out. Large repository, user, or administrative listings can still increase response and database work. Add pagination, request timeouts, reverse-proxy body limits, monitoring, backup testing, and recovery procedures for production deployments.

Protect the database, upload volume, encryption keys, certificates, environment files, backups, and retained Git history with strict operating-system access controls. Do not publish the final archive to an untrusted location because Git history can retain deleted source and operational metadata.
