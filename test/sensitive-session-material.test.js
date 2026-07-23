import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  activeSecurityVerificationExpiresAt,
  canDiscloseSensitiveSessionMaterial,
  createBoundSensitiveMaterialExpiry
} from '../src/sensitive-session-material.js';

const MINUTE = 60 * 1000;
const SECURITY_WINDOW_MS = 10 * MINUTE;
const MATERIAL_WINDOW_MS = 10 * MINUTE;
const AUTHENTICATED_AT = 1_800_000_000_000;

test('bounds TOTP and recovery-code disclosure to the active security-verification window', () => {
  const session = { authenticatedAt: AUTHENTICATED_AT };
  const createdAt = AUTHENTICATED_AT + (9 * MINUTE);
  const disclosureExpiresAt = createBoundSensitiveMaterialExpiry(session, {
    now: createdAt,
    materialMaxAgeMs: MATERIAL_WINDOW_MS,
    verificationMaxAgeMs: SECURITY_WINDOW_MS
  });

  assert.equal(disclosureExpiresAt, AUTHENTICATED_AT + SECURITY_WINDOW_MS);
  assert.equal(canDiscloseSensitiveSessionMaterial(session, disclosureExpiresAt, {
    now: AUTHENTICATED_AT + (9.5 * MINUTE),
    verificationMaxAgeMs: SECURITY_WINDOW_MS
  }), true);
  assert.equal(canDiscloseSensitiveSessionMaterial(session, disclosureExpiresAt, {
    now: AUTHENTICATED_AT + (15 * MINUTE),
    verificationMaxAgeMs: SECURITY_WINDOW_MS
  }), false);
});

test('uses the newest valid password verification without extending material beyond its own lifetime', () => {
  const session = {
    authenticatedAt: AUTHENTICATED_AT,
    securityVerifiedAt: AUTHENTICATED_AT + (30 * MINUTE)
  };
  const createdAt = AUTHENTICATED_AT + (31 * MINUTE);
  assert.equal(activeSecurityVerificationExpiresAt(
    session,
    SECURITY_WINDOW_MS,
    createdAt
  ), AUTHENTICATED_AT + (40 * MINUTE));
  assert.equal(createBoundSensitiveMaterialExpiry(session, {
    now: createdAt,
    materialMaxAgeMs: 2 * MINUTE,
    verificationMaxAgeMs: SECURITY_WINDOW_MS
  }), AUTHENTICATED_AT + (33 * MINUTE));
});

test('fails closed for legacy, malformed, expired, or future verification metadata', () => {
  const now = AUTHENTICATED_AT + MINUTE;
  assert.equal(canDiscloseSensitiveSessionMaterial(
    { authenticatedAt: AUTHENTICATED_AT },
    undefined,
    { now, verificationMaxAgeMs: SECURITY_WINDOW_MS }
  ), false);
  assert.equal(createBoundSensitiveMaterialExpiry(
    { authenticatedAt: 'not-a-time' },
    { now, materialMaxAgeMs: MATERIAL_WINDOW_MS, verificationMaxAgeMs: SECURITY_WINDOW_MS }
  ), 0);
  assert.equal(activeSecurityVerificationExpiresAt(
    { authenticatedAt: AUTHENTICATED_AT + (2 * MINUTE) },
    SECURITY_WINDOW_MS,
    now
  ), 0);
  assert.equal(canDiscloseSensitiveSessionMaterial(
    { authenticatedAt: AUTHENTICATED_AT - (20 * MINUTE) },
    now + MINUTE,
    { now, verificationMaxAgeMs: SECURITY_WINDOW_MS }
  ), false);
});

test('settings route stores and enforces explicit disclosure expiries for both secret classes', () => {
  const source = fs.readFileSync(new URL('../src/routes/settings.js', import.meta.url), 'utf8');
  assert.match(source, /pending\.disclosureExpiresAt/);
  assert.match(source, /newRecoveryCodesExpiresAt/);
  assert.match(source, /canDiscloseSensitiveSessionMaterial/);
  assert.match(source, /createBoundSensitiveMaterialExpiry/);
  assert.match(source, /totpEnrollment && !canDiscloseSensitiveSessionMaterial/);
  assert.match(source, /newRecoveryCodes\.length && !canDiscloseSensitiveSessionMaterial/);
});
