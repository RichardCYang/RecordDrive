/**
 * RecordDrive security fork: native decoder discovery and runtime installation
 * are permanently disabled. Metadata decoding always uses the bundled
 * pure-JavaScript implementation.
 */
export function tryLoadNative() {
  return null;
}

export function isNativeAvailable() {
  return false;
}
