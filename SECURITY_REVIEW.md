# Security Review

Review date: 2026-07-12

## Scope

This review covered the Node.js application source, route and middleware ordering, authentication and MFA flows, multipart uploads, file download and preview behavior, SQLite persistence, TLS configuration, deployment files, dependency metadata, and the repository history retained in `.git`.

## Remediated findings

### High: Unauthenticated session-store exhaustion

The login CSRF middleware previously wrote a token into every new Express session. Protected anonymous GET requests also stored a return path in the session. Because either write initialized the session, unauthenticated requests to `/login`, `/health`, missing pages, and protected routes could continuously insert rows into SQLite despite `saveUninitialized: false`. An attacker could therefore consume database space and disk capacity without credentials.

The login page now uses a short-lived, HMAC-signed, HttpOnly, SameSite=Strict double-submit CSRF cookie that does not create a server-side session. Protected GET requests carry a sanitized internal return path in the login query and hidden form field instead of the session. Server-side sessions are created only for authenticated or pending-MFA state, and each account is limited to a configurable number of active sessions. Regression tests verify that repeated anonymous requests leave the session table empty and that older authenticated sessions are pruned.

### High: Multipart CSRF bypass

The global CSRF middleware previously skipped every `multipart/form-data` request. Only the upload route performed a later token check, so an attacker could submit multipart requests to unrelated state-changing endpoints and bypass CSRF validation.

The exception is restricted to the exact repository upload route. Every other multipart state-changing request is rejected, and the upload route validates its token after Multer parses the form field.

### High: Authentication and MFA rate-limit reset

Login attempts were counted before credential verification and the entire IP bucket was cleared after any successful password. MFA failures were stored only in the session, allowing a newly created password-authenticated session to reset the MFA counter.

The replacement limiter records failures only, tracks independent IP and account or user buckets outside the session, bounds in-memory key growth, and preserves MFA failures across session regeneration. Successful authentication clears only the relevant account or user bucket.

### High: Spreadsheet and ZIP preview resource exhaustion

Spreadsheet preview limits previously covered only compressed file size. A small XLSX archive could expand into much larger XML parts, and repeated shared strings could amplify the JSON response. ZIP previews also scanned every central-directory entry even though only a subset was displayed.

XLSX files now receive archive metadata preflight checks for entry count, total expansion, individual entry size, and entry-name length. Cell text, aggregate response text, visible merge metadata, compressed input size, and concurrent parsing are bounded. ZIP previews now cap compressed size, scanned entries, visible entries, individual names, aggregate visible-name bytes, and concurrent parsing. Preview admission occurs before the file is read into memory.

### High: Persistent storage exhaustion

An authorized uploader could repeatedly fill the storage volume because only per-request file size and file count were limited.

Repository and service-wide byte and file-count quotas are now configurable and enforced inside an immediate SQLite transaction. File-count limits prevent zero-byte or tiny-file floods from exhausting filesystem inodes and SQLite rows while remaining below byte quotas. Rejected uploads are removed from disk and are not inserted into the database. Operating-system or volume quotas remain recommended for defense in depth.

### Medium: Multipart field nesting and parser limits

The project used a patched Multer release but left field nesting effectively unbounded. Additional multipart metadata limits were also broader than the upload form required.

The upload form now permits one non-file field, disables nested field names, bounds field name and value sizes, limits header pairs, and sets the exact part count required by the configured file limit.

### Medium: Stored-file race and symbolic-link handling

Path validation used a check followed by a later path-based read, leaving a time-of-check/time-of-use window. Upload and database paths could also be redirected through pre-existing symbolic links in a modified data volume.

Stored files are now opened with `O_NOFOLLOW` where supported, verified as regular files with `fstat`, and streamed or previewed through the same file descriptor. Upload roots, repository directories, repository deletion paths, database directories, and database files reject symbolic links. Owner-only permissions are reapplied where the platform supports POSIX modes.

### Medium: Plaintext secondary secrets in SQLite

TLS private-key or PFX passphrases were stored as plaintext application settings. Newly generated recovery codes were also temporarily stored as plaintext in the server-side session database until displayed.

Both values now use purpose-bound AES-256-GCM protection derived from the configured MFA encryption key source. Existing plaintext TLS settings remain readable and are migrated to encrypted storage on the next save.

### Medium: Production configuration bypass and weak bootstrap credentials

Only `NODE_ENV=production` activated strict validation, so staging or misspelled deployment environments could start with development defaults. Bootstrap administrator passwords were checked for the sample value and bcrypt truncation but not for minimum strength.

Every environment other than `development` and `test` now receives production validation. Session secrets must contain at least 32 UTF-8 bytes, enabled bootstrap administrator passwords must contain 12 to 128 characters and stay within bcrypt's 72-byte input limit, and a separately configured MFA encryption key must contain at least 32 UTF-8 bytes.

### Medium: Outdated vulnerable runtime floor

The previous engine floor allowed Node.js 22.16.0, which predates the June 2026 security releases. The Docker base also used a mutable major-version tag.

The supported engine ranges now begin at Node.js 22.23.0, 24.17.0, and 26.3.1. The Docker image is pinned to Node.js 24.18.0 Alpine, installs production dependencies with lifecycle scripts disabled, and runs as the unprivileged `node` user.

### Medium: Authentication response and filesystem hardening

Unknown-user password checks perform a dummy bcrypt comparison to reduce username timing differences. Login password input is byte-bounded before bcrypt processing, internal post-login redirects reject network-path references, backslashes, and control characters, authenticated responses are non-cacheable, session cookies use strict settings, database and uploaded files use owner-only modes, and partial Multer uploads are removed on error.

## Dependency and history review

`npm ci --ignore-scripts` completed successfully. `npm audit --json` reported zero known vulnerabilities in the installed production and development dependency graph at review time. Helmet was updated to 8.3.0, and Multer remains at the patched 2.2.0 release.

The retained Git history was scanned for common private-key, cloud-key, GitHub-token, OpenAI-key, and long secret assignment patterns. Only documented sample values were found. The `.git` directory and all refs remain present.

## Validation

The test suite contains 25 passing integration and regression tests. Added coverage includes anonymous session-store exhaustion, per-account session pruning, nested multipart rejection, byte and file-count quota cleanup, production-mode secret validation, symbolic-link storage rejection, encrypted TLS passphrase storage, encrypted temporary recovery-code bundles, and XLSX response text limits. Syntax checks, dependency installation, dependency audit, Git whitespace checks, and archive integrity checks are also part of the final validation.

## Residual operational risks

Uploaded files are not malware-scanned. High-exposure deployments should add quarantine and scanning before files become downloadable, and should move complex document preview generation to a sandboxed worker with CPU, memory, and wall-clock limits. Rate-limit state is process-local, so multi-instance deployments require a shared limiter. Database-tracked byte and file-count quotas do not replace filesystem quotas and cannot account for unrelated files or an out-of-band modified volume. Protect the SQLite database, upload volume, encryption keys, certificates, backups, and the retained Git history with strict host-level access controls.
