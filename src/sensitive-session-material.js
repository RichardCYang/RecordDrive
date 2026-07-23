function positiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function activeSecurityVerificationExpiresAt(
  session,
  verificationMaxAgeMs,
  now = Date.now()
) {
  const currentTime = positiveSafeInteger(now);
  const maxAge = positiveSafeInteger(verificationMaxAgeMs);
  if (!currentTime || !maxAge) return 0;

  const activeTimestamps = [session?.authenticatedAt, session?.securityVerifiedAt]
    .map(positiveSafeInteger)
    .filter((timestamp) => (
      timestamp <= currentTime
      && currentTime - timestamp <= maxAge
    ));
  if (!activeTimestamps.length) return 0;
  return Math.max(...activeTimestamps) + maxAge;
}

export function createBoundSensitiveMaterialExpiry(session, {
  now = Date.now(),
  materialMaxAgeMs,
  verificationMaxAgeMs
} = {}) {
  const currentTime = positiveSafeInteger(now);
  const materialMaxAge = positiveSafeInteger(materialMaxAgeMs);
  if (!currentTime || !materialMaxAge) return 0;

  const verificationExpiresAt = activeSecurityVerificationExpiresAt(
    session,
    verificationMaxAgeMs,
    currentTime
  );
  if (!verificationExpiresAt) return 0;
  return Math.min(verificationExpiresAt, currentTime + materialMaxAge);
}

export function canDiscloseSensitiveSessionMaterial(session, expiresAt, {
  now = Date.now(),
  verificationMaxAgeMs
} = {}) {
  const currentTime = positiveSafeInteger(now);
  const disclosureExpiresAt = positiveSafeInteger(expiresAt);
  if (!currentTime || !disclosureExpiresAt || currentTime > disclosureExpiresAt) return false;

  const verificationExpiresAt = activeSecurityVerificationExpiresAt(
    session,
    verificationMaxAgeMs,
    currentTime
  );
  return verificationExpiresAt > 0 && currentTime <= verificationExpiresAt;
}
