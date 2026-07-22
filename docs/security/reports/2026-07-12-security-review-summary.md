# Security Review Summary

Review date: 2026-07-12
Supplied baseline: `bef76f38b656e9f75057c0085bd34f1be75510d6`

## Outcome

Two reproducible application-specific availability vulnerabilities were confirmed and fixed:

- **RD-2026-002:** Authenticated repository creation had no per-user or service-wide record limit. Mapped to CWE-770 and CWE-400. A 1,000-request authenticated route PoC created 1,000 records before the fix; the patched build accepted only the configured 50 and rejected the remaining 950.
- **RD-2026-003:** Consumed MFA recovery-code rows were retained indefinitely. Mapped to CWE-459 with CWE-770/CWE-400 as the resource-exhaustion consequence. A 5,000-cycle service-path PoC retained 5,000 consumed rows before the fix; the patched build retained none and kept only one active code.

No CVE identifier is assigned to these private application findings. Actual dependency CVEs were reviewed separately rather than inventing identifiers.

## Remediation summary

- Added validated per-user and service-wide repository limits.
- Made repository duplicate, quota, and insertion checks one serialized SQLite transaction.
- Added an owner-count index.
- Atomically delete a recovery code after successful use and purge legacy consumed rows at startup.
- Normalized 93 environment-specific lockfile tarball URLs to canonical npm registry URLs while preserving versions and integrity hashes.
- Added two deterministic PoCs and two regression tests.
- Generated a 266-component CycloneDX 1.5 SBOM.

## Dependency status

- `npm audit --omit=dev`: 0 known vulnerabilities across 247 production and 266 total dependencies.
- `npm outdated`: no outdated direct dependencies reported.
- `npm ls --all`: no dependency-tree problems.
- Multer 2.2.0 is not affected by CVE-2026-5079 or CVE-2026-5038.
- yauzl 3.4.0 is not affected by CVE-2026-31988; the crafted archive PoC completed safely in the application preview path.
- `npm audit signatures` was inconclusive because DNS access to the Sigstore TUF endpoint failed. This was a network limitation, not a signature-validation result.

## Validation

```text
Runtime: Node.js 24.18.0
npm run check: passed
npm run test:security: 4 passed, 0 failed
npm test: 34 passed, 0 failed
git diff --check: passed
git fsck --full: passed
```

The full evidence, exact PoC output, references, and residual risks are in [`2026-07-12-security-audit.md`](2026-07-12-security-audit.md) and [`2026-07-12-security-poc-results.txt`](../evidence/2026-07-12-security-poc-results.txt). The original `.git` directory is retained.
