# Security PoC Guide

Run all commands from the repository root. All PoCs use temporary local databases and files; they do not target a remote service.

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
