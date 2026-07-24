# Security PoC Guide

Run all commands from the repository root. All PoCs use temporary local databases and files; they do not target a remote service.


## Patched WebAuthn challenge replay boundary

```bash
node security-poc/webauthn-challenge-replay.mjs
```

Expected result: the session-only baseline accepts the same challenge in both independently loaded parallel request snapshots, while the patched production SQLite ledger accepts exactly one consume operation. Raw session/challenge values remain absent from the ledger, the credential counter update uses compare-and-swap, and the output ends with `"verdict": "BLOCKED"`.

Run the focused dependency-free regression suite:

```bash
node --test test/webauthn-challenge-replay.test.js
```

## Patched MFA sensitive material disclosure boundary

```bash
node security-poc/mfa-sensitive-session-material.mjs
```

Expected result: the supplied route model discloses both the pending TOTP setup secret and newly generated recovery codes after the ten-minute password-verification window has expired. The patched production helper caps both disclosure lifetimes at that verification expiry, both patched disclosure fields are `false`, and the output ends with `"verdict": "BLOCKED"`.

Run the focused dependency-free regression suite:

```bash
node --test test/sensitive-session-material.test.js
```

## Patched generated-preview disclosure revocation boundary

```bash
node security-poc/generated-preview-disclosure-revocation.mjs
```

Expected result: the one-shot JSON baseline fully discloses the approximately 1 MiB confidential preview after both permission and session revocation. The patched buffer pump stops after a bounded partial chunk and ends with `"verdict": "BLOCKED"`.

Run the focused dependency-free regression suite:

```bash
node --test test/generated-preview-disclosure-revocation.test.js
```

## Patched file-stream chunk-boundary revocation

```bash
node security-poc/chunk-boundary-disclosure-revocation.mjs
```

Expected result: the legacy cached-decision model sends all 1,048,576 bytes after authorization is revoked immediately following the first write. The patched production `streamProtectedFile()` sends only the first 65,536-byte chunk, reports `"revoked": true`, and ends with `"verdict": "BLOCKED"`.

Run the dependency-free regression test:

```bash
node --test test/file-stream-chunk-revocation.test.js
```

## Patched in-flight disclosure revocation boundary

```bash
node security-poc/in-flight-disclosure-revocation.mjs
```

Expected result: the baseline permission- and session-revocation scenarios both receive the full 2 MiB file, while the patched production authorizer/file pump terminates both responses after a bounded partial chunk and ends with `"verdict": "BLOCKED"`.

Run the focused regression suite:

```bash
node --test test/in-flight-disclosure-revocation.test.js
```

## Patched session tombstone-expiry boundary

```bash
node security-poc/session-tombstone-expiry.mjs
```

Expected result: both `delayedTouchResurrected` and `staleSetResurrected` are `false`, no session row is recreated, and the output ends with `"verdict": "BLOCKED"`.

Run the focused regression suite:

```bash
node --test test/session-revocation-race.test.js
```

## Patched request-error logging boundary

Run the dependency-free before/after model. It uses a synthetic credential marker and does not write the marker itself to stderr:

```bash
node security-poc/request-error-log-object-poc.mjs
```

Expected result: the modeled legacy `console.error(error)` formatting contains the credential marker, submitted field name, and raw `body` property. The hardened logger retains `entity.parse.failed` but reports all three sensitive indicators as `false`; the output ends with `"verdict": "PASS"`.

Run the focused dependency-free regression checks:

```bash
node --test --test-name-pattern='safe request error logging|request parsers run|localized' test/request-error-confidentiality.test.js
```

With dependencies installed, the full application route PoC is also available:

```bash
node security-poc/request-error-log-confidentiality.mjs
```

Expected result: malformed JSON is returned as HTTP 400, the parser error class is logged, and the synthetic credential marker, `currentPassword` field name, and raw body property are absent.

## Patched Host header and DNS rebinding boundary

```bash
node security-poc/host-header-dns-rebinding.mjs
```

Expected result: the baseline loopback model accepts `Host: attacker.example`, establishes demonstration session/CSRF state, and returns a synthetic confidential marker after the documented example credentials are submitted. The patched production Host policy returns HTTP 421 before setting a cookie, while `Host: localhost` remains functional. The output must end with `Result: PASS - hostile Host requests are rejected before session establishment.`

The focused parser and middleware regression suite can be run without external dependencies:

```bash
node --test test/host-header-confidentiality.test.js
```

## Patched authentication rate-limit concurrency boundary

```bash
ATTEMPTS=100 node security-poc/authentication-rate-limit-race.mjs
```

Expected result: the modeled legacy check-then-record logic admits all 100 concurrent attempts, while the patched implementation admits only 10 password checks, 10 MFA checks, and 5 security-password reauthentication checks. The output must include `"legacyBypassed": true` and `"patchedBounded": true`.

The focused regression suite can also be run without starting the web service:

```bash
node --test test/authentication-rate-limit-race.test.js
```

## Patched repository-creation boundary

```bash
ATTEMPTS=1000 \
MAX_REPOSITORIES_PER_USER=50 \
MAX_TOTAL_REPOSITORIES=100 \
node security-poc/repository-growth.mjs
```

Expected result: 50 accepted requests, 950 rejected requests, 50 retained repository rows, and `"bounded": true`.

## Patched recovery-code cleanup

```bash
CYCLES=5000 node security-poc/recovery-code-retention.mjs
```

Expected result: one active row, zero retained consumed rows, and `"bounded": true`.

## Patched activity-log retention

```bash
MAX_ACTIVITY_LOG_ENTRIES=1000 \
ATTEMPTS=25000 \
node security-poc/activity-log-growth.mjs
```

The retained row count must remain at or below the configured limit.

## CVE-2026-31988 dependency check

```bash
node security-poc/yauzl-cve-2026-31988.cjs .
```

The installed yauzl 3.4.0 must report `"status":"safe"` for the malformed NTFS timestamp fixture.

## Automated regression suite

```bash
npm run test:security
```

## Reproducing the supplied baseline safely

Use an isolated Git worktree and never expose it as a network service:

```bash
git worktree add ../recorddrive-baseline bef76f38b656e9f75057c0085bd34f1be75510d6
cp security-poc/repository-growth.mjs ../recorddrive-baseline/security-poc/
cp security-poc/recovery-code-retention.mjs ../recorddrive-baseline/security-poc/
cd ../recorddrive-baseline
npm ci --ignore-scripts
EXPECT_BOUNDED=false ATTEMPTS=1000 node security-poc/repository-growth.mjs
EXPECT_BOUNDED=false CYCLES=5000 node security-poc/recovery-code-retention.mjs
```

The baseline commands are intentionally local resource-consumption demonstrations. Use only disposable temporary storage. Remove the worktree after validation:

```bash
git worktree remove ../recorddrive-baseline --force
```

## Live session-state disclosure revocation

```bash
node security-poc/session-state-disclosure-revocation.mjs
node --test test/session-state-disclosure-revocation.test.js
```

The PoC keeps the server-side session row and rolling idle expiry live while first removing the authenticated identity from the encrypted payload and then exceeding a short absolute lifetime. RecordDrive 2.0.4 continues authorizing both states; 2.0.5 fails closed.

## Recovery-key rotation session revocation

```bash
node security-poc/recovery-code-session-revocation.mjs
node --test test/recovery-code-session-revocation.test.js
```

Expected result: the baseline model reports a stolen session as active after recovery-key rotation. The patched model reports one revoked other session, keeps the current owner session active, and ends with `"verdict": "BLOCKED"`. The forced SQLite insertion failure must retain the prior recovery-key row and report `"verdict": "ROLLED_BACK"`.

## Docker build-context confidentiality

```bash
node security-poc/docker-build-context-confidentiality.mjs .
node --test test/docker-build-context-confidentiality.test.js
```

Expected result: the vulnerable baseline reports seven exposed deployment-secret/backup canaries and `"verdict": "EXPOSED"`. The patched policy reports explicit runtime copy sources, zero exposed canaries, eight blocked canaries including `.git/config`, and `"verdict": "BLOCKED"`. This is a dependency-free build-policy reproduction and does not require a Docker daemon.
