import crypto from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { decryptProtectedValue, encryptProtectedValue } from './secret-protection.js';

const TOTP_AAD = Buffer.from('recorddrive:mfa:totp:v1', 'utf8');
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DEFAULT_RECOVERY_CODE_COUNT = 8;
export const MAX_ACTIVE_RECOVERY_CODES = 32;
export const SECURITY_VERIFICATION_MAX_AGE_MS = 10 * 60 * 1000;

function encryptionKey(config) {
  const source = String(config.mfaEncryptionKey || config.sessionSecret || '');
  if (!source) throw new Error('An MFA encryption key is required.');
  return crypto.createHash('sha256').update(`recorddrive:mfa:encryption:${source}`, 'utf8').digest();
}

function recoveryPepper(config) {
  const source = String(config.mfaEncryptionKey || config.sessionSecret || '');
  if (!source) throw new Error('An MFA encryption key is required.');
  return crypto.createHash('sha256').update(`recorddrive:mfa:recovery:${source}`, 'utf8').digest();
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url');
}

export function encryptTotpSecret(secret, config) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(config), iv);
  cipher.setAAD(TOTP_AAD);
  const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ['v1', encode(iv), encode(authTag), encode(ciphertext)].join('.');
}

export function decryptTotpSecret(value, config) {
  const [version, ivValue, authTagValue, ciphertextValue] = String(value || '').split('.');
  if (version !== 'v1' || !ivValue || !authTagValue || !ciphertextValue) {
    throw new Error('The stored TOTP secret has an unsupported format.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(config), decode(ivValue));
  decipher.setAAD(TOTP_AAD);
  decipher.setAuthTag(decode(authTagValue));
  return Buffer.concat([decipher.update(decode(ciphertextValue)), decipher.final()]).toString('utf8');
}

export function createTotpUri(secret, user, config) {
  const issuer = String(config.mfaIssuer || 'RecordDrive').trim() || 'RecordDrive';
  return generateURI({
    issuer,
    label: user.username,
    secret,
    algorithm: 'sha1',
    digits: 6,
    period: 30
  });
}

export function createTotpEnrollment(user, config) {
  const secret = generateSecret({ length: 20 });
  return { secret, uri: createTotpUri(secret, user, config) };
}

export async function verifyTotpToken(secret, token) {
  const normalizedToken = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalizedToken)) return { valid: false };
  return verify({
    secret,
    token: normalizedToken,
    algorithm: 'sha1',
    digits: 6,
    period: 30,
    epochTolerance: 30
  });
}

export async function verifyAndConsumeTotp(db, userId, token, config) {
  const user = db.prepare(`
    SELECT totp_secret_encrypted, totp_last_used_step
    FROM users
    WHERE id = ? AND totp_enabled = 1
  `).get(userId);
  if (!user?.totp_secret_encrypted) return false;

  let secret;
  try {
    secret = decryptTotpSecret(user.totp_secret_encrypted, config);
  } catch {
    return false;
  }
  const result = await verifyTotpToken(secret, token);
  if (!result.valid || !Number.isInteger(result.timeStep)) return false;

  const update = db.prepare(`
    UPDATE users
    SET totp_last_used_step = ?
    WHERE id = ?
      AND totp_enabled = 1
      AND (totp_last_used_step IS NULL OR totp_last_used_step < ?)
  `).run(result.timeStep, userId, result.timeStep);
  return update.changes === 1;
}

export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code, config) {
  const normalized = normalizeRecoveryCode(code);
  return crypto.createHmac('sha256', recoveryPepper(config)).update(normalized, 'utf8').digest('hex');
}

function randomRecoveryCode() {
  const bytes = crypto.randomBytes(12);
  let plain = '';
  for (let index = 0; index < 12; index += 1) {
    plain += RECOVERY_ALPHABET[bytes[index] % RECOVERY_ALPHABET.length];
  }
  return plain.match(/.{1,4}/g).join('-');
}


export function encryptRecoveryCodeBundle(codes, config) {
  const normalizedCodes = Array.isArray(codes) ? codes.map((code) => String(code)) : [];
  return encryptProtectedValue(JSON.stringify(normalizedCodes), config, 'recovery-code-bundle');
}

export function decryptRecoveryCodeBundle(value, config) {
  const parsed = JSON.parse(decryptProtectedValue(value, config, 'recovery-code-bundle'));
  if (!Array.isArray(parsed) || parsed.some((code) => typeof code !== 'string')) {
    throw new Error('The protected recovery code bundle is invalid.');
  }
  return parsed;
}

export function countActiveRecoveryCodes(db, userId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM recovery_codes
    WHERE user_id = ? AND used_at IS NULL
  `).get(userId).count;
}

export function createRecoveryCodes(db, userId, config, count = DEFAULT_RECOVERY_CODE_COUNT) {
  const activeCount = countActiveRecoveryCodes(db, userId);
  const requestedCount = Math.max(1, Number.parseInt(count, 10) || DEFAULT_RECOVERY_CODE_COUNT);
  const availableSlots = Math.max(0, MAX_ACTIVE_RECOVERY_CODES - activeCount);
  const actualCount = Math.min(requestedCount, availableSlots);
  if (actualCount === 0) return [];

  const insert = db.prepare(`
    INSERT INTO recovery_codes (user_id, code_hash)
    VALUES (?, ?)
  `);
  const codes = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    while (codes.length < actualCount) {
      const code = randomRecoveryCode();
      const hash = hashRecoveryCode(code, config);
      try {
        insert.run(userId, hash);
        codes.push(code);
      } catch (error) {
        if (!String(error.message).includes('UNIQUE')) throw error;
      }
    }
    db.exec('COMMIT');
    return codes;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function replaceRecoveryCodes(db, userId, config, count = DEFAULT_RECOVERY_CODE_COUNT) {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  return createRecoveryCodes(db, userId, config, count);
}

export function consumeRecoveryCode(db, userId, code, config) {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 12) return false;
  const hash = hashRecoveryCode(normalized, config);
  const result = db.prepare(`
    DELETE FROM recovery_codes
    WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
  `).run(userId, hash);
  return result.changes === 1;
}

export function getMfaState(db, userId) {
  const user = db.prepare(`
    SELECT totp_enabled
    FROM users
    WHERE id = ?
  `).get(userId);
  const passkeyCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM webauthn_credentials
    WHERE user_id = ?
  `).get(userId).count;
  const recoveryCodeCount = countActiveRecoveryCodes(db, userId);
  return {
    totpEnabled: user?.totp_enabled === 1,
    passkeyCount,
    passkeyEnabled: passkeyCount > 0,
    recoveryCodeCount,
    enabled: user?.totp_enabled === 1 || passkeyCount > 0
  };
}

export function isSecurityRecentlyVerified(req) {
  const now = Date.now();
  const authenticatedAt = Number(req.session?.authenticatedAt || 0);
  const verifiedAt = Number(req.session?.securityVerifiedAt || 0);
  return [authenticatedAt, verifiedAt].some((value) => value > 0 && now - value <= SECURITY_VERIFICATION_MAX_AGE_MS);
}

export function clearSecurityVerification(req) {
  delete req.session.securityVerifiedAt;
  delete req.session.authenticatedAt;
}

export function resolveWebAuthnSettings(req, config) {
  const requestOrigin = `${req.protocol}://${req.get('host')}`;
  const origin = String(config.webAuthnOrigin || requestOrigin).trim();
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error('WEBAUTHN_ORIGIN must be a valid absolute origin.');
  }

  if (parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) {
    throw new Error('WEBAUTHN_ORIGIN must not include a path, query, or fragment.');
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (parsedOrigin.protocol !== 'https:' && !localHosts.has(parsedOrigin.hostname)) {
    throw new Error('WebAuthn requires HTTPS except when using localhost.');
  }

  if (config.isProduction && !config.webAuthnOrigin) {
    throw new Error('WEBAUTHN_ORIGIN must be configured in production.');
  }

  const rpID = String(config.webAuthnRpId || parsedOrigin.hostname).trim().toLowerCase();
  if (!rpID || rpID.includes('://') || rpID.includes('/') || rpID.includes(':')) {
    throw new Error('WEBAUTHN_RP_ID must be a host name without a scheme, path, or port.');
  }
  if (config.isProduction && !config.webAuthnRpId) {
    throw new Error('WEBAUTHN_RP_ID must be configured in production.');
  }

  return {
    origin: parsedOrigin.origin,
    rpID,
    rpName: String(config.webAuthnRpName || 'RecordDrive').trim() || 'RecordDrive'
  };
}

export function userIdBuffer(userId) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(userId));
  return buffer;
}
