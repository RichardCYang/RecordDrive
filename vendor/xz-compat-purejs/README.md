# RecordDrive pure-JavaScript security fork

This directory is derived from `xz-compat` 1.2.7 (MIT license).

Security changes:

- `tryLoadNative()` is permanently replaced with a no-op.
- The `install-module-linked` dependency is removed.
- Runtime installation or loading of `lzma-native` is impossible.
- Source maps are omitted so obsolete native-install source text is not shipped.
- The compiled `dist/` files are committed because the package is installed with lifecycle scripts disabled.

The remaining decoder code is used only to decode a bounded 7z metadata header.
It is not exposed as a general archive extraction feature.
