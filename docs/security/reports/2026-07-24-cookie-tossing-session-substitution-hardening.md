# RecordDrive Cookie-Tossing Session-Substitution Hardening — 2026-07-24

## Executive summary

A deployment-dependent, High-impact confidentiality weakness was confirmed in the supplied RecordDrive 2.0.8 snapshot. External HTTPS deployments used the ordinary cookie name `recorddrive.sid`. A user who controls a sibling subdomain and has a valid RecordDrive account can place their own valid signed session cookie on the parent domain with a more-specific path such as `/repositories`. Browsers commonly send that cookie before RecordDrive's host-only root-path cookie, and the `express-session` parsing path selects the first duplicate name. The victim's repository requests are then evaluated in the attacker's authenticated session.

This is session substitution/login CSRF, not theft of the victim's session identifier. Its confidentiality impact arises when the victim is led to an attacker-owned repository and uploads a confidential file: the page and CSRF token are rendered in the attacker's valid session, so the upload is stored in the attacker's account. `SameSite=Strict`, `Secure`, and `HttpOnly` do not prevent a same-site sibling host from setting a parent-domain cookie with a known attacker-owned session value.

RecordDrive 2.0.9 uses browser-enforced `__Host-` cookie invariants for every externally reachable or production deployment:

- session cookie: `__Host-recorddrive.sid`
- anonymous login CSRF cookie: `__Host-recorddrive.csrf`
- mandatory `Secure`
- mandatory `Path=/`
- no `Domain` attribute

Loopback HTTP development keeps the legacy names because `__Host-` cookies require a secure origin. Existing external sessions are intentionally invalidated by the cookie-name transition and users must sign in again after upgrade.

## Preconditions and impact boundary

The confirmed attack requires all of the following:

1. RecordDrive is hosted below a registrable domain, for example `drive.example.com`.
2. The attacker controls another host below the same site, for example `files.example.com`, through delegation, compromise, or subdomain takeover.
3. The attacker can authenticate to RecordDrive and obtain their own valid signed session cookie.
4. The victim visits an attacker-chosen RecordDrive repository URL and performs an action such as uploading a confidential file.

The weakness does not let the sibling host calculate RecordDrive's signing secret or directly read the victim's host-only cookie. It lets the attacker supply a different, valid application session that takes precedence for selected paths. That distinction is important for incident analysis, but it does not reduce the confidentiality impact of files deliberately uploaded by the victim under the substituted identity.

## Root cause

The browser cookie model permits cookies with the same name to coexist when their Domain or Path differs. RFC6265bis describes common retrieval ordering as longer paths before shorter paths. RecordDrive used a generic session-cookie name and therefore did not ask the browser to enforce host-only, whole-host scope.

`express-session` 1.19.0 reads the `Cookie` header through the `cookie` package. The parser assigns a duplicate name only once, so the first matching value is retained. The attacker's valid cookie is therefore accepted before the victim's valid cookie when the browser places the more-specific path first.

The anonymous login CSRF cookie also used a generic name and a `/login` path. It was not the primary repository disclosure primitive, but the same sibling-domain trust boundary applied, so it was hardened in the same change.

## Browser-backed PoC

The Chromium reproduction used two cookies for `https://app.example.test/repositories/42/upload`:

- attacker cookie: `recorddrive.sid=attacker-session; Domain=example.test; Path=/repositories; Secure; HttpOnly; SameSite=Strict`
- victim cookie: `recorddrive.sid=victim-session; Path=/; Secure; HttpOnly; SameSite=Strict`

Chromium 144 returned the attacker cookie first. The deterministic server-parser model then selected `attacker-session`, matching the behavior of the dependency versions pinned by this project.

When the attacker cookie was renamed to `__Host-recorddrive.sid` but retained `Domain=example.test` and `Path=/repositories`, Chromium rejected it with `Invalid cookie fields`. A valid host-only `__Host-recorddrive.sid` cookie with `Path=/` remained the only cookie returned for the target request.

Evidence:

- [`2026-07-24-cookie-tossing-browser-results.json`](../evidence/2026-07-24-cookie-tossing-browser-results.json)
- [`2026-07-24-cookie-tossing-model-results.json`](../evidence/2026-07-24-cookie-tossing-model-results.json)
- [`cookie-tossing-chromium.py`](../../../security-poc/cookie-tossing-chromium.py)
- [`cookie-tossing-session-substitution.mjs`](../../../security-poc/cookie-tossing-session-substitution.mjs)

## Remediation

- Centralize security-cookie names and attributes in `src/cookie-security.js`.
- Select `__Host-` names whenever runtime confidentiality policy requires HTTPS.
- Set the session cookie's Path explicitly to `/`; omit Domain everywhere.
- Set the anonymous login CSRF cookie's Path to `/` and use the same externally enforced prefix.
- Use the centralized clearing helper at absolute session expiry, administrator-session blocking, and logout.
- Expire the legacy host-only session cookie during external logout/expiry as a migration courtesy. Parent-domain legacy cookies cannot be deleted by the application, but the application no longer reads them.
- Add dependency-free regression tests for cookie names, attributes, CSRF emission, and centralized usage.
- Update production integration assertions and bump the package version to 2.0.9.

## Validation

- Chromium-backed cookie storage/retrieval PoC: passed.
- Deterministic vulnerable/patched parser model: passed.
- New focused cookie-prefix tests: 5 passed.
- Related Host, repository-name, Docker-context, and safe request-error tests: 18 passed.
- Syntax validation: 104 JavaScript module/script files passed `node --check`.
- Full dependency installation and integration tests could not be completed because the configured package registry returned HTTP 503 for `zip-stream-4.1.1.tgz`. The available Node runtime was also 22.16.0, below the project's declared minimum 22.23.0. No failed application assertion was observed; the unexecuted tests remain an environment limitation.

## Deployment note

After deploying 2.0.9 to an external or production service, all users should expect one forced sign-in because the server no longer accepts the legacy session-cookie name. Do not create proxy rules that rewrite `Set-Cookie` attributes or strip the `__Host-` prefix. The public application must remain HTTPS-only.

## Residual risk

`__Host-` does not bind cookies to a TCP port and does not protect against script execution or server compromise on the exact RecordDrive origin. Sibling applications remain same-site for SameSite calculations, so every state-changing endpoint must continue to use RecordDrive's CSRF controls. The existing exact Host allowlist, HTTPS fail-closed policy, session rotation, and live authorization checks remain necessary defense layers.

## Standards and implementation references

- [IETF HTTP State Management Mechanism, cookie retrieval ordering and `__Host-` prefix](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis-22)
- [IETF OAuth 2.0 for Browser-Based Applications, cookie security and subdomain session-fixation guidance](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps-26#section-6.1.3.2)
- [express-session 1.19.0 cookie lookup implementation](https://github.com/expressjs/session/blob/v1.19.0/index.js)
- [jshttp/cookie 0.7.2 duplicate-name parsing behavior](https://github.com/jshttp/cookie/blob/v0.7.2/index.js)
