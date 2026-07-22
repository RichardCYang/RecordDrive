# RecordDrive Security Audit and Remediation Report

Review date: 2026-07-12
Supplied baseline Git commit: `bef76f38b656e9f75057c0085bd34f1be75510d6`
Application: RecordDrive 2.0.1
Scope: Supplied Node.js file-server source, retained Git history, authentication and MFA, authorization, sessions, CSRF, file upload and download, preview parsers, SQLite persistence, TLS configuration, dependencies, lockfile provenance, deployment files, and automated tests.

## Executive summary

The supplied project already contained extensive security hardening and a previous remediation for bounded activity-log retention. This review confirmed two additional application-specific availability weaknesses and one supply-chain portability defect:

1. An authenticated regular user could create repository records without a per-account or service-wide upper bound.
2. Consumed MFA recovery-code rows were retained indefinitely, allowing persistent database growth through repeated code consumption and regeneration.
3. The supplied `package-lock.json` pinned 93 dependency tarballs to an environment-specific internal registry host, reducing build portability and making independent origin verification unnecessarily dependent on that proxy.

Both application findings were reproduced against the unmodified supplied Git baseline using real application or security-service paths. They were remediated, and the same PoCs now demonstrate bounded behavior. The lockfile was normalized to the official npm registry without changing package versions, tarball paths, or integrity hashes. Existing data and repository functionality remain intact; repository limits apply only to new records, and only already-consumed recovery-code rows are removed.

No CVE identifier is assigned to either private application-specific finding. Inventing a CVE would be inaccurate. The findings are mapped to existing CWE entries, while actual third-party CVEs relevant to installed packages were checked separately.

## Confirmed finding RD-2026-002: Unbounded authenticated repository creation

**Severity:** Medium
**Impact:** Persistent database and metadata storage exhaustion; eventual availability loss
**Required access:** Authenticated regular user
**Primary CWE:** CWE-770, Allocation of Resources Without Limits or Throttling
**Related CWE:** CWE-400, Uncontrolled Resource Consumption
**CVE:** None assigned; this is an application-specific finding.

### Root cause

`POST /repositories` validated the repository name and duplicate names but imposed no limit on the number of repository records owned by an account or stored across the service. A repository record allocates persistent SQLite rows and causes related index and audit-log growth even when no files are uploaded. File-byte and file-count quotas therefore did not bound this resource.

### Baseline PoC

The PoC used an authenticated `supertest` agent, a valid CSRF token, and the real `POST /repositories` route against an isolated database created from the supplied baseline.

```text
Attempts: 1,000
Accepted requests: 1,000
Rejected requests: 0
Repository rows: 1,000
SQLite allocated bytes: 368,640
Elapsed: 1,956 ms
Bounded: false
```

### Remediation

- Added validated `MAX_REPOSITORIES_PER_USER` and `MAX_TOTAL_REPOSITORIES` settings.
- Default limits are 1,000 repositories per regular user and 10,000 repositories across the service.
- Invalid, zero, or negative values fail to secure defaults; configuration values have defensive maximum caps.
- Duplicate-name, per-user quota, global quota, and insertion checks now execute inside one SQLite `BEGIN IMMEDIATE` transaction, preventing concurrent requests from bypassing a check-then-insert boundary.
- Added an index on `repositories.created_by` for bounded owner-count queries.
- Existing repository records are never deleted by this fix. Only new creation is rejected after a limit is reached.
- Activity records are written only for successful repository creation.

### Patched PoC

```text
Configuration: MAX_REPOSITORIES_PER_USER=50, MAX_TOTAL_REPOSITORIES=100
Attempts: 1,000
Accepted requests: 50
Rejected requests: 950
Repository rows: 50
Limit message visible: true
SQLite allocated bytes: 122,880
Elapsed: 1,775 ms
Bounded: true
```

## Confirmed finding RD-2026-003: Consumed MFA recovery-code rows retained indefinitely

**Severity:** Medium
**Impact:** Persistent database growth; eventual availability degradation when repeatedly exercised
**Required access:** Account able to configure MFA, consume a recovery code, and regenerate recovery codes
**Primary CWE:** CWE-459, Incomplete Cleanup
**Related CWE:** CWE-770 and CWE-400 as the resource-exhaustion consequence
**CVE:** None assigned; this is an application-specific finding.

### Root cause

A successful recovery-code use changed `used_at` but retained the row. Recovery-code regeneration counted only unused rows, so it could continue creating new rows while every consumed row remained permanently stored. The behavior preserved one-time use but omitted cleanup of data no longer needed for authentication.

### Baseline PoC

The PoC called the same `createRecoveryCodes()` and `consumeRecoveryCode()` functions used by the MFA flow against an isolated SQLite database created from the supplied baseline.

```text
Consume-and-regenerate cycles: 5,000
Total recovery-code rows: 5,001
Active rows: 1
Retained consumed rows: 5,000
SQLite allocated bytes: 1,261,568
Elapsed: 1,840 ms
Bounded: false
```

### Remediation

- A successfully consumed recovery code is now deleted atomically instead of being marked and retained.
- The delete predicate still requires `used_at IS NULL`; a second use fails, preserving one-time semantics.
- Database startup removes legacy rows that already have `used_at` populated.
- Active unused codes are not removed.

### Patched PoC

```text
Consume-and-regenerate cycles: 5,000
Total recovery-code rows: 1
Active rows: 1
Retained consumed rows: 0
SQLite allocated bytes: 114,688
Elapsed: 1,542 ms
Bounded: true
```

## Supply-chain finding: Environment-specific lockfile tarball origins

**Classification:** Supply-chain portability and independent-verification defect; not assigned a CVE
**Original state:** 93 `resolved` entries referenced an environment-specific internal registry proxy
**Patched state:** 0 non-`registry.npmjs.org` `resolved` entries

The exact package versions and every existing `integrity` hash were preserved. Only the origin prefix was changed to the canonical public npm registry while retaining the same package tarball paths. A clean `npm ci --ignore-scripts --registry=https://registry.npmjs.org` completed successfully after the change.

Post-remediation lockfile validation:

```text
Installed package entries: 266
Non-canonical resolved URLs: 0
Missing integrity fields: 0
npm ls problems: 0
CycloneDX SBOM version: 1.5
SBOM components: 266
```

The generated [`recorddrive-security-sbom.cdx.json`](../sbom/recorddrive-security-sbom.cdx.json) uses canonical public-registry distribution URLs and contains no environment-specific internal host names.

## Actual CVE applicability validation

### CVE-2026-31988: yauzl malformed NTFS timestamp denial of service

- Advisory affected version: yauzl 3.2.0
- Fixed version: 3.2.1
- Project version: yauzl 3.4.0
- Status: Not affected

A crafted ZIP containing the malformed NTFS timestamp structure described by the advisory was processed through the installed package and RecordDrive's ZIP-preview path. The installed version completed safely and returned the DOS timestamp fallback:

```text
{"version":"3.4.0","status":"safe","modifiedAt":"1980-01-01T00:00:00.000Z"}
```

### CVE-2026-5079: Multer deeply nested multipart field denial of service

- Advisory affected versions: Multer 1.x before 2.2.0 and 3.0.0-alpha.1
- Fixed versions: 2.2.0 and 3.0.0-alpha.2
- Project version: Multer 2.2.0
- Status: Not affected

The project also configures `fieldNestingDepth: 0` and strict field, part, header, file-count, and file-size limits. Integration coverage sends a nested multipart field and verifies rejection without retained upload data.

### CVE-2026-5038: Multer incomplete cleanup of aborted uploads

- Advisory affected versions: Multer 2.x before 2.2.0
- Fixed version: 2.2.0
- Project version: Multer 2.2.0
- Status: Not affected

The custom upload storage additionally removes partial files when streaming, CSRF validation, multipart parsing, or quota enforcement fails. Existing tests verify cleanup behavior.

## Previously remediated finding revalidated

The supplied baseline already contained RD-2026-001, bounded audit-log retention mapped to CWE-770/CWE-400. Its PoC remains passing:

```text
Configuration: MAX_ACTIVITY_LOG_ENTRIES=1000
Attempts: 25,000
Retained activity rows: 962
SQLite page growth: 110,592 bytes
```

## Dependency and supply-chain validation

```text
npm audit --omit=dev --json
Production dependencies: 247
Development dependencies: 20
Total dependencies: 266
Known vulnerabilities: 0

npm outdated --json
Outdated direct dependencies: 0

npm ls --all
Dependency-tree problems: 0
```

`npm audit` reports known advisories available from the configured registry; it does not prove the absence of undisclosed defects. Direct advisory review and application-path PoCs were therefore performed for security-relevant packages.

`npm audit signatures` could not be completed because the execution environment failed DNS resolution for the Sigstore TUF endpoint (`EAI_AGAIN` for `tuf-repo-cdn.sigstore.dev`). This is an inconclusive network limitation, not evidence of a valid or invalid signature. Signature verification should be rerun in a network environment that can reach npm signing-key and Sigstore endpoints.

The retained Git history was scanned for selected private-key blocks and common AWS, GitHub, Slack, and similar token patterns; no matches were found. `git fsck --full` completed without errors.

## Runtime and regression validation

The Dockerfile uses Node.js 24.18.0. Validation was repeated with Node.js 24.18.0 rather than relying only on the host's older Node.js 22.16.0 runtime.

```text
Node.js: 24.18.0
npm run check: passed
npm run test:security: 4 passed, 0 failed
npm test: 34 passed, 0 failed
git diff --check: passed
```

The Node.js 24.18.0 test runtime was installed through the npm `node` distribution package because direct binary download was restricted by the analysis environment. Its reported runtime version was verified, but the official Node.js tarball checksum could not be compared to that npm-distributed binary. Production should continue using the Dockerfile's official Node.js image or another trusted Node.js distribution satisfying `package.json`.

## High-impact controls reviewed without a confirmed new vulnerability

- Authentication and MFA state, one-time code behavior, passkey options, rate limits, and session regeneration
- Administrator-access disablement and privilege invalidation
- Repository ownership and independent view/upload/download/delete permission enforcement
- CSRF handling, including multipart requests before destination-file creation
- Upload byte, file-count, repository, service, and in-flight reservation quotas
- Random exclusive file names, partial-file cleanup, owner-only modes, and `O_NOFOLLOW` use where supported
- Canonical path validation, traversal rejection, symbolic-link rejection, and protected-directory boundaries
- ZIP, XLSX, and PDF preview limits and output caps
- Parameterized SQLite statements and application-controlled SQL allowlists
- Escaped EJS output, JSON escaping, safe DOM text assignment, Helmet, and restrictive CSP
- TLS secret handling and authenticated encryption of TOTP secrets and temporary recovery-code bundles
- No child-process execution, shell construction, dynamic code evaluation, or server-side URL-fetch feature was found

No additional item in these areas met the evidence threshold for a confirmed vulnerability. Potentially suspicious patterns were not reported as vulnerabilities unless a reachable impact could be reproduced.

## Files changed or added in this review

- `.env.example`
- `README.md`
- `package-lock.json`
- `src/config.js`
- `src/database.js`
- `src/i18n.js`
- `src/routes/repositories.js`
- `src/security-service.js`
- `test/security-poc.test.js`
- `security-poc/repository-growth.mjs`
- `security-poc/recovery-code-retention.mjs`
- `docs/security/evidence/security-poc-guide.md`
- `docs/security/reports/2026-07-12-security-audit.md`
- `docs/security/reports/2026-07-12-security-review-summary.md`
- `docs/security/evidence/2026-07-12-security-poc-results.txt`
- `docs/security/sbom/recorddrive-security-sbom.cdx.json`

The `.git` directory and its original history are retained as explicitly required.

## Residual operational risks

- Uploaded content is not malware-scanned. Internet-facing deployments should quarantine and scan uploads and isolate complex preview parsers with CPU, memory, file, and wall-clock limits.
- Rate limits, sessions, and in-flight upload reservations are process-local. Multi-instance deployments require coordinated shared controls.
- Large repository, user, file, and administrative listings still need pagination and operational request timeouts for very large deployments.
- Database, audit, backup, temporary-file, and out-of-band filesystem growth still require host or volume quotas and monitoring.
- The Docker base image is version-tagged rather than digest-pinned. A deployment pipeline should resolve and approve a platform-specific digest, scan the final image, and refresh that digest through a controlled update process.
- A container-image vulnerability scanner was not available in this analysis environment.
- Retained Git history can contain deleted source and metadata. The final archive must remain in a trusted location.

## Authoritative references

- MITRE CWE-770: https://cwe.mitre.org/data/definitions/770.html
- MITRE CWE-459: https://cwe.mitre.org/data/definitions/459.html
- Multer CVE-2026-5079 advisory: https://github.com/expressjs/multer/security/advisories/GHSA-72gw-mp4g-v24j
- Multer CVE-2026-5038 advisory: https://github.com/advisories/GHSA-3p4h-7m6x-2hcm
- yauzl CVE-2026-31988 advisory: https://github.com/advisories/GHSA-gmq8-994r-jv83
- npm dependency-audit documentation: https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities/
- npm registry-signature verification: https://docs.npmjs.com/verifying-registry-signatures/
- Node.js 24.18.0 release: https://nodejs.org/en/blog/release/v24.18.0
