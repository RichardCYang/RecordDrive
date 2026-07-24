# RecordDrive Trust-Proxy Hop-Count Confidentiality Hardening — 2026-07-24

## Executive summary

A High-severity, deployment-dependent confidentiality weakness was confirmed in the supplied 2.0.6 snapshot. RecordDrive accepted positive numeric `TRUST_PROXY` values such as `1`, recommended that form in `.env.example`, and used Express `req.secure` as the enforcement signal for its mandatory-HTTPS middleware. With hop-count trust, a client reaching the application through a shorter path can be treated as a trusted proxy and supply `X-Forwarded-Proto: https` over an unencrypted socket. The application then accepts the request as HTTPS.

Version 2.0.7 removes this unsafe configuration class. Proxy trust must now be an explicit comma-separated allowlist of proxy IP addresses or bounded subnets. Boolean trust, numeric hop counts, wildcard values, and `/0` ranges fail during configuration/runtime policy validation before database initialization or request handling.

## Impact

When an HTTP application listener is directly reachable, or when another path has fewer proxy hops than configured, an attacker-controlled forwarded-protocol header can bypass the HTTP 426 gate. Login passwords, MFA codes, session traffic sent by non-browser clients, and authorized file responses can then cross the network without transport encryption. The `Secure` cookie attribute does not repair acceptance of a plaintext request and cannot protect credentials already submitted in that request.

## Baseline PoC

The isolated baseline PoC loaded the supplied configuration with strong secrets, `HTTP_HOST=0.0.0.0`, and `TRUST_PROXY=1`. It then applied the same numeric trust rule used by Express for hop index zero and evaluated RecordDrive's HTTPS gate. Result:

```json
{
  "trustProxy": 1,
  "directSocketEncrypted": false,
  "attackerHeader": "X-Forwarded-Proto: https",
  "expressProtocol": "https",
  "reqSecure": true,
  "applicationHttpsGateAllows": true,
  "impact": "PLAINTEXT_APPLICATION_REQUEST_ACCEPTED"
}
```

The supplied pre-remediation integration tests independently encoded the same behavior: an application configured with `trustProxy: 1` returned HTTP 200 for `/login` after only setting `X-Forwarded-Proto: https`.

## Remediation

- Reject positive numeric proxy-hop counts from environment configuration.
- Revalidate programmatically supplied runtime configuration so callers cannot bypass environment parsing.
- Reject boolean/universal trust, wildcard entries, and IPv4/IPv6 `/0` networks.
- Retain support for explicit proxy addresses, bounded CIDR subnets, and Express's bounded named ranges such as `loopback`.
- Update `.env.example`, README deployment guidance, focused regression tests, and the security PoC.

## Validation

- The focused regression demonstrates that `TRUST_PROXY=1` and `trustProxy: 1` fail closed.
- Explicit `loopback,10.20.30.0/24` trust remains accepted and still activates external-deployment secret, host, HTTPS, and error-disclosure controls.
- The fixed PoC reports `patchedConfiguration.blocked=true`.
- `.git` is excluded from all source modifications and is verified separately against the original ZIP.

## Residual requirements

The final trusted proxy must overwrite all forwarded headers. The application listener must be firewalled so clients cannot reach it through a path that bypasses the listed proxy identities. Transport security should be terminated either by RecordDrive's native HTTPS listener or by that explicitly trusted proxy.
