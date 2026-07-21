/**
 * RecordDrive security fork: native decoder discovery and runtime installation
 * are permanently disabled. Metadata decoding always uses the bundled
 * pure-JavaScript implementation.
 */
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.tryLoadNative = tryLoadNative;
exports.isNativeAvailable = isNativeAvailable;

function tryLoadNative() {
  return null;
}

function isNativeAvailable() {
  return false;
}
