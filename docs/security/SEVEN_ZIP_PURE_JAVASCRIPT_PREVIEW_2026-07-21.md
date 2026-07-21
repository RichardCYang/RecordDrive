# Pure-JavaScript 7z Preview Security Review

**Date:** 2026-07-21  
**Scope:** RecordDrive 7z metadata preview on Windows, Linux, npm, PM2, and Docker deployments

## Executive summary

RecordDrive no longer launches a system 7-Zip executable for 7z previews. The preview path uses a pinned JavaScript parser in a disposable Node.js worker thread and reads only archive metadata required to build the file tree. No `7z.exe`, `7zz`, `7za`, PowerShell process, shell command, native Node add-on, or WebAssembly parser is used.

7z preview is enabled by default. Administrators can explicitly disable it with `SEVEN_ZIP_PREVIEW_ENABLED=false`.

## Parser selection and supply-chain controls

- `7z-iterator` is pinned to `2.2.9` in both `package.json` and `package-lock.json`.
- Its `xz-compat` dependency is overridden with `vendor/xz-compat-purejs`.
- The local fork is based on `xz-compat@1.2.7`, retains its MIT license, removes the runtime installer dependency, and makes native decoder discovery a permanent no-op.
- Production dependency installation uses `npm ci --ignore-scripts`.
- The worker verifies the expected parser and decoder versions before importing the parser.
- The worker recursively rejects `.node`, `.dll`, `.exe`, and `.wasm` payloads in the hardened decoder package.
- `LZMA_NATIVE_DISABLE=1` is set both by the parent and inside the worker as defense in depth.

The fork exists because upstream `xz-compat` can optionally discover and install a native LZMA implementation. That behavior is not required for RecordDrive metadata preview and is incompatible with the external-executable-free and native-add-on-free design goal.

## Parsing boundary

The preview parser accepts a server-side regular-file path. It does not expose an extraction API to the application.

The worker:

1. Opens the stored file read-only.
2. Verifies the 7z signature and supported major version.
3. Verifies the Start Header CRC.
4. Parses Next Header offset and size using bounded `BigInt` conversion.
5. Verifies that the Next Header lies inside the physical file.
6. Verifies the Next Header CRC.
7. Preflights encoded-header coder and stream graphs.
8. Rejects unsupported, overly complex, or oversized encoded metadata.
9. Detects AES-encrypted headers before attempting metadata decompression.
10. Uses the pinned parser to decode only metadata headers when required.
11. Never opens or returns an entry body stream.
12. Sanitizes and bounds every returned name and numeric field.
13. Terminates the worker after one result, timeout, parse error, or policy violation.

Compressed metadata headers may require LZMA/LZMA2 decoding. File contents are never decompressed or extracted.

## Confidentiality behavior

When an AES coder is found in the encoded header or parsed stream metadata, the response is deliberately reduced to:

- archive type;
- metadata-only indicator;
- JavaScript parser indicator;
- encrypted status; and
- physical archive size.

It does not expose entry names, entry count, uncompressed-size totals, timestamps, or partial metadata.

The worker receives a minimal environment containing only `LZMA_NATIVE_DISABLE=1`; application database, session, TLS, and storage environment variables are not copied into the worker environment.

## Resource and parser limits

The implementation applies independent limits to:

- worker runtime;
- old-generation and young-generation V8 heap;
- code range and worker stack;
- single metadata read;
- cumulative metadata bytes read;
- Next Header bytes;
- compressed metadata bytes;
- encoded-header folders, coders, input/output streams, and properties;
- scanned entries;
- visible entries;
- individual UTF-8 name length; and
- cumulative visible name bytes.

The random-access source truncates reads at end-of-file, as the parser API expects, while rejecting reads that start outside the file. It verifies the file size again inside the worker to reduce time-of-check/time-of-use ambiguity.

## Path handling

Entry names are normalized to Unicode NFC and backslashes are converted to slashes. The preview rejects or omits:

- control characters;
- Unicode bidirectional override and isolate characters;
- absolute roots and drive prefixes;
- `..` path components;
- empty normalized paths;
- names above the per-entry byte limit; and
- names exceeding the total response budget.

The parser never writes these paths to disk.

## Windows npm and PM2 operation

No Windows service, native launcher, Named Pipe, Job Object wrapper, system 7-Zip installation, or administrator installation script is required for this implementation.

Use the normal application commands:

```powershell
npm ci --ignore-scripts
npm start
```

or:

```powershell
npm ci --ignore-scripts
pm2 start ecosystem.config.cjs --env production
pm2 save
```

The existing RecordDrive PM2 application process creates disposable worker threads only when a 7z preview is requested.

## Validation performed

The regression suite includes:

- a real unencrypted 7z archive;
- a real encrypted-header 7z archive;
- default-enabled behavior;
- explicit disable behavior;
- visible-entry and scanned-entry limits;
- malformed signatures;
- corrupted Next Header CRC;
- oversized Next Header declarations;
- a static ban on child-process archive execution; and
- a static ban on native, DLL, executable, and WebAssembly decoder payloads.

The full application test suite also exercises the 7z preview HTTP route alongside PDF, XLSX, and ZIP preview behavior.

## Residual risks

- `worker_threads` provides scheduling, lifecycle, and V8 resource separation, but it is not an operating-system security boundary. A Node.js engine vulnerability could affect the parent process.
- V8 `resourceLimits` primarily constrain the JavaScript engine and do not provide a perfect cap for every possible native allocation made by Node itself.
- The parser supports the metadata encodings exercised by standard archives and rejects unsupported encoded-header graphs. Rejection is preferable to attempting permissive parsing.
- Pure JavaScript parsing reduces native parser exposure but does not make complex binary parsing risk-free. Dependency versions and the vendored fork must remain pinned and reviewed during upgrades.
- A separate low-privilege application account and filesystem ACLs remain recommended for the entire RecordDrive service, especially on multi-user Windows hosts.

## Third-party notices

- `7z-iterator@2.2.9`: MIT license; used as the JavaScript 7z metadata parser.
- `xz-compat@1.2.7`: MIT license; locally forked to remove native add-on discovery and runtime installation.
- The 7z container structure and identifiers used by the preflight validator follow the published 7z format and LZMA SDK documentation. No 7-Zip command-line executable or copied 7-Zip implementation is included.

The upstream license files for the vendored decoder are retained under `vendor/xz-compat-purejs`.
