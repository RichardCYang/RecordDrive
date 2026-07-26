# 2026-07-26 SMB rename+growth security evidence

- `smb-rename-growth-original.json`: vulnerable source result. A 64-byte hard-linked file became 2,112 bytes, the DB accepted 2,112 bytes, and no quota rejection was logged.
- `smb-rename-growth-remediated.json`: fixed source result. The pre-reconcile file reached 2,112 bytes, then the reconciler restored both links and the DB to 64 bytes and logged one rejection.
- `targeted-smb-regression-tests.txt`: SMB settings, sidecar, and synchronization regression results.
- `smb-entrypoint-crlf-original.txt`: original POSIX shell parse failure caused by CRLF line endings.
- `npm-audit-limitations.txt`: package-registry limitation.
- `full-test-limitations.txt`: full-suite dependency/runtime limitation.
