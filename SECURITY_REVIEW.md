# Security Review

Review date: 2026-07-12

## Scope

This review covered the Node.js application source, middleware order, authentication and MFA flows, session persistence, multipart parsing, upload and download paths, preview processing, SQLite access, TLS configuration, deployment files, dependency metadata, automated tests, and the complete Git metadata retained in `.git`.

The supplied working tree already contained extensive security hardening. Those controls were retained, and the current review concentrated on remaining fail-open behavior, resource exhaustion before validation, dangerous deployment-path configurations, and session lifetime controls.

## Remediated findings in this review

### High: Upload bytes reached disk before CSRF and quota enforcement

The previous Multer `diskStorage` flow opened and wrote uploaded files before the route could validate the multipart CSRF field. Repository and service storage quotas were also checked only after all request files had been written. An authenticated uploader with little remaining quota, or a forged multipart request, could therefore consume substantial temporary disk space before rejection. Repeated or concurrent requests could pressure the filesystem even when database-tracked quotas eventually rejected every upload.

A custom quota-aware Multer storage engine now validates the CSRF token before opening a destination file. Browser forms send the hidden token before file parts, and non-browser clients can send `X-CSRF-Token`. The storage engine reserves file-count capacity, accounts for bytes on every streamed chunk, stops the stream as soon as a repository, service, or per-file limit would be exceeded, removes partial files, and releases reservations on every error path. Files are created with random names, exclusive creation, owner-only mode, and `O_NOFOLLOW` where available. The immediate SQLite transaction and final authoritative quota check remain in place as a second layer against races and multi-process writers.

### High: Saved TLS settings failed open to HTTP defaults

When a saved TLS row was malformed or could not be decrypted, the application logged a warning and silently returned environment defaults. A damaged database value, lost encryption key, or incorrect key rotation could therefore disable previously configured HTTPS and allow the service to restart with an unintended transport configuration.

Saved TLS settings now fail closed. Parsing or authenticated-decryption failure stops application startup with a generic English error that does not expose secret material. Valid saved passphrases remain encrypted with purpose-bound AES-256-GCM protection.

### High: Storage paths could expose data or change broad filesystem permissions

`DB_PATH` and `UPLOAD_ROOT` were configurable absolute paths. A dangerous value could place the SQLite database or uploaded files under the static public directory, inside source or Git metadata, at a filesystem root, or at a parent of the project. Startup permission hardening could then make broad `chmod` changes, while static serving could disclose databases or uploaded content.

Startup now rejects filesystem roots, the project root and its parents, and paths inside `public`, `src`, `views`, or `.git`. Validation runs before database or upload directory creation and before permission changes.

### Medium: Production session cookies could be emitted without `Secure`

The session cookie previously used Express Session's automatic transport mode in every environment. A production instance reached over plain HTTP could issue an authentication cookie without the `Secure` attribute.

Production cookies now always use `Secure`, while development and test retain automatic behavior. Native HTTPS or an explicitly trusted HTTPS reverse proxy is therefore required for production authentication. Existing `HttpOnly`, `SameSite=Strict`, high-priority, non-default cookie-name, and server-side storage protections remain enabled.

### Medium: Rolling sessions had no absolute lifetime

The session cookie used a rolling 12-hour idle lifetime. Continuous activity could keep a stolen session valid indefinitely.

`SESSION_IDLE_HOURS` now controls the rolling idle lifetime and `SESSION_ABSOLUTE_HOURS` controls a server-enforced maximum lifetime regardless of activity. Authentication and pending-MFA session creation timestamps are persisted, legacy sessions are migrated from existing trusted timestamps, and expired sessions are regenerated or rejected before authorization and CSRF middleware continue.

### Medium: Security-password confirmation accepted unbounded bcrypt input

The main login route bounded password bytes before bcrypt, but the password-confirmation route used for security settings did not. Large form values could cause avoidable allocation and hashing work.

Security-password confirmation now rejects inputs over 1,024 UTF-8 bytes before bcrypt comparison while preserving the existing attempt limiter.

## Previously hardened controls verified

The retained code already provided the following material protections:

- Anonymous login CSRF tokens do not create server-side sessions, and per-account session counts are bounded.
- Password login, TOTP, recovery-code, and WebAuthn flows have independent rate limiting and session regeneration.
- Repository authorization is checked per operation, with not-found responses used to reduce repository enumeration.
- Stored names are generated by the application, original names are normalized, and stored files are opened through validated repository paths and file descriptors.
- Symbolic-link database, upload-root, repository-directory, and stored-file paths are rejected; regular-file checks use `fstat`.
- Database files, upload directories, and uploaded files receive owner-only permissions where supported.
- Spreadsheet and ZIP previews have compressed-size, expansion, entry, text, metadata, and concurrency limits.
- TLS passphrases, TOTP secrets, and temporary recovery-code displays use authenticated encryption.
- Production secrets, bootstrap credentials, proxy trust, WebAuthn origin, and runtime floors receive explicit validation.
- Helmet, a restrictive Content Security Policy, custom error pages, disabled `X-Powered-By`, strict CSRF checks, safe internal redirects, and non-cacheable authenticated responses are enabled.

## Dependency and history review

`npm ci --ignore-scripts` completed successfully. `npm audit --json` reported zero known vulnerabilities in the installed production and development dependency graph at review time, and `npm outdated --json` reported no available direct dependency updates under the declared ranges.

Multer is pinned at 2.2.0, which is newer than the 2.1.1 patched release for the March 2026 uncontrolled-recursion denial-of-service advisory. Deprecated transitive packages remain under ExcelJS's archive dependencies, but they did not produce a known-vulnerability finding in the audit. They should still be removed when ExcelJS publishes a compatible dependency refresh.

The retained Git history was scanned for common private-key, cloud-key, GitHub-token, OpenAI-key, and long secret-assignment patterns. Only documented sample values were found. The `.git` directory, refs, objects, logs, configuration, and current uncommitted working-tree state remain present in the final archive.

## Validation

The final test suite contains 30 passing integration and regression tests. New coverage verifies pre-write upload CSRF enforcement, quota-aware multi-file streaming, quota cleanup, fail-closed TLS settings, production `Secure` session cookies, absolute session expiration, and rejection of dangerous database and upload paths.

Validation also includes syntax checking for every JavaScript file, a clean dependency installation with lifecycle scripts disabled, production and full dependency audits, direct dependency update checks, static searches for command execution and unescaped template output, Git integrity checks, archive traversal and symbolic-link checks, and final ZIP integrity verification.

## Residual operational risks

Uploaded files are not malware-scanned. High-exposure deployments should quarantine and scan content before it becomes downloadable and should move complex document preview work into sandboxed workers with CPU, memory, and wall-clock limits.

Rate-limit state and in-flight upload reservations are process-local. Multi-instance deployments require shared rate limiting, shared quota coordination, a networked database, and shared object storage. The final SQLite transaction prevents same-database quota races, but filesystem or volume quotas are still required to account for unrelated files, database growth, logs, backups, and out-of-band modifications.

Activity logs have no built-in retention policy, and large repository, user, or administrative listings can still increase response and database work within configured record limits. Add retention, pagination, request timeouts, reverse-proxy body limits, and service-level monitoring for internet-facing deployments.

Protect the SQLite database, upload volume, encryption keys, certificates, backups, environment files, and retained Git history with strict host-level access controls. A source archive that includes `.git` should not be published to an untrusted location because history can contain deleted source and operational metadata even when no secret was detected in this review.
