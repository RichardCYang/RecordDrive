# Security Review

Review date: 2026-07-12

## Scope

This review covered the Node.js application source, route and middleware ordering, authentication and MFA flows, file upload/download/preview behavior, SQLite persistence, deployment files, dependency lockfile, and the repository history included in `.git`.

## Remediated findings

### High: Multipart CSRF bypass

The global CSRF middleware previously skipped every `multipart/form-data` request. Only the upload route performed a later token check, so an attacker could submit multipart requests to unrelated state-changing endpoints and bypass CSRF validation.

The exception is now restricted to the exact repository upload route. Every other multipart state-changing request is rejected, and the upload route continues to validate its token after Multer parses the form fields.

### High: Authentication and MFA rate-limit reset

Login attempts were counted before credential verification and the entire IP bucket was cleared after any successful password. MFA failures were stored only in the session, allowing a new password-authenticated session to reset the MFA counter.

The replacement limiter records failures only, tracks independent IP and account/user buckets outside the session, bounds in-memory key growth, and preserves MFA failures across session regeneration. Successful authentication clears only the relevant account or user bucket, not unrelated IP failures.

### High: Spreadsheet and ZIP preview resource exhaustion

Spreadsheet preview limits previously covered only compressed file size. A small XLSX archive could expand into a much larger set of XML parts before ExcelJS parsed it. ZIP previews also scanned every central-directory entry even though only a subset was displayed.

XLSX files now receive a ZIP metadata preflight with entry-count, total-uncompressed-size, single-entry-size, and entry-name limits before parsing. In-memory workbook caching was removed, and concurrent preview parsing is capped. ZIP previews now reject archives with excessive entry counts or oversized entry names before unbounded scanning.

### Medium: Implicit reverse-proxy trust

Production mode automatically trusted one proxy hop. A deployment that was directly reachable or had a different path length could accept spoofed forwarded client IP or protocol headers, affecting rate limits and secure-request detection.

Proxy trust is now disabled by default and can be enabled only through the explicit `TRUST_PROXY` setting. Universal trust is rejected; deployments must provide a positive hop count or trusted addresses/subnets.

### Medium: Stored-file path and symbolic-link hardening

Stored filenames are now restricted to a single path component with a bounded byte length. Repository directories and stored files are rejected when they are symbolic links, reducing the risk of filesystem redirection through a modified data volume or database.

### Medium: Filesystem permission hardening

Database directories and upload roots are restricted to owner-only access where the platform supports POSIX modes. SQLite files and uploaded files are set to mode `0600`, repository directories to `0700`, and the Docker image now runs as the unprivileged `node` user.

### Medium: Authentication response hardening

Unknown-user password checks now perform a dummy bcrypt comparison to reduce username timing differences. Login password input is byte-bounded before bcrypt processing, and newly configured bootstrap or regular-user passwords cannot exceed bcrypt's 72-byte UTF-8 input limit. Internal post-login redirects reject network-path references, backslashes, and control characters. Authenticated responses are marked private and non-cacheable, and session cookies receive high priority.

### Medium: Partial-upload cleanup

Multer errors can occur after one or more files have already been written. The upload wrapper now removes partial files before forwarding an error, reducing orphan-file accumulation.

## Dependency review

`npm ci --ignore-scripts` completed successfully. `npm audit --json` reported zero known vulnerabilities in the installed production and development dependency graph at review time.

## Validation

The project includes regression coverage for multipart CSRF rejection, persistent MFA failure limits, redirect sanitization, proxy-trust parsing, strict stored-file paths, archive preview limits, file permissions, and the existing authentication, repository permission, TLS, preview, and access-time flows.

## Residual operational risks

Uploaded files are not malware-scanned. For deployments that accept files from partially trusted users, add an isolated scanning service and quarantine workflow before making files downloadable. Complex document preview remains a resource-sensitive operation; high-exposure deployments should move preview generation to a sandboxed worker with CPU, memory, and wall-clock limits. Keep the application and lockfile updated, protect the SQLite and upload volume, use HTTPS, and configure `TRUST_PROXY` only for a verified proxy topology.
