# RecordDrive Security Documentation

This directory is the single location for RecordDrive security reports, validation evidence, proof-of-concept guidance, and the software bill of materials. All documentation in this directory is maintained in English.

## Reports

- [`SECURITY_CONFIDENTIALITY_REVIEW_2026-07-21_REVERSE_PROXY.md`](SECURITY_CONFIDENTIALITY_REVIEW_2026-07-21_REVERSE_PROXY.md) — Follow-up confidentiality review and remediation for loopback-bound services published through a trusted reverse proxy.
- [`SECURITY_CONFIDENTIALITY_REVIEW_2026-07-21_FINAL.md`](SECURITY_CONFIDENTIALITY_REVIEW_2026-07-21_FINAL.md) — Final confidentiality hardening pass covering deployment defaults, HTTPS fail-closed behavior, template-local secret exposure, and release integrity.
- [`SEVEN_ZIP_PURE_JAVASCRIPT_PREVIEW_2026-07-21.md`](SEVEN_ZIP_PURE_JAVASCRIPT_PREVIEW_2026-07-21.md) — Design, threat model, validation, and residual-risk review for the external-executable-free 7z metadata parser.

- [`SECURITY_CONFIDENTIALITY_REVIEW_2026-07-20.md`](SECURITY_CONFIDENTIALITY_REVIEW_2026-07-20.md) — Confidentiality-focused deep-dive review and remediation report dated 2026-07-20.
- [`SECURITY_AUDIT_2026-07-12.md`](SECURITY_AUDIT_2026-07-12.md) — Full security audit, findings, remediation details, dependency review, validation, and residual risks dated 2026-07-12.
- [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) — Concise executive summary of the 2026-07-12 audit.

## Evidence and supporting artifacts

- [`SECURITY_POC_RESULTS.txt`](SECURITY_POC_RESULTS.txt) — Exact baseline and post-remediation proof-of-concept results.
- [`SECURITY_POC_GUIDE.md`](SECURITY_POC_GUIDE.md) — Commands for reproducing the local proof-of-concept and regression checks from the repository root.
- [`SECURITY_SBOM.cdx.json`](SECURITY_SBOM.cdx.json) — CycloneDX 1.5 software bill of materials.
- [`THIRD_PARTY_7Z_PARSER_NOTICES.md`](THIRD_PARTY_7Z_PARSER_NOTICES.md) — License and fork notice for the JavaScript 7z parser dependencies.

The executable PoC scripts remain in the repository-root `security-poc/` directory because they are source utilities rather than reports.
