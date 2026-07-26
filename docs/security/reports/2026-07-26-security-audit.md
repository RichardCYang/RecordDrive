# RecordDrive security audit and remediation — 2026-07-26

## Scope

- Static review of authentication, authorization, session handling, CSRF/host-header boundaries, uploads, previews, archives, storage paths, and the SMB sidecar/synchronizer.
- Local proof-of-concept validation of SMB hard-link quota behavior.
- Lockfile and direct-dependency review against current public advisories available on the audit date.

## Remediated findings

### High — SMB in-place growth bypassed configured storage quotas

The SMB projection used a hard link to the canonical stored file. Growing an existing file through SMB changed the canonical inode immediately. The same-inode reconciliation branch then copied the new size into SQLite without calling the quota validator. A repository SMB user could therefore exceed the per-file, repository-storage, or service-wide storage limits and consume host disk space.

**Fix:** the same-inode growth path now runs the existing quota validator. Rejected growth is truncated back to the last committed database size and logged as `SMB_REJECT_FILE_QUOTA`. A regression test reproduces the original 64-byte to 2,112-byte bypass and verifies rollback to 64 bytes.

### High — SMB transport encryption was optional and TCP 445 was broadly exposed by default

The bundled Samba configuration used `smb encrypt = desired`, which allowed clients without encryption support to connect without encrypted transport, while Docker Compose published TCP 445 on every host interface by default.

**Fix:** the sidecar now requires SMB 3.x (`SMB3_00` minimum), mandatory signing, and required SMB transport encryption. Compose binds TCP 445 to `127.0.0.1` unless an administrator explicitly selects a trusted LAN interface.

### Medium — SMB projection enumeration was not memory-bounded

The synchronizer used `readdirSync` and accumulated every projection entry before applying limits. An authenticated SMB user could create a very large number of entries and force excessive memory use.

**Fix:** scanning now streams entries with `opendirSync` and aborts at `SMB_SYNC_MAX_SCANNED_ENTRIES` (default 20,000; configured range 1,000–1,000,000).

## Dependency observations

- `multer` is locked at 2.2.0 and the upload route sets `fieldNestingDepth: 0`, matching the currently published remediation requirements for the 2026 Multer advisories.
- `yauzl` is locked at 3.4.0, newer than the 3.2.1 correction for CVE-2026-31988.
- The package-registry audit endpoint returned HTTP 503 during this review, so a complete live `npm audit` result could not be obtained. The lockfile was reviewed and current high-signal advisories for direct security-sensitive dependencies were checked separately.

## Residual operational risk

The SMB projection is still a hard-link design, so an SMB write changes the canonical inode before the periodic reconciler runs. The patch restores an oversized append on the next pass, but a client could temporarily allocate disk space within the reconciliation interval. Deploy SMB only on a trusted network, retain host-level free-space monitoring/reservations, and use a dedicated filesystem quota where strong instantaneous disk-exhaustion prevention is required.

## Verification

- JavaScript syntax check passes.
- SMB synchronization tests pass, including the new quota-bypass and scan-cap regression tests.
- Static sidecar security tests pass.
- The final archive creation process compares every `.git/` ZIP entry, content byte, mode, timestamp, compression attribute, and external attribute against the original archive.
