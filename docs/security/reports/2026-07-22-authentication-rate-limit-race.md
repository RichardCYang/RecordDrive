# Authentication Rate-Limit Concurrency Review

**Review date:** 2026-07-22  
**Scope:** RecordDrive 2.0.2 authentication, MFA, and sensitive-settings reauthentication  
**Primary security property:** Confidentiality  
**Outcome:** One high-severity concurrency flaw reproduced and remediated

## Executive summary

RecordDrive enforced numeric limits for password, MFA, and security-settings reauthentication failures, but the original implementation counted a request only after the asynchronous credential check completed. A burst of concurrent requests could therefore pass the pre-check while every counter was still below its threshold.

A local PoC started 100 requests before recording any failure. The original control admitted all 100 requests despite configured account limits of 10 password attempts, 10 MFA attempts, and 5 security-password confirmation attempts. This created a practical online-guessing window and, for six-digit TOTP, materially weakened the second factor when an attacker already possessed the account password and a pending MFA session.

The fix reserves each attempt before credential verification begins. Active reservations and completed failures are counted together. Completion then atomically converts the reservation into either a failure or a released slot. The same mechanism now protects:

- Password login by source address and normalized account name.
- TOTP, recovery-code, and passkey verification by source address and user ID.
- Password reauthentication for security-setting changes by source address and user ID.

After remediation, the same 100-request PoC admitted exactly 10 password checks, 10 MFA checks, and 5 security-password checks.

## Finding RD-2026-07-22-01: concurrent authentication attempts bypass throttling

**Severity:** High  
**Weakness:** CWE-362, Concurrent Execution Using Shared Resource with Improper Synchronization  
**Related weakness:** CWE-307, Improper Restriction of Excessive Authentication Attempts

### Affected flows

- `POST /login`
- `POST /login/mfa/totp`
- `POST /login/mfa/recovery`
- `POST /login/mfa/passkey/verify`
- `POST /settings/security/verify-password`

### Root cause

The previous password and MFA control used a check-then-record sequence:

1. Read the failure counter.
2. Allow the request when the completed-failure count was below the limit.
3. Perform asynchronous password, TOTP, or passkey verification.
4. Increment the failure counter only after verification failed.

Multiple requests reaching step 1 before any request reached step 4 observed the same stale count and were all admitted. The security-settings password control additionally kept its counter in the browser session. Concurrent requests could load independent copies of the same session state and overwrite one another with a last-write-wins update.

### Confidentiality impact

The flaw did not directly disclose a file. It weakened the authentication boundary protecting every repository and security-setting operation:

- An unauthenticated attacker could submit a substantially larger password-guessing burst than the configured limit.
- An attacker with a valid password could parallelize guesses against a six-digit TOTP challenge and weaken MFA.
- An attacker with a stolen authenticated session could parallelize password reauthentication attempts used to unlock MFA enrollment, passkey management, and recovery-code changes.

Actual compromise still depends on guessing a valid secret and on available server capacity, but the intended online-guessing control was not effective under concurrency.

## Safe local PoC

The PoC is implemented in `security-poc/authentication-rate-limit-race.mjs`. It does not contact a remote service and uses mock request/response objects.

```bash
ATTEMPTS=100 node security-poc/authentication-rate-limit-race.mjs
```

Expected result:

```json
{
  "attempts": 100,
  "legacy": {
    "loginAcceptedBeforeAnyFailureCompletes": 100,
    "mfaAcceptedBeforeAnyFailureCompletes": 100,
    "securityReauthAcceptedBeforeAnyFailureCompletes": 100
  },
  "patched": {
    "loginAcceptedBeforeAnyFailureCompletes": 10,
    "mfaAcceptedBeforeAnyFailureCompletes": 10,
    "securityReauthAcceptedBeforeAnyFailureCompletes": 5
  },
  "legacyBypassed": true,
  "patchedBounded": true
}
```

Exact pre- and post-remediation output is retained in `docs/security/evidence/2026-07-22-authentication-rate-limit-race-results.txt`.

## Remediation

### Attempt reservation

`src/middleware/login-rate-limit.js` now stores both completed failures and active verification attempts. A request must reserve capacity in all applicable buckets before expensive or asynchronous verification begins. Admission uses:

```text
completed failures + active reservations < configured maximum
```

The reservation is completed in one of three ways:

- **Failure:** decrement the active count and increment the completed-failure count.
- **Success:** decrement the active count and clear completed account/user failures while preserving other active requests.
- **Internal error:** decrement the active count without recording an authentication failure.

### Route integration

`src/routes/auth.js` now:

- Releases login reservations when an unexpected error occurs.
- Reserves MFA capacity only for endpoints that actually verify an authenticator.
- Records failed TOTP, recovery-code, and passkey checks against the reservation.
- Clears or releases the reservation on success or error.

`src/routes/settings.js` now:

- Uses the shared server-side limiter for password reauthentication.
- Removes the session-local check-then-write counter.
- Records failure, success, and error completion explicitly.

### Regression coverage

`test/authentication-rate-limit-race.test.js` verifies:

- A 100-request password burst admits only 10 checks.
- A successful concurrent password check does not discard other active reservations.
- A 100-request MFA burst admits only 10 checks.
- A 100-request security-reauthentication burst admits only 5 checks.

`npm run test:security` now includes this regression file.

## Additional confidentiality review results

No additional critical or high-severity confidentiality defect was confirmed in the following reviewed boundaries:

- Repository authorization and file lookups bind both repository ID and file ID.
- Preview and download endpoints require download permission and return a generic not-found response across authorization failures.
- Stored-file access rejects unsafe names, symlink ancestors, symlink targets, and non-regular files and uses no-follow file opening where supported.
- Uploads use server-generated stored names, exclusive creation, restrictive file mode, quota enforcement, and cleanup paths.
- Browser rendering of untrusted file metadata and preview content uses DOM text APIs rather than HTML-string insertion.
- PDF previews use a sandboxed frame and restrictive response policy.
- Session cookies, session rotation, absolute expiration, protected secret storage, and fail-closed external HTTPS defaults were present.

These statements reflect source review and focused local tests, not a claim that the application is free of all vulnerabilities.

## Residual risks and operational requirements

- The limiter is process-local. The supplied PM2 configuration uses one forked process and the supplied container runs one Node process. A future multi-process or horizontally scaled deployment must move rate-limit state to a shared atomic store.
- Process restart clears the counters. Edge rate limiting and authentication monitoring remain recommended.
- Archive and spreadsheet previewing handles untrusted complex formats. Existing byte, entry, row, and timeout limits reduce risk, but parser vulnerabilities and resource-exhaustion defects remain a patch-management concern.
- Full dependency installation and `npm audit` could not be repeated in the isolated review environment because the package registry was unavailable. Dependency versions and lockfile integrity were reviewed statically, and focused tests that require no external packages were executed.
- The review host had Node.js 22.16.0, while this project requires a currently supported security release matching `^22.23.0`, `^24.17.0`, or `^26.3.1`. Production should use a version permitted by `package.json`; the supplied Dockerfile uses Node.js 24.18.0.

## Standards and references

- OWASP Authentication Cheat Sheet, “Login Throttling”
- OWASP Multifactor Authentication Cheat Sheet, “One-Time Password Handling and Storage”
- NIST SP 800-63B, rate-limiting requirements for failed authentication attempts
- Express Production Security Best Practices, “Prevent brute-force attacks against authorization”
