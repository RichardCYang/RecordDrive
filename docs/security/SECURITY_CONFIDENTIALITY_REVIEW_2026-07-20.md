# RecordDrive Confidentiality Security Deep-Dive Review and Remediation Report

- Review date: 2026-07-20 (KST)
- Source archive reviewed: `RecordDrive.zip`
- Original SHA-256: `694c9cec67d5b9ea6c18c1eeae9a6c1846ccd4c0373060b03848a46ef2905bc8`
- Primary scope: authentication and sessions, stored-file access control, uploaded-file parsing and previews, secret exposure, minimization of disclosed personal data, and dependency vulnerabilities
- Conclusion: **No Critical-severity vulnerability was confirmed. One High, two Medium, and one Medium-Low finding that could have led to actual confidential-information exposure were remediated.**

## 1. Review methodology

1. Checked the ZIP for path traversal and symbolic links, then extracted it safely into an isolated working directory.
2. Manually traced Express routing, storage-path validation, authorization middleware, the session store, MFA/WebAuthn flows, and file-preview parsers.
3. Performed static searches for external-process execution, environment-variable propagation, dynamic SQL, unescaped HTML output, static-file exposure, sensitive logging, and secret patterns.
4. Scanned both the working tree and every blob in `.git` for high-confidence secret patterns, including private keys and common AWS, GitHub, Slack, and Google credentials.
5. Ran `npm audit` and the complete Node.js test suite.
6. Compared per-file SHA-256 manifests of `.git` before and after the changes.

## 2. Remediated vulnerabilities

### RD-C-01 — Native parsing of untrusted 7z files with application privileges and the full secret environment

- Severity: **High**
- Impact: A 7-Zip native parser processed user-controlled 7z/NTFS images as the same operating-system user as the application. If a parser vulnerability were exploited, all confidential data readable by the application could have been exposed, including the SQLite database, uploaded files, and session, MFA, and TLS-related environment variables.
- Evidence:
  - The previous Dockerfile installed Alpine's unpinned `7zip` package by default.
  - 7z preview was enabled automatically without configuration and passed the complete `process.env` object to `spawn()`.
  - GitHub Security Lab disclosed a heap buffer overflow caused by crafted NTFS input in 7-Zip 26.00, with potential arbitrary code execution, and stated that it was fixed in 26.01.
- Remediation:
  - Added `SEVEN_ZIP_PREVIEW_ENABLED=false` as the default and prevented the native parser from running without explicit opt-in.
  - Removed 7-Zip from the default Docker image; it is installed only when the `RECORDDRIVE_INSTALL_7ZIP=true` build argument is supplied.
  - Even when enabled, the child-process environment is restricted to values required for execution, such as `PATH`, temporary-directory variables, and locale settings. Application secrets are not propagated.
  - Added regression coverage for the disabled state and environment-variable filtering.
- Residual risk: When explicitly enabled, the native parser still runs as the RecordDrive operating-system account. Additional isolation is recommended, such as a separate container or process, a read-only filesystem, disabled networking, and a least-privileged account.

### RD-C-02 — Unsandboxed same-origin inline rendering of uploaded PDFs

- Severity: **Medium**
- Impact: An attacker-uploaded PDF opened in a regular same-origin iframe and a new tab. Depending on browser PDF-handler vulnerabilities or active PDF behavior, this unnecessarily increased the possibility of dangerous activity within an origin where the user's authenticated session existed.
- Remediation:
  - Added an empty `sandbox` attribute and `referrerPolicy="no-referrer"` to the PDF iframe.
  - Added dedicated PDF response headers, including `Content-Security-Policy: sandbox; default-src 'none'; ...`, `Referrer-Policy`, `Permissions-Policy`, and `Cross-Origin-Resource-Policy`.
  - Added `noopener noreferrer` to the new-tab link.
  - Verified the response headers and client-side sandbox configuration with integration tests.

### RD-C-03 — No session-ID rotation after sensitive-setting reauthentication, and existing sessions surviving MFA changes

- Severity: **Medium**
- Impact: If a session ID had already been stolen, a user's successful password reconfirmation could elevate that same session into a state authorized to access sensitive security settings. In addition, other existing login sessions remained valid after TOTP or passkeys were added or removed.
- Remediation:
  - Called `session.regenerate()` immediately after successful password reconfirmation to invalidate the previous session ID and issue a new one.
  - Preserved the original login time and absolute session lifetime while refreshing only the security-verification timestamp.
  - Immediately removed all other server-side sessions for the user when TOTP or a passkey was added or removed, while retaining the current session.
  - When an administrator deletes an account, authentication and in-progress MFA sessions for that user are also removed.
  - Verified session-ID rotation and invalidation of other sessions with integration tests.

### RD-C-04 — Participant account names and permission structure exposed to view-only shared users

- Severity: **Medium-Low**
- Impact: A user with view-only repository access could see other shared users' display names, login usernames, and detailed permissions on the repository page. This unnecessarily exposed organizational relationships, account identifiers, and permission assignments.
- Remediation:
  - Restricted retrieval of the full shared-user list and permission details to repository owners and administrators.
  - Limited ordinary shared users to seeing only the number of shared participants.
  - Removed an unused uploader-username field from the SQL result.
  - Added a test confirming that another participant's username is not rendered on a non-administrator page.

## 3. Major areas reviewed that required no additional remediation

- Stored files are kept outside the web root under randomized storage names, and owner-only POSIX permissions are applied to the database and upload directories.
- Path normalization, stored-file-name validation, symbolic-link rejection, and `O_NOFOLLOW`-based access are implemented.
- Repository-specific view, upload, download, and delete permissions are revalidated on each route. Unauthorized file previews and downloads return a generic 404 response.
- Session regeneration at login and MFA completion, HttpOnly/SameSite cookies, production-only Secure cookies, idle and absolute timeouts, and per-user session limits are implemented.
- CSRF validation applies to standard forms, JSON requests, and multipart uploads.
- TOTP secrets, temporary recovery-key bundles, and stored TLS passphrases are protected with authenticated encryption; recovery keys are stored as hashes.
- Unescaped EJS output is used only for static partial includes, while user-provided output is escaped.
- No high-confidence hard-coded secret pattern was found in the working tree or `.git` history.

## 4. Validation results

- `node --check`: all modified JavaScript files passed
- `npm test`: **55/55 passed, 0 failed**
- `npm audit` (production and full dependency sets): **0 vulnerabilities**
- Test runtime: Node.js `v22.16.0`, npm `10.9.2`
- Note: The project's declared engine range is Node.js `^22.23.0 || ^24.17.0 || ^26.3.1`, so the local test runtime was below the declared minimum patch version. Functional tests passed, but production deployments should use a supported version, such as the Node.js 24 line used by the Dockerfile.
- Docker: The container build was not run because the review environment did not have the Docker CLI.

## 5. `.git` preservation verification

- `.git` file count: 28
- Pre-remediation SHA-256 of the complete `.git` file manifest: `b0d680425129b617d0ed7a1a16676a60ebfb27783fbc2f01f2d4986976ca505e`
- Post-remediation SHA-256 of the complete `.git` file manifest: `b0d680425129b617d0ed7a1a16676a60ebfb27783fbc2f01f2d4986976ca505e`
- When the final ZIP was created, `.git` entries were copied directly from the original ZIP so their file bytes, paths, permissions, and timestamp metadata were reused.
- Result: **The file list and every file's contents were identical; `.git` was neither deleted nor modified.**

## 6. Files changed

- `.env.example`
- `Dockerfile`
- `README.md`
- `public/js/app.js`
- `src/config.js`
- `src/file-preview.js`
- `src/i18n-preview.js`
- `src/routes/admin.js`
- `src/routes/repositories.js`
- `src/routes/settings.js`
- `src/session-store.js`
- `views/repository.ejs`
- `test/preview.test.js`
- `test/security-hardening.test.js`
- `test/seven-zip-preview.test.js`
- `docs/security/SECURITY_CONFIDENTIALITY_REVIEW_2026-07-20.md` (this report; subsequently translated to English and centralized)

## 7. References

- GitHub Security Lab, GHSL-2026-140 — https://securitylab.github.com/advisories/GHSL-2026-140_7-Zip/
- OWASP File Upload Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
