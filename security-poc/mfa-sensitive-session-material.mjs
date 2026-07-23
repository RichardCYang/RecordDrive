import {
  canDiscloseSensitiveSessionMaterial,
  createBoundSensitiveMaterialExpiry
} from '../src/sensitive-session-material.js';

const MINUTE = 60 * 1000;
const SECURITY_WINDOW_MS = 10 * MINUTE;
const MATERIAL_WINDOW_MS = 10 * MINUTE;
const authenticatedAt = 1_800_000_000_000;
const materialCreatedAt = authenticatedAt + (9 * MINUTE);
const attackerReadAt = authenticatedAt + (15 * MINUTE);
const session = { authenticatedAt };

const disclosureExpiresAt = createBoundSensitiveMaterialExpiry(session, {
  now: materialCreatedAt,
  materialMaxAgeMs: MATERIAL_WINDOW_MS,
  verificationMaxAgeMs: SECURITY_WINDOW_MS
});

const originalModel = {
  totpSecretDisclosed: attackerReadAt - materialCreatedAt <= MATERIAL_WINDOW_MS,
  recoveryCodesDisclosed: true
};
const patchedModel = {
  disclosureExpiresAt,
  securityVerificationExpiresAt: authenticatedAt + SECURITY_WINDOW_MS,
  totpSecretDisclosed: canDiscloseSensitiveSessionMaterial(session, disclosureExpiresAt, {
    now: attackerReadAt,
    verificationMaxAgeMs: SECURITY_WINDOW_MS
  }),
  recoveryCodesDisclosed: canDiscloseSensitiveSessionMaterial(session, disclosureExpiresAt, {
    now: attackerReadAt,
    verificationMaxAgeMs: SECURITY_WINDOW_MS
  })
};

const vulnerableBaseline = originalModel.totpSecretDisclosed && originalModel.recoveryCodesDisclosed;
const blocked = !patchedModel.totpSecretDisclosed && !patchedModel.recoveryCodesDisclosed;
const result = {
  scenario: {
    authenticatedAt,
    materialCreatedAt,
    attackerReadAt,
    readOccursMinutesAfterVerificationExpiry: 5
  },
  originalModel,
  patchedModel,
  verdict: vulnerableBaseline && blocked ? 'BLOCKED' : 'REGRESSION'
};

console.log(JSON.stringify(result, null, 2));
if (result.verdict !== 'BLOCKED') process.exitCode = 1;
