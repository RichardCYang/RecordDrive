# Security PoC Guide

All PoCs operate only on temporary local files. They do not contact a remote service.

## Activity-log resource exhaustion

Run the patched project with a small retention limit:

```bash
MAX_ACTIVITY_LOG_ENTRIES=1000 ATTEMPTS=25000 node security-poc/activity-log-growth.mjs
```

The retained row count must remain at or below the configured limit. To reproduce the original weakness, export Git commit `40ea9e3` to a temporary directory, install its dependencies, and run the same script with `PROJECT_ROOT` pointing to that directory and without `MAX_ACTIVITY_LOG_ENTRIES`.

## CVE-2026-31988 dependency check

Run against the installed project dependency:

```bash
node security-poc/yauzl-cve-2026-31988.cjs .
```

The project uses yauzl 3.4.0 and must report `safe`. For comparison in an isolated temporary npm project, yauzl 3.2.0 reports an `ERR_OUT_OF_RANGE` exception for the same malformed NTFS timestamp extra field. Do not deploy the vulnerable comparison package.

## Automated regression suite

```bash
npm run test:security
```
