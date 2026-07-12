# RecordDrive Security Audit and Remediation Report

Review date: 2026-07-12  
Baseline Git commit: `40ea9e39b08f76704295a5923e637013e46c4a53`  
Application: RecordDrive 2.0.1  
Scope: Supplied Node.js file-server source, retained Git history, runtime configuration, authentication, authorization, sessions, CSRF, upload and download paths, archive and spreadsheet previews, SQLite storage, TLS handling, dependencies, tests, and deployment files.

## Executive summary

The supplied project already contained substantial security hardening. The review confirmed one additional application-specific availability weakness: authenticated actions could append audit records indefinitely because `activity_logs` had no retention boundary. A low-privileged repository owner could repeatedly invoke legitimate state-changing operations and cause persistent SQLite growth until the database volume was exhausted.

The weakness was reproduced against the supplied baseline, remediated with bounded retention, and re-tested. The fix does not remove current functionality: it preserves the newest audit records, trims only records older than the configured boundary, and supports an operator-defined limit.

No known vulnerable production dependency was reported by npm at review time. Actual third-party CVEs relevant to the installed upload and ZIP-preview packages were independently checked. The supplied versions are patched and the application includes additional defensive limits.

## Confirmed and remediated finding

### RD-2026-001: Unbounded audit-log persistence could exhaust database storage

**Severity:** Medium  
**Impact:** Availability  
**Required access:** Authenticated account able to perform a repeatable audited operation  
**Primary CWE:** CWE-770, Allocation of Resources Without Limits or Throttling  
**Parent category:** CWE-400, Uncontrolled Resource Consumption  
**CVE:** None assigned. This is a private application-specific finding and must not be given an invented CVE identifier.

#### Root cause

`logActivity()` inserted a new row into `activity_logs` for every audited operation. No row limit, age limit, archival policy, or deletion mechanism existed. File quotas did not cover SQLite growth, so repeatedly uploading and deleting small files, changing repository settings, or changing permissions could grow the database independently of the file-storage quotas.

#### PoC validation before the fix

The PoC exported Git commit `40ea9e3`, created an isolated temporary database, and called the same `logActivity()` function used by authenticated routes.

```text
Attempts: 25,000
Retained activity rows: 25,000
SQLite page growth: 2,469,888 bytes
```

Every generated record remained stored. Repeating the operation continued to increase the database, demonstrating persistent resource allocation without a boundary.

#### Remediation

The following controls were added:

- `MAX_ACTIVITY_LOG_ENTRIES` defines the maximum retained audit-record target and defaults to `100000`.
- Startup counts existing records and removes the oldest excess rows before serving requests.
- Runtime inserts track the retained row count and remove the oldest records in bounded batches when the configured limit is reached.
- The most recent records remain available; only the oldest records are aged out.
- Invalid, zero, or negative configuration values fail to the secure default rather than disabling retention.
- The configured maximum is capped at 10,000,000 records to prevent an accidental effectively-unbounded setting.

#### PoC validation after the fix

```text
Configuration: MAX_ACTIVITY_LOG_ENTRIES=1000
Attempts: 25,000
Retained activity rows: 962
SQLite page growth: 110,592 bytes
```

The retained count remained below the configured limit. Automated tests also verified that startup trims an existing oversized database, the oldest records are removed, the newest record remains, and continued inserts stay bounded.

## Actual CVE applicability validation

### CVE-2026-31988: yauzl NTFS timestamp parser denial of service

- Affected package version: yauzl 3.2.0
- Fixed version: 3.2.1
- CWE assigned by the advisory: CWE-193, Off-by-one Error
- Project version: yauzl 3.4.0
- Application status: Not affected

A crafted ZIP with a malformed four-byte NTFS timestamp extra field was processed against an isolated yauzl 3.2.0 installation. Calling `entry.getLastModDate()` reproduced a `RangeError` with `ERR_OUT_OF_RANGE`. The same input completed safely with the project's yauzl 3.4.0 and through RecordDrive's actual ZIP-preview path. The application also wraps timestamp parsing defensively so a malformed date does not terminate preview processing.

### CVE-2026-5079: Multer deeply nested multipart field denial of service

- Affected versions: Multer 1.x and versions earlier than 2.2.0 in the 2.x line
- Patched version: 2.2.0
- CWE assigned by the advisory: CWE-400
- Project version: Multer 2.2.0
- Application status: Not affected

The project uses the patched version and explicitly configures `fieldNestingDepth: 0`, one field, bounded field names, bounded field values, bounded parts, bounded header pairs, bounded file count, and bounded file size. Existing integration coverage sends a nested multipart field and verifies rejection without retaining a file.

### CVE-2026-5038: Multer incomplete cleanup of aborted uploads

- Affected versions: Multer versions earlier than 2.2.0 in the 2.x line
- Patched version: 2.2.0
- CWE assigned by the advisory: CWE-459, Incomplete Cleanup
- Project version: Multer 2.2.0
- Application status: Not affected

The project uses the patched version. Its custom storage engine also deletes partial files when streaming, quota enforcement, CSRF validation, or multipart parsing fails. Integration tests verify that rejected uploads do not leave orphan files.

### Node.js runtime security floor

Node.js 24.17.0 was a security release addressing multiple 2026 CVEs. The project requires Node.js `^22.23.0 || ^24.17.0 || ^26.3.1`, and the Dockerfile uses Node.js 24.18.0. The available review runtime was Node.js 22.16.0, below the declared production floor. Tests passed on that runtime, but production deployment must use a version allowed by `package.json`; the supplied Docker image satisfies this requirement.

## Previously hardened high-impact controls independently verified

The following controls were reviewed and exercised by existing regression tests:

- Production rejects plaintext application requests before static serving, body parsing, sessions, CSRF, or authentication processing.
- Session cookies use `HttpOnly`, `SameSite=Strict`, high priority, production `Secure`, rolling idle expiration, and a server-side absolute lifetime.
- Anonymous CSRF protection does not create persistent server-side sessions.
- Password, TOTP, recovery-code, and passkey flows use bounded state, session regeneration, replay protection, and rate limiting.
- Repository permissions are independently evaluated for view, upload, download, and file deletion.
- Repository deletion requires owner or enabled-administrator manager access and is not granted by delegated file-delete permission.
- Multipart CSRF validation occurs before destination-file creation.
- Uploads use randomized exclusive file names, owner-only modes, streaming quotas, partial-file cleanup, and `O_NOFOLLOW` where supported.
- Database and upload paths reject protected directories, filesystem roots, symbolic-link components, symbolic-link ancestors, and database placement inside the upload root.
- Stored-file opens validate repository identifiers and stored names, use descriptor-based checks, and reject non-regular files.
- XLSX and ZIP previews enforce compressed size, expansion, entry count, metadata, output, and concurrency limits.
- TLS passphrases, TOTP secrets, and temporary recovery-code bundles use authenticated encryption.
- EJS user values are escaped, Express JSON escaping is enabled, and browser DOM updates use safe text assignment.
- SQL user data is bound through SQLite parameters; dynamically selected clauses are application-controlled allowlists.
- No child-process execution, shell construction, dynamic code evaluation, or server-side URL-fetch feature was found.

## Dependency and supply-chain results

```text
npm audit --omit=dev
Production dependencies: 247
Total installed dependencies: 266
Known vulnerabilities: 0
```

Direct security-relevant versions verified:

```text
ejs 6.0.1
express 5.2.1
multer 2.2.0
yauzl 3.4.0
```

`npm ci --ignore-scripts` completed successfully. Git history was scanned for selected private-key blocks and common cloud or token patterns; no matches were found. `git fsck --full` completed without errors.

## Test results

```text
npm run test:security
2 passed, 0 failed

npm test
32 passed, 0 failed

node --check src/app.js
Passed

git diff --check
Passed
```

The security PoC suite includes the activity-log retention regression and the crafted ZIP used to validate CVE-2026-31988 handling in the real preview code path.

## Files changed or added

- `src/config.js`: added validated `MAX_ACTIVITY_LOG_ENTRIES` configuration.
- `src/database.js`: added startup and runtime audit-log retention.
- `.env.example`: documented the retention setting.
- `README.md`: documented the retention setting.
- `SECURITY_REVIEW.md`: recorded the new finding and updated validation and residual-risk text.
- `package.json`: added `npm run test:security`.
- `test/security-poc.test.js`: added deterministic security regression tests.
- `security-poc/activity-log-growth.mjs`: added a local temporary-database PoC.
- `security-poc/yauzl-cve-2026-31988.cjs`: added a local crafted-ZIP dependency comparison PoC.
- `security-poc/README.md`: added safe reproduction instructions.
- `SECURITY_POC_RESULTS.txt`: recorded the executed PoC and validation results.

## Residual operational risks

- Uploaded content is not malware-scanned. Internet-facing deployments should quarantine and scan files before release and isolate complex document parsing in constrained worker processes.
- Rate-limit state and in-flight quota reservations are process-local. Multi-instance deployments need coordinated rate limiting, shared quotas, shared sessions, networked data storage, and object storage.
- Repository, user, and administrative listings are not paginated and can become expensive at very large scale.
- Audit retention deliberately removes the oldest records. Environments requiring longer forensic history should export logs to an append-only external system before records age out.
- Host filesystem permissions and volume quotas remain necessary. Application path checks cannot protect against an attacker who already controls mount topology or writable parent directories as the service account.
- The retained `.git` directory contains full source history and must be protected as sensitive development material.

## Authoritative references

- CWE-770: https://cwe.mitre.org/data/definitions/770.html
- CWE-400: https://cwe.mitre.org/data/definitions/400.html
- CVE-2026-31988: https://nvd.nist.gov/vuln/detail/CVE-2026-31988
- yauzl fix commit: https://github.com/thejoshwolfe/yauzl/commit/c4695215b05c6adffda613b9051a2a85429b33fe
- CVE-2026-5079 advisory: https://github.com/expressjs/multer/security/advisories/GHSA-72gw-mp4g-v24j
- CVE-2026-5038 advisory: https://github.com/expressjs/multer/security/advisories/GHSA-3p4h-7m6x-2hcm
- Node.js 24.17.0 security release: https://nodejs.org/en/blog/release/v24.17.0
