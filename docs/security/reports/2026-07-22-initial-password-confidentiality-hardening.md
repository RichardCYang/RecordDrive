# Initial Password Confidentiality Hardening

Date: 2026-07-22

## Finding

Regular user accounts were provisioned with an administrator-selected initial password, but the application did not provide a password-change feature and did not require replacement after first sign-in. As a result, a credential known by the administrator and exposed during account handoff could remain valid for the entire lifetime of the account.

## Confidentiality impact

An administrator-selected or insecurely delivered password could be reused indefinitely to access every repository and file authorized for that user. Enabling MFA later reduced but did not eliminate the underlying shared-credential problem, especially before MFA enrollment or when a recovery method was available.

## Remediation

- Added `users.must_change_password`; the upgrade migration marks every existing regular account for one required password replacement while leaving administrator accounts unchanged.
- New regular accounts are created with a temporary password and `must_change_password = 1`.
- Increased the new-account password minimum from 8 to 12 characters without adding composition rules.
- After password and MFA authentication, accounts with the flag are sent to `/settings/password`.
- A global guard blocks repositories, downloads, previews, administrative routes, settings, and JSON endpoints until the temporary password is replaced. Only password replacement, sign-out, health, and public static assets remain reachable.
- Password replacement verifies the current password, counts Unicode code points, enforces 12–128 characters and the bcrypt 72-byte boundary, rejects reuse, requires confirmation, and is protected by CSRF and password-attempt rate limiting.
- Successful replacement clears the flag, rotates the current session identifier, refreshes authentication timestamps, revokes every other active session, and writes a `PASSWORD_CHANGED` activity event.
- Added a normal self-service password-change page so credentials can be rotated later without administrator involvement.
- Added regression coverage for forced first-login replacement, protected-route blocking, validation failures, old-password invalidation, session revocation, and audit logging.

## Validation

All 109 JavaScript files in `src`, `test`, `security-poc`, and `vendor` passed `node --check`. Eight dependency-free unit tests passed, including Unicode-character and bcrypt-byte password-policy boundaries. Archive-path, symlink, secret-pattern, EJS raw-output, browser HTML-sink, and `.git` integrity checks were also run during packaging. The complete integration suite and `npm audit` could not be executed in the analysis environment because both the configured npm registry and the public npm registry were unavailable; dependency installation failed before the dependent tests could start. The new integration regression test is included for execution in CI or an environment with the locked dependencies available.
