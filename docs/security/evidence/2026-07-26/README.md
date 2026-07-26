# 2026-07-26 security audit evidence

- `smb-quota-bypass-original.json`: deterministic PoC result against the original source.
- `smb-quota-remediated.json`: the same PoC after remediation.
- `targeted-smb-regression-tests.txt`: targeted Node test output for SMB settings, sidecar policy, quota rollback, and scan-limit behavior.
- `javascript-check.txt`: package syntax-check output.
- `dependency-validation-limitations.txt`: environment and registry limitations that prevented a complete dependency install/audit.

The executable regression coverage is in `test/smb-sync.test.js` and `test/smb-sidecar-security.test.js`.
