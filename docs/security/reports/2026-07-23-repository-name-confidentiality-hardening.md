# Repository-name confidentiality hardening

## Executive summary

A manual confidentiality review identified one reproducible cross-tenant metadata disclosure in repository creation. The legacy database schema enforced repository names as globally unique. Any authenticated regular user who could create a repository could submit a candidate name and distinguish an existing repository owned by another user from an unused name by observing the duplicate-name response. Repository names can contain customer, matter, project, or incident identifiers, so they must be treated as tenant-scoped metadata.

The issue was remediated by replacing global case-insensitive uniqueness with an owner-scoped case-insensitive unique index. Existing databases are migrated at startup while preserving repository IDs, dependent permission rows, file rows, timestamps, quotas, and foreign-key integrity. The create path now checks duplicates only in the current owner's namespace.

No new Critical or High-severity direct file-disclosure path was reproduced during this pass. The confirmed finding is rated **Medium** because it requires an authenticated regular account and reveals repository-name existence rather than file contents.

## Finding

| ID | Severity | Status | Title |
| --- | --- | --- | --- |
| RD-C-2026-001 | Medium | Fixed | Cross-tenant repository-name existence oracle |

### Affected behavior

The legacy schema declared `repositories.name` as `UNIQUE COLLATE NOCASE`, and the repository-creation transaction queried every repository by name before inserting. This created an observable distinction:

- unused candidate: repository creation succeeded;
- another user's candidate: repository creation failed with the duplicate-name message.

The attacker did not need view permission on the target repository. Repeated candidate testing could therefore disclose sensitive naming metadata across otherwise isolated user boundaries.

### Reproduction

Run the self-contained model and migration PoC:

```bash
node security-poc/repository-name-enumeration-poc.mjs
```

Run the regression test:

```bash
node --test test/repository-name-confidentiality.test.js
```

The PoC uses an in-memory SQLite database and synthetic names only. It does not access production data.

### Remediation

The patch makes these changes:

1. New databases no longer place a global unique constraint on `repositories.name`.
2. `idx_repositories_owner_name` enforces case-insensitive uniqueness for `(created_by, name)` only when `created_by` is not null.
3. Startup detects the legacy global constraint and rebuilds the table inside an immediate transaction with foreign-key enforcement temporarily disabled only for the controlled schema replacement.
4. The migration checks foreign-key integrity before, during, and after the replacement and restores the original foreign-key setting.
5. Repository creation checks duplicate names only for the authenticated creator and maps uniqueness races to the same owner-local duplicate error.
6. Focused tests verify retained permission/file references, retained repository IDs, retained AUTOINCREMENT sequence behavior, owner-local case-insensitive uniqueness, cross-owner same-name creation, and idempotent startup migration.

### Changed files

- `src/database.js`
- `src/repository-name-security.js`
- `src/repository-creation.js`
- `src/routes/repositories.js`
- `test/repository-name-confidentiality.test.js`
- `security-poc/repository-name-enumeration-poc.mjs`
- `package.json`
- this report and its evidence file

## Broader confidentiality review

The review also traced the following high-value boundaries:

- repository and file object-level authorization;
- active download and preview revocation;
- generated ZIP, 7z, and XLSX preview disclosure;
- encrypted server-side session identity and absolute expiry;
- password, TOTP, recovery-code, and passkey authentication state;
- Host-header and externally reachable deployment boundaries;
- upload storage path canonicalization and no-follow file opens;
- parser-error and application-error logging;
- TLS private-key passphrase storage;
- EJS output escaping and uploaded-file rendering boundaries.

No new direct unauthorized file-content disclosure was reproduced in those paths. Existing focused PoCs for generated-preview revocation, Host rejection, authentication throttling, MFA sensitive-material expiry, and safe request-error logging continued to report blocked/pass outcomes.

## Dependency and supply-chain review

The lockfile resolves public packages through the npm registry and the project-specific `xz-compat` fork through the checked-in `vendor/` directory. Registry package records carry integrity hashes. A targeted advisory review confirmed:

- Multer `2.2.0` is the patched release for the 2026 incomplete-aborted-upload cleanup and nested-field denial-of-service advisories.
- Yauzl `3.4.0` is not the specifically affected `3.2.0` release in CVE-2026-31988; that advisory was fixed in `3.2.1`.

The npm registry was unreachable from the audit sandbox (`EAI_AGAIN`), so a fresh `npm ci`, `npm audit`, and the dependency-backed full integration suite could not be completed here. This limitation does not affect the self-contained migration PoC or focused tests, but dependency-backed tests should be rerun in CI or a network-enabled environment.

## Validation summary

- repository-name PoC: vulnerable behavior reproduced; patched behavior blocked the oracle;
- repository-name regression tests: 2 passed;
- dependency-free confidentiality regression selection: 19 passed;
- JavaScript syntax checks: 135 files passed;
- focused existing PoCs: authentication throttling bounded, generated previews terminated after revocation, hostile Host rejected before session establishment, MFA material expired, request-error secret logging blocked;
- Git-history secret-pattern scan: no unexpected credential or private-key finding in the copied repository history;
- `.git` handling: audit and packaging verification use hashes and ZIP-entry comparisons without modifying or deleting the supplied `.git` directory.

Exact command output is recorded in `docs/security/evidence/2026-07-23-repository-name-confidentiality-results.txt`.

## Residual risks

1. Sharing by exact username necessarily lets a repository owner determine whether a guessed username is grantable. Eliminating that signal requires a product-level invitation or administrator-mediated sharing workflow.
2. Stored files rely on host filesystem permissions and deployment storage controls rather than application-layer file-content encryption. Disk-snapshot or host-compromise threats require encrypted storage and operational key management.
3. Authentication throttling state is process-local. Multi-process or multi-instance deployments should use a shared atomic rate-limit backend.
4. A successful source review and focused PoC set cannot prove absence of all vulnerabilities. Repeat the complete dependency-backed suite and dynamic testing in the deployment topology.

## References

- OWASP Authorization Cheat Sheet: deny by default and validate authorization on every request.
- OWASP API Security: object-level authorization for every client-supplied object identifier.
- GitHub Advisory GHSA-3p4h-7m6x-2hcm / CVE-2026-5038.
- GitHub Advisory GHSA-72gw-mp4g-v24j / CVE-2026-5079.
- GitHub Advisory GHSA-gmq8-994r-jv83 / CVE-2026-31988.
