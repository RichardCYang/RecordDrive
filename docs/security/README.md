# RecordDrive Security Documentation

This directory is the canonical index for RecordDrive security reports, validation evidence, proof-of-concept guidance, the software bill of materials, and third-party security notices. All human-readable documentation is maintained in English.

## Directory map

| Directory | Contents |
| --- | --- |
| [`reports/`](reports/) | Dated audits, confidentiality reviews, remediation records, and parser security reviews |
| [`evidence/`](evidence/) | Reproduction instructions and exact proof-of-concept results |
| [`sbom/`](sbom/) | CycloneDX software bill of materials |
| [`notices/`](notices/) | Third-party license and security notices |

## Recommended reading order

1. Start with the [2026-07-12 security review summary](reports/2026-07-12-security-review-summary.md).
2. Use the [full 2026-07-12 audit](reports/2026-07-12-security-audit.md) for evidence, methodology, and residual risks.
3. Read the confidentiality reviews in chronological order:
   - [2026-07-20 confidentiality review](reports/2026-07-20-confidentiality-review.md)
   - [2026-07-21 final hardening pass](reports/2026-07-21-confidentiality-final-hardening.md)
   - [2026-07-21 confidentiality follow-up](reports/2026-07-21-confidentiality-follow-up.md)
   - [2026-07-21 reverse-proxy review](reports/2026-07-21-reverse-proxy-review.md)
4. Read the [2026-07-22 request-error log confidentiality hardening](reports/2026-07-22-request-error-log-confidentiality-hardening.md) for raw parser-body logging, the local PoC, and sanitized request-error handling.
5. Read the [2026-07-22 Host header and DNS rebinding hardening](reports/2026-07-22-host-header-dns-rebinding-hardening.md) for the loopback-origin boundary, local PoC, and exact Host allowlist.
6. Read the [2026-07-22 session-payload confidentiality hardening](reports/2026-07-22-session-payload-confidentiality-hardening.md) for encrypted server-side sessions, data minimization, and externally reachable WebAuthn configuration.
7. Read the [2026-07-22 initial-password confidentiality hardening](reports/2026-07-22-initial-password-confidentiality-hardening.md) for forced temporary-password replacement and session revocation.
8. Read the [2026-07-22 authentication rate-limit concurrency review](reports/2026-07-22-authentication-rate-limit-race.md) for the parallel-attempt PoC and remediation.
9. Read the [2026-07-22 session-revocation race hardening](reports/2026-07-22-session-revocation-race-hardening.md) for delayed `touch()` session resurrection, the tombstone design, and regression evidence.
10. Read the [2026-07-23 tombstone-expiry hardening](reports/2026-07-23-confidentiality-tombstone-expiry-hardening.md) for the residual delayed-`touch()` resurrection after tombstone cleanup, update-only touch semantics, absolute-lifetime enforcement, and regression evidence.
11. Read the [2026-07-23 in-flight disclosure revocation hardening](reports/2026-07-23-in-flight-disclosure-revocation-hardening.md) for permission/session revocation during active downloads and PDF previews, the bounded protected file pump, and before/after PoC.
12. Read the [2026-07-23 generated-preview disclosure revocation hardening](reports/2026-07-23-generated-preview-disclosure-revocation-hardening.md) for the residual one-shot XLSX/ZIP/7z JSON response gap, bounded protected buffer streaming, and reproducible PoC.
13. Read the [2026-07-23 live session-state disclosure revocation hardening](reports/2026-07-23-session-state-disclosure-revocation-hardening.md) for encrypted session identity binding and absolute-timeout enforcement during active responses.
14. Read the [2026-07-23 MFA sensitive material disclosure hardening](reports/2026-07-23-mfa-sensitive-material-disclosure-hardening.md) for the password-verification expiry gap affecting pending TOTP seeds and newly generated recovery codes.
15. Read the [7z preview security review](reports/2026-07-21-seven-zip-preview-review.md) for archive-parser design boundaries and residual risks.

## Report index

| Date | Document | Primary purpose |
| --- | --- | --- |
| 2026-07-23 | [MFA sensitive material disclosure hardening](reports/2026-07-23-mfa-sensitive-material-disclosure-hardening.md) | TOTP enrollment-secret and recovery-code disclosure after password-verification expiry, deterministic PoC, fail-closed expiry binding, and regression validation |
| 2026-07-23 | [Live session-state disclosure revocation hardening](reports/2026-07-23-session-state-disclosure-revocation-hardening.md) | Current encrypted session identity and absolute lifetime enforcement during active downloads/previews, PoC, and fail-closed regression coverage |
| 2026-07-23 | [Generated-preview disclosure revocation hardening](reports/2026-07-23-generated-preview-disclosure-revocation-hardening.md) | Active XLSX/ZIP/7z JSON confidentiality after permission or session revocation, protected buffer pump, PoC, and regression validation |
| 2026-07-23 | [In-flight disclosure revocation hardening](reports/2026-07-23-in-flight-disclosure-revocation-hardening.md) | Active download/PDF confidentiality after permission or session revocation, current-state authorizer, bounded file pump, PoC, and regression validation |
| 2026-07-23 | [Confidentiality tombstone-expiry hardening](reports/2026-07-23-confidentiality-tombstone-expiry-hardening.md) | Revoked-session resurrection after tombstone expiry, update-only touch semantics, absolute-lifetime persistence enforcement, PoC, and regression validation |
| 2026-07-22 | [Request-error log confidentiality hardening](reports/2026-07-22-request-error-log-confidentiality-hardening.md) | Raw parser-body credential exposure through logs, safe error records, correct 400-series handling, and local PoC |
| 2026-07-22 | [Host header and DNS rebinding hardening](reports/2026-07-22-host-header-dns-rebinding-hardening.md) | Strict pre-session Host validation, loopback-origin protection, exact external allowlist, and local PoC |
| 2026-07-22 | [Initial-password confidentiality hardening](reports/2026-07-22-initial-password-confidentiality-hardening.md) | Forced replacement of administrator-issued temporary passwords, protected-route blocking, and active-session revocation |
| 2026-07-22 | [Session-payload confidentiality hardening](reports/2026-07-22-session-payload-confidentiality-hardening.md) | AES-GCM session payload storage, secret-field query minimization, and explicit external WebAuthn relying-party settings |
| 2026-07-22 | [Session-revocation race hardening](reports/2026-07-22-session-revocation-race-hardening.md) | Revoked-session resurrection through delayed `touch()`, expiring tombstones, PoC, and regression validation |
| 2026-07-22 | [Authentication rate-limit concurrency review](reports/2026-07-22-authentication-rate-limit-race.md) | Parallel password, MFA, and security-reauthentication throttling bypass and remediation |
| 2026-07-21 | [Confidentiality follow-up](reports/2026-07-21-confidentiality-follow-up.md) | User-directory disclosure, external error-detail exposure, and session-store hardening |
| 2026-07-21 | [Reverse-proxy confidentiality review](reports/2026-07-21-reverse-proxy-review.md) | Loopback services exposed through trusted reverse proxies |
| 2026-07-21 | [Final confidentiality hardening pass](reports/2026-07-21-confidentiality-final-hardening.md) | Deployment defaults, HTTPS fail-closed behavior, template-local secret exposure, and build integrity |
| 2026-07-21 | [Pure-JavaScript 7z preview review](reports/2026-07-21-seven-zip-preview-review.md) | Parser threat model, isolation, validation, and residual risk |
| 2026-07-20 | [Confidentiality deep-dive review](reports/2026-07-20-confidentiality-review.md) | Sessions, uploaded-file rendering, parser execution, and participant-data exposure |
| 2026-07-12 | [Security audit](reports/2026-07-12-security-audit.md) | Availability findings, supply-chain review, CVE applicability, and validation |
| 2026-07-12 | [Security review summary](reports/2026-07-12-security-review-summary.md) | Executive overview of the 2026-07-12 audit |

## Evidence and supporting artifacts

| Artifact | Purpose |
| --- | --- |
| [2026-07-23 MFA sensitive material disclosure results](evidence/2026-07-23-mfa-sensitive-material-disclosure-results.txt) | Exact vulnerable-model and patched disclosure-expiry PoC output, focused tests, dependency limitations, Git-history scan, and final `.git` integrity verification |
| [2026-07-23 live session-state disclosure revocation results](evidence/2026-07-23-session-state-disclosure-revocation-results.txt) | Exact original and patched session-payload identity/absolute-expiry PoC output, focused tests, limitations, and integrity verification |
| [2026-07-23 generated-preview disclosure revocation results](evidence/2026-07-23-generated-preview-disclosure-revocation-results.txt) | Exact one-shot baseline and protected-buffer permission/session revocation output, focused tests, limitations, and final integrity results |
| [2026-07-23 in-flight disclosure revocation results](evidence/2026-07-23-in-flight-disclosure-revocation-results.txt) | Exact authorize-once baseline and patched permission/session revocation output, focused tests, limitations, and final integrity results |
| [Security PoC guide](evidence/security-poc-guide.md) | Local reproduction and regression commands |
| [2026-07-23 confidentiality audit results](evidence/2026-07-23-confidentiality-audit-results.txt) | Exact original and patched tombstone-expiry PoC output, focused tests, limitations, and final integrity results |
| [2026-07-22 request-error log confidentiality results](evidence/2026-07-22-request-error-log-confidentiality-results.txt) | Exact vulnerable-model and hardened logger output plus focused test result |
| [2026-07-22 Host header/DNS rebinding PoC results](evidence/2026-07-22-host-header-dns-rebinding-results.txt) | Exact baseline and patched authority-boundary output |
| [2026-07-22 Host header validation results](evidence/2026-07-22-host-header-validation-results.txt) | Syntax, focused tests, static assertions, dependency limitation, and `.git` integrity result |
| [2026-07-22 session-revocation race results](evidence/2026-07-22-session-revocation-race-results.txt) | Exact vulnerable and hardened delayed-`touch()` output plus focused regression results |
| [2026-07-22 authentication rate-limit PoC results](evidence/2026-07-22-authentication-rate-limit-race-results.txt) | Exact pre- and post-remediation concurrency output |
| [2026-07-12 PoC results](evidence/2026-07-12-security-poc-results.txt) | Exact baseline and post-remediation outputs |
| [CycloneDX SBOM](sbom/recorddrive-security-sbom.cdx.json) | Machine-readable dependency inventory |
| [7z parser third-party notices](notices/third-party-seven-zip-parser-notices.md) | License and local-fork notice |

The executable proof-of-concept scripts remain in the repository-root `security-poc/` directory because they are source utilities, not documentation artifacts.

## Documentation conventions

- Use date-first, lowercase filenames: `YYYY-MM-DD-topic.md`.
- Use one H1 title per Markdown document and a consistent H2/H3 hierarchy.
- Keep exact evidence separate from narrative reports.
- Preserve historical findings; add cross-links when a later report supersedes or supplements an earlier one.
- Update this index whenever a security document is added, renamed, or archived.

These conventions follow [GitHub's documentation style guidance](https://docs.github.com/en/contributing/style-guide-and-content-model/style-guide) and [OWASP's secure-development lifecycle guidance](https://devguide.owasp.org/en/02-foundations/02-secure-development/).
