# Host Header and DNS Rebinding Confidentiality Hardening

**Review date:** 2026-07-22  
**Scope:** RecordDrive 2.0.2 HTTP authority handling, loopback deployment boundary, sessions, and bootstrap authentication  
**Primary security property:** Confidentiality  
**Outcome:** One high-severity deployment-boundary flaw reproduced and remediated

## Executive summary

RecordDrive bound direct development listeners to loopback and reserved weak example credentials for that mode, but the request pipeline did not validate the HTTP `Host` authority. A browser origin controlled by an attacker could therefore become relevant if its DNS answer changed to a loopback address or another path caused the browser to reach the local listener while retaining an attacker-controlled `Host` value.

Before remediation, the first middleware after Helmet handled HTTPS enforcement and then static files, request bodies, language selection, and sessions. No code rejected an unrelated or ambiguous `Host`. In the most serious practical chain, a victim running RecordDrive locally with the documented example administrator password unchanged could visit an attacker-controlled origin, establish a same-origin session with the loopback service after rebinding, submit the login CSRF token and known example credentials, and read repository metadata or file content available to the administrator.

The remediation introduces strict authority parsing and an exact host allowlist before static files, body parsing, sessions, or authentication. Direct loopback development implicitly accepts only `localhost`, subdomains of `.localhost`, the canonical IPv4 loopback range, canonical IPv6 loopback, and explicitly configured names. Every externally reachable deployment now fails startup when `ALLOWED_HOSTS` is empty. Host names containing schemes, ports in configuration, wildcards, user information, path delimiters, control characters, duplicate header values, encoded or Unicode-confusable IP forms, or legacy numeric IPv4 forms are rejected.

## Finding RD-2026-07-22-02: arbitrary Host accepted by loopback service

**Severity:** High  
**Weaknesses:** CWE-346, Origin Validation Error; CWE-200, Exposure of Sensitive Information to an Unauthorized Actor  
**Attack class:** DNS rebinding / Host authority confusion

### Root cause

The original application relied on listener binding and HTTPS/proxy configuration as deployment boundaries, but it did not make the HTTP authority part of that boundary. Specifically:

1. The direct development listener defaulted to `127.0.0.1`.
2. Weak example bootstrap credentials were permitted only for direct loopback development.
3. The application accepted any syntactically usable `Host` value supplied by Node/Express.
4. Session and CSRF state could be established before any application-level host decision because no such decision existed.

Loopback binding prevents ordinary remote TCP connections, but it does not prove that a browser request reaching the listener belongs to a trusted web origin. The `Host` value must be validated independently.

### Confidentiality impact

An exploit required a victim browser to reach the loopback service under an attacker-controlled origin, commonly discussed as DNS rebinding, plus usable credentials or another authenticated browser state. The documented example administrator credentials materially increased impact when left unchanged during local development.

A successful chain could expose:

- Repository names, folder names, and uploaded-file metadata.
- Previewable file content.
- Downloadable stored files.
- User and permission information available to an administrator.

The issue did not make the listener directly reachable from the internet and did not bypass repository authorization by itself. It invalidated the assumption that “loopback-bound” also meant “same-origin trusted.”

## Safe local PoC

The local PoC is `security-poc/host-header-dns-rebinding.mjs`. It starts disposable loopback HTTP servers and never contacts a remote system. The baseline server intentionally models the original missing Host gate; the patched server calls the production `isRequestHostAllowed` implementation.

```bash
node security-poc/host-header-dns-rebinding.mjs
```

The PoC performs this sequence:

1. Connect to `127.0.0.1` while sending `Host: attacker.example`.
2. Request a login page and obtain a demonstration session cookie and CSRF token.
3. Submit the documented example credentials to the baseline model.
4. Confirm that the baseline returns a synthetic confidential repository marker.
5. Repeat against the patched policy and confirm HTTP 421 before a cookie is created.
6. Confirm that canonical `Host: localhost` remains functional.

Exact PoC output is stored in `docs/security/evidence/2026-07-22-host-header-dns-rebinding-results.txt`. Consolidated syntax, focused-test, static-analysis, dependency-installation, and `.git` integrity results are stored in `docs/security/evidence/2026-07-22-host-header-validation-results.txt`.

## Remediation

### Strict Host parser and early middleware

`src/middleware/host-header.js` now:

- Requires exactly one raw `Host` header.
- Parses bracketed IPv6 and optional request ports without trusting URL coercion.
- Rejects controls, whitespace, commas, user-information delimiters, slashes, backslashes, query/fragment delimiters, invalid ports, and unbracketed IPv6.
- Rejects legacy numeric IPv4 spellings such as `2130706433`, `0177.0.0.1`, `0x7f000001`, and `127.1`, plus percent-encoded and Unicode-confusable spellings, rather than allowing URL canonicalization to reinterpret them as loopback.
- Converts valid internationalized DNS names to ASCII and validates every label.
- Uses exact matches only; wildcard suffixes are unsupported by design.
- Returns HTTP 421 with `Cache-Control: no-store` for an untrusted authority.

`src/app.js` installs this middleware immediately after Helmet and before HTTPS enforcement, static content, body parsers, language processing, session creation, authentication, and all routes. Host rejection therefore cannot create an application session or expose route-specific response differences.

### Fail-closed deployment configuration

`src/config.js` parses `ALLOWED_HOSTS` at startup. `applyRuntimeConfidentialityPolicy` now requires at least one configured entry whenever a non-loopback listener or trusted reverse proxy makes the service externally reachable.

Configuration rules are intentionally narrow:

- Entries are comma-separated host names or IP literals.
- Schemes, ports, paths, user information, and wildcards are rejected.
- Request ports are ignored for matching so one public authority can serve configured HTTP-to-HTTPS transitions.
- `X-Forwarded-Host` is not used as a fallback. A trusted reverse proxy must overwrite the upstream `Host` header with an allowlisted public value.

`.env.example`, `docker-compose.yml`, the README, and the NGINX example document this boundary.

## Regression coverage

`test/host-header-confidentiality.test.js` verifies:

- Malformed and ambiguous authorities are rejected.
- Direct loopback mode accepts canonical loopback values and rejects unrelated hosts.
- Legacy decimal, octal, hexadecimal, shortened, percent-encoded, and Unicode-confusable IPv4 aliases are rejected.
- Externally reachable mode requires exact configured values.
- Wildcards and configuration entries containing ports are invalid.
- An untrusted Host receives HTTP 421 and does not advance to downstream middleware.

`test/security-hardening.test.js` adds an application-level assertion that a hostile Host receives 421 and no `Set-Cookie` header before the HTTPS-allowed login page is exercised.

## Validation results

- Focused Host parser and middleware tests: 5 passed, 0 failed.
- Combined dependency-free security and file-safety tests: 13 passed, 0 failed.
- Safe local baseline/patched PoC: passed.
- Syntax checks across project JavaScript sources: passed after remediation.
- Static source checks confirmed the supplied baseline had no Host middleware or `ALLOWED_HOSTS` policy.
- `.git` content and filesystem-mode hashes were captured before work and revalidated after patching and packaging.

The full dependency-backed integration suite and `npm audit` could not be executed in the isolated review environment because the configured package registry returned HTTP 503 while resolving locked transitive packages. The review host also provided Node.js 22.16.0, below the project's declared minimum security runtime. The focused controls described above use only built-in Node.js modules and were executed successfully.

## Additional confidentiality review results

No other new critical or high-severity confidentiality defect was confirmed in the reviewed code paths. Existing controls include:

- Repository-scoped file lookup and explicit permission checks on view, upload, download, delete, and administration actions.
- Generic not-found handling for unauthorized repository resources.
- Random stored names, canonical storage paths, no-follow file opening, symlink-ancestor rejection, and restrictive file modes.
- Bounded upload, PDF, ZIP, spreadsheet, and 7z preview processing.
- Encrypted and authenticated server-side sessions, session rotation, absolute expiry, and session revocation.
- Encrypted MFA secrets and TLS passphrases.
- HTTPS fail-closed behavior, exact proxy-trust configuration, secure cookies, CSRF protection, and authentication throttling.

These findings are based on source inspection and focused local verification, not a guarantee that no vulnerability remains.

## Residual risks and operational requirements

- Change `ADMIN_PASSWORD` and `SESSION_SECRET` even for local development when confidential data is stored.
- Set `ALLOWED_HOSTS` to every exact public name used by clients before enabling a reverse proxy or non-loopback listener.
- Ensure the proxy replaces, rather than appends or trusts, the upstream `Host` value.
- Browser vendors continue to evolve private-network and local-network access protections. Server-side authority validation remains necessary and should not be replaced by browser behavior assumptions.
- Complex preview parsers remain a patch-management and resource-governance risk despite the existing byte, row, entry, timeout, worker, and sandbox limits.
- Run the complete locked dependency suite and an audit in CI on a Node.js version permitted by `package.json`.

## Standards and references

- OWASP Web Security Testing Guide, Testing for Host Header Injection: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/17-Testing_for_Host_Header_Injection
- MITRE CWE-346, Origin Validation Error: https://cwe.mitre.org/data/definitions/346.html
- RFC 6761, Special-Use Domain Names (`localhost`): https://www.rfc-editor.org/rfc/rfc6761
