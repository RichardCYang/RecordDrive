# 7z Parser Third-Party Notices

RecordDrive's metadata-only 7z preview uses the following MIT-licensed JavaScript packages:

- `7z-iterator@2.2.9`, copyright its respective contributors.
- `xz-compat@1.2.7`, copyright Kevin Malakoff and contributors.

RecordDrive includes a security-focused project-local fork of `xz-compat` under `vendor/xz-compat-purejs`. The fork removes native decoder discovery and runtime package installation. Its original MIT `LICENSE` file is retained in that directory.

The implementation consults the publicly documented 7z container format and LZMA SDK format information. RecordDrive does not redistribute or execute the 7-Zip command-line application.
