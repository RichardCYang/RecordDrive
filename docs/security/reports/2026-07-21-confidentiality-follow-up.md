# RecordDrive Confidentiality Security Deep-Dive Follow-Up

| Field | Value |
| --- | --- |
| Review date | 2026-07-21 (KST) |
| Reviewed archive | `RecordDrive.zip` |
| Source SHA-256 | `18f56d3f7be8329189a4308fc0f74491fd04111d6221cd000b4410228ab3c11f` |
| Scope | Authentication and sessions, repository authorization, user-identity exposure, error responses, uploads, downloads, previews, filesystem boundaries, secrets, dependencies, and Git history |
| Outcome | Two high-priority confidentiality issues were remediated, and one session-store defense-in-depth improvement was added. No unresolved Critical-severity confidentiality vulnerability was confirmed in the reviewed source. |

This report is a follow-up review of the uploaded source after the [final hardening pass](2026-07-21-confidentiality-final-hardening.md).

## 1. Methodology

1. Inspected the ZIP for path traversal, symbolic links, and abnormal compression ratios, then extracted it into an isolated working directory.
2. Generated a SHA-256 manifest for every file under `.git` before modification and ran `git fsck --full --no-reflogs`.
3. Manually traced Express middleware order, authentication, MFA and session lifecycles, repository permission checks, permission-management UI, file download and preview paths, upload streaming, storage-path validation, and error handling.
4. Searched statically for dynamic code execution, external processes, dynamic SQL, path manipulation, secret-bearing logs and responses, user-directory exposure, and storage under the public web root.
5. Scanned the working tree and 553 text blobs across 32 Git commits for high-confidence private-key, AWS, GitHub, Slack, and Google token patterns.
6. Installed dependencies from the lockfile and audited both production and complete dependency graphs.
7. Added regression tests for each remediation and reran the full test suite.

## 2. Confirmed and remediated findings

### RD-C-2026-07 — Repository owners could enumerate the complete user directory

- Severity: **High in multi-user or identity-sensitive environments**
- Impact:
  - Any regular user could create a private repository and open its permission-management page.
  - The page displayed the names and login usernames of all regular users who did not already have permission.
  - This information could reveal organization membership, account identifiers, and internal naming conventions useful for phishing, account guessing, or targeted attacks.
- Root cause:
  - The permission-page query returned every eligible account from the `users` table.
  - The template rendered that data directly in a `<select>` element.
- Remediation:
  - Removed the full user-directory query.
  - Permission grants now require the owner to enter an **exact username** that they already know.
  - The server normalizes and validates the input, then looks up only an exact matching regular user. The repository owner and administrator accounts remain ineligible.
  - Failed grant attempts continue to return a generic response.
  - Users who already have permission remain visible only because they are explicit participants in that repository.
- Regression coverage:
  - Confirms that unrelated user accounts are absent from the permission page.
  - Confirms that the `userId` selector is removed and only the exact `username` input remains.
  - Confirms that granting access by exact username reveals only the selected user in the current-permissions list and enables the intended access.

### RD-C-2026-08 — Externally reachable development deployments could disclose internal exception messages

- Severity: **High when development mode listens on a non-loopback interface**
- Impact:
  - Existing runtime policy required strong secrets and HTTPS for non-loopback listeners even in development mode.
  - General 500 responses, however, checked only `isProduction`, so development mode returned `error.message` to clients.
  - An external actor able to trigger an error could receive internal file paths, database constraints, parser details, or library information.
- Remediation:
  - Added an `exposeDetailedErrors` policy that permits detailed errors only when the application is both non-production and loopback-only.
  - Production or non-loopback listeners now return only generic messages for unexpected 500 responses.
  - Detailed errors remain available in server-side logs.
- Regression coverage:
  - Confirms that loopback test environments may expose detailed errors.
  - Confirms that an externally bound development listener with strong secrets and HTTPS still disables detailed error responses.

### RD-C-2026-09 — Session-store identifier hardening

- Severity: **Medium / Defense in Depth**
- Impact:
  - The previous `sessions.sid` value stored the same random session identifier used by the browser.
  - Cookie signing provided separate protection, but avoiding direct storage of the raw identifier reduces risk in a combined compromise of the session store, backups, and signing secret.
- Remediation:
  - Browser session identifiers are no longer stored directly in SQLite.
  - A purpose-separated key is derived from `SESSION_SECRET`, and only the HMAC-SHA-256 of the session identifier is stored in `sessions.sid`.
  - Lookup, update, destruction, per-user session limits, and post-MFA invalidation now use the same derived storage identifier.
  - The browser session identifier cannot be recovered from the stored value.
- Operational impact:
  - Existing pre-deployment raw-session rows cannot be located using the new identifier, so users must sign in once after deployment.
  - Legacy rows are removed by normal expiration cleanup.
- Regression coverage:
  - Confirms that the browser cookie's session identifier differs from the database `sid`.
  - Confirms that the database value matches the expected HMAC and is a 64-character hexadecimal string.
  - Confirms that authentication, session rotation, limits, and invalidation continue to work after the change.

## 3. Areas reviewed without another confirmed severe defect

- View, upload, download, delete, and manage permissions are rechecked on every repository request; unauthorized repositories return 404 responses.
- File lookup for downloads and previews is constrained to the authorized repository ID.
- Uploaded files are stored outside the public web root under random storage names with restricted directory and file permissions.
- Storage-path normalization, protected-directory nesting checks, symbolic-link rejection, and `O_NOFOLLOW`-based opening are applied.
- Authentication responses use the same message and a dummy bcrypt comparison for nonexistent users and incorrect passwords.
- Sessions rotate at login, MFA completion, and security reauthentication, with idle and absolute expiration and per-user session limits.
- Authenticated responses use `Cache-Control: private, no-store`; cookies are HttpOnly, SameSite=Strict, and Secure when required.
- TOTP secrets, temporary recovery-code bundles, and TLS passwords use authenticated encryption; recovery codes are stored as hashes.
- PDF responses use a sandbox CSP and no-referrer/CORP policies; ZIP, XLSX, and 7z previews enforce entry, size, and time limits.
- No path was found that concatenates user input directly into SQL syntax; dynamic clauses are restricted to allowlists or fixed fragments.
- No external command execution path was found for uploaded-file processing in the application runtime.
- No high-confidence real secret or token pattern was found in the current working tree or Git history.

## 4. Validation results

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| Full Node.js test suite | 64/64 passed; 0 failed |
| New confidentiality regression tests | User-directory non-disclosure, HMAC session storage, and external error-detail suppression passed |
| `npm audit --omit=dev` | Critical 0 / High 0 / Moderate 0 / Low 0 |
| Full `npm audit` graph | Critical 0 / High 0 / Moderate 0 / Low 0 |
| Git-history secret scan | 32 commits, 553 text blobs, 0 high-confidence detections |
| `.git` file count | 28 |
| Pre/post `.git` file SHA-256 manifests | Identical |
| `.git` content-manifest SHA-256 | `bd13838247694374f8456371eb9b834eefd6883d6d5cca7f99e1211caaba013d` |
| Final `git fsck --full --no-reflogs` | Passed |

The test runtime, Node.js `v22.16.0`, was below the project's declared minimum patch level of `^22.23.0`. All tests passed, but production deployments should use a version within the `package.json` engine range.

## 5. Files changed in the reviewed remediation

- `src/app.js`
- `src/config.js`
- `src/i18n.js`
- `src/routes/auth.js`
- `src/routes/repositories.js`
- `src/routes/settings.js`
- `src/session-store.js`
- `views/repository-permissions.ejs`
- `test/file-access-time.test.js`
- `test/preview.test.js`
- `test/security-hardening.test.js`
- `test/smoke.test.js`
- `docs/security/reports/2026-07-21-confidentiality-follow-up.md`

## 6. Primary security guidance consulted

- OWASP Authorization Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Error Handling Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP File Upload Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- MITRE CWE-200 — https://cwe.mitre.org/data/definitions/200.html
