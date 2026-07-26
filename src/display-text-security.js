const UNSAFE_DISPLAY_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_DISPLAY_CONTROL_GLOBAL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Detects control characters that can hide, reorder, or visually spoof
 * security-relevant user-visible text such as file and repository names.
 * Native RTL letters remain allowed; only explicit direction controls and
 * C0/C1 controls are rejected or stripped.
 */
export function hasUnsafeDisplayControls(value) {
  return UNSAFE_DISPLAY_CONTROL_PATTERN.test(String(value || ''));
}

export function stripUnsafeDisplayControls(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(UNSAFE_DISPLAY_CONTROL_GLOBAL_PATTERN, '');
}

export function safeDisplayText(value, fallback = '') {
  const sanitized = stripUnsafeDisplayControls(value);
  return sanitized || stripUnsafeDisplayControls(fallback);
}
