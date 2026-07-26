# 2026-07-26 deep security review evidence

This directory contains local-only reproduction and validation evidence for the follow-up review.

- `smb-pre-reconcile-quota-window-poc.txt`: demonstrates physical disk allocation before periodic SMB quota reconciliation and the patched default write gate.
- `archive-preview-tree-amplification-poc.json`: demonstrates archive-path tree amplification and the patched unique-node ceiling.
- `targeted-regression-tests.txt`: focused regression test output (23/23 passing).
- `syntax-validation.txt`: JavaScript, shell, and JSON syntax validation.
- `full-test-attempt.txt`: complete Node test attempt; 73 tests passed and 20 test files failed to load solely because the isolated environment could not install runtime packages such as `supertest`, `express`, `exceljs`, and `otplib`.
- `static-pattern-scan.txt`: targeted source-pattern triage used during manual review. Matches are review leads, not vulnerability assertions.
- `git-integrity.txt`: generated after packaging and records the exact `.git` preservation checks.
- `archive-integrity.txt`: generated after packaging and records ZIP structure/content checks.

The PoCs operate only on temporary local directories and do not contact external systems.
