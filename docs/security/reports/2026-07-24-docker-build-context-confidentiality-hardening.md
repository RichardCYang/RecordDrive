# Docker Build-Context Confidentiality Hardening

## Executive summary

A source-assisted confidentiality review of RecordDrive 2.0.7 confirmed one deployment-dependent **High-severity confidentiality weakness** in the container build boundary. The Dockerfile copied the complete project context into the production image with `COPY --chown=node:node . .`, while `.dockerignore` denied only a narrow set of exact paths. The policy excluded `.env` and `.git`, but it did not exclude common secret-bearing variants and artifacts such as `.env.production`, `.env.local`, TLS private-key/PFX directories, database backups with other names/extensions, exported archives, or application logs.

A developer or deployment operator could therefore unintentionally bake local secrets or confidential backups into an image layer merely by building from a working directory that contained them. Anyone who could pull, export, inspect, or obtain the resulting image or builder cache could recover those files even though the application never served them over HTTP.

RecordDrive 2.0.8 replaces the broad copy with an explicit runtime allowlist and changes `.dockerignore` to deny the entire context by default, re-including only the package manifests, application source, public assets, templates, and the vendored decoder required by `npm ci`. A dependency-free PoC deterministically demonstrates seven exposed canaries under the prior policy and zero under the patched policy.

No unresolved Critical-severity confidentiality vulnerability was confirmed in the reviewed current source. The review also rechecked authentication/session boundaries, repository and file authorization, in-flight disclosure revocation, upload/storage isolation, preview/parser boundaries, Host/TLS enforcement, error handling, current-tree secret patterns, and reachable Git history.

## Finding RD-C-07: production image could contain local secrets and backups

- **Severity:** High, deployment-dependent
- **Confidentiality impact:** High
- **Affected version:** 2.0.7 container build policy
- **Remediated version:** 2.0.8
- **Weakness class:** sensitive information included in a deployment artifact

### Vulnerable conditions

The issue required both of the following:

1. A secret or confidential artifact existed somewhere under the Docker build context but was not matched by the narrow `.dockerignore` rules.
2. A production image was built with the broad `COPY . .` instruction.

Representative affected files included:

- `.env.production` and `.env.local`;
- TLS private keys and PFX/PKCS#12 bundles under a local certificate directory;
- database backups or export archives not named like `data/*.db`;
- logs containing account, repository, path, or operational data.

The existing `.git` rule already prevented Git metadata from being copied into the image. This remediation preserves that property and does not modify the repository's `.git` directory.

### Confidentiality consequence

The risk exists at the image-distribution boundary rather than through an application route. A confidential file included in an image layer can become visible to image-registry readers, CI/build administrators, hosts that pull the image, or anyone who later receives an exported image. Deleting the file in a subsequent Dockerfile layer would not be a reliable remediation because earlier layers may retain it; the correct boundary is to keep it out of the context and copy set.

## Safe local PoC

Run from the project root:

```bash
node security-poc/docker-build-context-confidentiality.mjs .
node --test test/docker-build-context-confidentiality.test.js
```

The model uses harmless path canaries only. It does not read credential values, start the web service, contact a registry, or require a Docker daemon.

### Baseline result

The prior policy reports broad context copying and these seven exposed canaries:

- `.env.production`
- `.env.local`
- `certificates/tls-private.key`
- `certificates/recorddrive.pfx`
- `data/recorddrive-backup.sqlite`
- `data/exports/tenant-a.zip`
- `logs/recorddrive.log`

`.git/config` remains blocked by the prior `.git` ignore rule.

### Patched result

The patched policy reports:

- no broad context copy;
- a deny-all first `.dockerignore` rule;
- explicit copy sources only for package manifests, `vendor/xz-compat-purejs`, `src`, `public`, and `views`;
- zero exposed canaries and eight blocked canaries;
- verdict `BLOCKED`.

Exact output is retained in `docs/security/evidence/2026-07-24-docker-build-context-confidentiality-results.txt`.

## Remediation

### Dockerfile

The production image now copies only runtime-required paths:

```dockerfile
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node vendor/xz-compat-purejs ./vendor/xz-compat-purejs
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node views ./views
```

The broad `COPY . .` instruction was removed.

### `.dockerignore`

The build context now begins with `**` and re-includes only runtime-required paths. This creates two independent controls: files outside the allowlist are removed from the context, and the Dockerfile cannot copy the whole context even if the ignore policy regresses.

### Regression coverage

`test/docker-build-context-confidentiality.test.js` verifies:

- the previous policy exposes the expected canaries;
- the current Dockerfile contains no broad context copy;
- the current `.dockerignore` is deny-by-default;
- only approved source paths are copied;
- all confidentiality canaries, including `.git/config`, remain outside the image policy.

The test is included in `npm run test:security`.

## Broader confidentiality review

The current pass found no additional confirmed severe defect in the following reviewed boundaries:

- generic authentication failures, password hashing, MFA challenges, WebAuthn challenge consumption, recovery-key rotation, and session regeneration/revocation;
- AES-GCM protected server-side session payloads, HMAC-indexed session identifiers, idle/absolute expiry, and revocation tombstones;
- owner/member repository authorization, file-record-to-repository binding, unauthorized 404 behavior, and per-chunk live authorization during downloads/previews;
- random server-side upload names, canonical storage paths, `O_NOFOLLOW`, restrictive permissions, quota enforcement, and parser resource limits;
- HTTPS fail-closed startup behavior, exact Host allowlists, trusted-proxy hop validation, secure cookie policy, Helmet/CSP, and sanitized external errors/log records;
- high-confidence credential/private-key patterns in the current tree and all reachable Git blobs.

This conclusion is scoped to the supplied source and the dependency-light validations described below. It is not a claim that every unknown vulnerability or every environment-specific deployment failure is impossible.

## Validation limitations

- No Docker daemon was available in the audit environment, so validation used deterministic build-policy parsing and canaries rather than producing and exporting a real image.
- The local Node.js runtime was 22.16.0, below the project's declared supported floor of 22.23.0. Dependency-free PoCs, tests, and syntax checks were still executed.
- The configured package-registry audit endpoint returned HTTP 503. A live transitive `npm audit` verdict could therefore not be completed in this environment; run `npm ci` and `npm audit --omit=dev` in release CI with the declared Node version and a reachable advisory service.

## Upstream guidance

- Docker documents that `.dockerignore` removes matched paths from the context before it is sent to the builder: <https://docs.docker.com/build/concepts/context/>.
- Docker recommends excluding unneeded files from build contexts and using secret mounts rather than persisting build secrets in images: <https://docs.docker.com/build/building/secrets/>.
- GitHub documents that effective secret scanning covers the complete reachable Git history, not only the current working tree: <https://docs.github.com/code-security/secret-scanning/about-secret-scanning>.
