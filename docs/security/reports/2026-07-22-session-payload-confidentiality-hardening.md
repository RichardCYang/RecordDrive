# RecordDrive Session-Payload Confidentiality Hardening

| Field | Value |
| --- | --- |
| Review date | 2026-07-22 (KST) |
| Reviewed archive | `RecordDrive.zip` |
| Source SHA-256 | `00b26b4f79214823d99e3377afde764f90421676792f434f58aa04ad3969e83b` |
| Scope | Confidentiality of server-side sessions, secret-bearing user records, WebAuthn relying-party configuration, repository authorization, file access, uploads, previews, runtime secrets, and Git history |
| Outcome | One high-severity confidentiality issue and two defense-in-depth confidentiality issues were remediated. No unresolved Critical-severity confidentiality defect was confirmed in the reviewed source. |

This report supplements the earlier [confidentiality follow-up](2026-07-21-confidentiality-follow-up.md). The prior version protected the database session identifier with an HMAC but still stored the session payload itself as plaintext JSON.

## 1. Methodology

1. Validated the uploaded ZIP before extraction for unsafe paths, symbolic links, and abnormal compression ratios.
2. Recorded the path, metadata, CRC, and SHA-256 of every `.git` entry before modifying non-Git files.
3. Traced authentication, MFA, session creation/rotation/expiration, session invalidation, administrator-disable behavior, WebAuthn options and verification, repository permissions, downloads, previews, uploads, and storage-path enforcement.
4. Searched the working tree for secret-bearing objects, over-broad user queries, dynamic SQL, unescaped template output, dangerous DOM sinks, filesystem traversal, and unexpected command execution.
5. Scanned a separate byte-for-byte copy of the Git object database: 37 commits, 873 reachable object/path records, and 567 blob objects. No high-confidence real private key, cloud token, source-control token, API key, or JWT was found; only documented example credentials and placeholders were detected.
6. Added focused regression tests for encrypted session persistence, row-binding integrity, plaintext migration, encrypted-session invalidation, and externally reachable WebAuthn configuration.

## 2. Confirmed and remediated findings

### RD-C-2026-10 — Server-side session payloads were stored as plaintext JSON

- Severity: **High**
- Confidentiality impact:
  - `sessions.sid` was HMAC-protected, but `sessions.sess` contained readable JSON.
  - Theft or unauthorized reading of the SQLite database, WAL, or a database backup could expose CSRF tokens, authenticated user identifiers and timestamps, pending-MFA state, WebAuthn challenges, return paths, and other security workflow state.
  - TOTP secrets and one-time recovery-code displays already had separate encryption, but that did not protect the rest of the session object.
- Root cause:
  - `SQLiteSessionStore.set()` wrote `JSON.stringify(sess)` directly to SQLite.
  - Session pruning and forced-logout helpers parsed the same plaintext JSON directly.
- Remediation:
  - A purpose-separated 256-bit key is derived from `SESSION_SECRET` for session-payload encryption.
  - Every payload is encrypted using AES-256-GCM with a fresh 96-bit IV.
  - The HMAC-derived database session identifier is included as authenticated additional data, so moving a ciphertext to another session row or modifying it causes authentication failure.
  - Malformed, tampered, or key-incompatible rows are deleted and require a new login rather than being returned to the application.
  - Startup migrates valid legacy plaintext rows inside an immediate transaction, enables SQLite secure deletion for the migration, and requests a truncated WAL checkpoint afterward. Invalid legacy rows are discarded.
  - Session limits, user-session purge, administrator-session purge, touch, lookup, update, and destruction now use the same protected payload layer.
- Key-management boundary:
  - Database-only compromise no longer reveals session contents.
  - A combined compromise of both the database and the active `SESSION_SECRET` can still decrypt them; the environment, secret store, process account, and backups therefore remain part of the confidentiality boundary.

### RD-C-2026-11 — Unnecessary password and MFA fields were loaded into route and render objects

- Severity: **Medium / Defense in Depth**
- Confidentiality impact:
  - The administrator user list selected `u.*`, placing password hashes and encrypted MFA fields into objects passed to view rendering even though the template did not use them.
  - Repository permission and deletion paths also selected complete user rows when only identifiers and display fields were needed.
  - The login path selected the complete row although it required only the password hash and public account fields.
  - A future debugging helper, template change, object serialization mistake, or error instrumentation could therefore expose more secret-bearing material than necessary.
- Remediation:
  - Replaced wildcard user queries with explicit column projections.
  - Administrator lists and repository permission operations now receive only `id`, `username`, `display_name`, `role`, `created_at` where needed, and aggregate counts.
  - The login query receives only the account fields plus `password_hash`; encrypted TOTP fields are not loaded into the login route object.

### RD-C-2026-12 — Externally reachable WebAuthn could derive relying-party settings from the request Host header

- Severity: **Medium; potentially High with a permissive or misconfigured reverse proxy**
- Confidentiality/security impact:
  - Production already required explicit `WEBAUTHN_ORIGIN` and `WEBAUTHN_RP_ID`.
  - A non-production deployment treated as externally reachable by listener or proxy policy could still fall back to `req.protocol` and the request `Host` header for WebAuthn settings.
  - This created an avoidable trust dependency on proxy host-header validation during passkey registration and authentication.
- Remediation:
  - Production **and every externally reachable deployment** now require explicit `WEBAUTHN_ORIGIN` and `WEBAUTHN_RP_ID` before passkey operations are available.
  - Loopback-only development retains the convenient localhost derivation behavior.

## 3. Security controls reviewed without another confirmed severe defect

- Repository view, upload, download, delete, and management permissions are rechecked server-side; file lookup remains scoped to the authorized repository.
- Uploaded files remain outside the public web root, use random stored names, owner-only file permissions, exclusive creation, and no-follow checks where supported.
- Multipart CSRF verification occurs before file creation, and Multer 2.2.0 is configured with bounded fields, parts, headers, files, file size, and `fieldNestingDepth: 0`.
- Authenticated responses use `Cache-Control: private, no-store`; session cookies are HttpOnly and SameSite=Strict and become Secure whenever HTTPS is required.
- Unexpected detailed error responses remain limited to loopback-only non-production use.
- TOTP secrets and saved TLS passphrases use authenticated encryption; recovery codes are stored as keyed hashes and temporary displays are encrypted in the now-encrypted server-side session.
- Dynamic EJS output uses escaped tags; raw output is limited to fixed template includes. Browser scripts use safe text-setting APIs rather than `innerHTML` for preview metadata.
- File-preview code contains no application-runtime child-process execution path.

## 4. Validation performed

| Check | Result |
| --- | --- |
| JavaScript syntax check for every project `.js` file | Passed |
| New focused confidentiality tests | 5/5 passed |
| Session ciphertext contains tested CSRF/WebAuthn plaintext markers | No |
| Ciphertext copied to another session identifier | Rejected and row deleted |
| Legacy plaintext session migration | Passed |
| Encrypted administrator/user session purge | Passed |
| External WebAuthn without explicit origin/RP ID | Rejected |
| Wildcard `SELECT * FROM users` in reviewed user-facing routes | Absent |
| Git object integrity on isolated copy | `git fsck --full --no-reflogs` passed |
| Git-history high-confidence secret scan | 567 blobs; no real key/token/private-key finding |
| Original working `.git` pre/post file SHA-256 comparison | Identical before packaging |

The package registry and npm audit endpoint were unavailable from the review environment, so a fresh full dependency installation and complete upstream test suite could not be rerun. The five focused tests executed the actual session cryptography, SQLite migration/purge logic, WebAuthn configuration resolver, and source assertions; temporary minimal ESM stubs supplied only the unavailable `express-session` Store base class and unused `otplib` exports, and were removed immediately after testing. The supplied lockfile and source were reviewed statically. Current advisory research confirmed that the included Multer `2.2.0` is the patched release for the June 2026 aborted-upload cleanup and deeply nested multipart field-name advisories; the project also already sets `fieldNestingDepth: 0`. This does not replace continuous automated dependency monitoring.

The local runtime was Node.js `v22.16.0`, below the project's declared minimum patch level of `^22.23.0`. Production should use a version within the declared engine range.

## 5. Files changed

- `.env.example`
- `README.md`
- `src/admin-access.js`
- `src/app.js`
- `src/database.js`
- `src/routes/admin.js`
- `src/routes/auth.js`
- `src/routes/repositories.js`
- `src/security-service.js`
- `src/session-store.js`
- `test/session-confidentiality.test.js`
- `docs/security/README.md`
- `docs/security/reports/2026-07-22-session-payload-confidentiality-hardening.md`

## 6. Residual risks and operational requirements

- Uploaded file contents are protected by application authorization and filesystem permissions but are not encrypted by RecordDrive at rest. Use encrypted volumes or object storage when host/storage administrators are outside the trust boundary.
- Protect `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, TLS private keys, the SQLite database, upload volume, and all backups separately. Do not store the encryption key beside exported database backups.
- Database copies or backups created before this upgrade can still contain plaintext historical session rows. Expire or destroy old backups according to the organization's retention policy.
- Validate native TLS and reverse-proxy behavior in the real deployment, including host allowlisting, forwarded-protocol trust, certificate chains, and HTTP-to-HTTPS handling.
- The application does not malware-scan uploads. Encrypted archives and hostile documents should be handled through a separate quarantine/scanning service when required.
- Continue lockfile scanning and automated advisories after deployment; dependency status changes over time.

## 7. Primary references

- OWASP Top 10 — Cryptographic Failures
- OWASP Session Management Cheat Sheet
- OWASP Secrets Management Cheat Sheet
- OWASP File Upload Cheat Sheet
- MITRE CWE-312 — Cleartext Storage of Sensitive Information
