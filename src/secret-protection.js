import crypto from 'node:crypto';

const VERSION = 'v1';

function protectionKey(config, purpose) {
  const source = String(config.mfaEncryptionKey || config.sessionSecret || '');
  if (!source) throw new Error('A secret-protection key is required.');
  return crypto
    .createHash('sha256')
    .update(`recorddrive:protected:${purpose}:${source}`, 'utf8')
    .digest();
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url');
}

export function encryptProtectedValue(value, config, purpose) {
  const normalizedPurpose = String(purpose || '').trim();
  if (!normalizedPurpose) throw new Error('A secret-protection purpose is required.');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', protectionKey(config, normalizedPurpose), iv);
  cipher.setAAD(Buffer.from(`recorddrive:${normalizedPurpose}:${VERSION}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [VERSION, encode(iv), encode(cipher.getAuthTag()), encode(ciphertext)].join('.');
}

export function decryptProtectedValue(value, config, purpose) {
  const normalizedPurpose = String(purpose || '').trim();
  if (!normalizedPurpose) throw new Error('A secret-protection purpose is required.');

  const [version, ivValue, authTagValue, ciphertextValue] = String(value || '').split('.');
  if (version !== VERSION || !ivValue || !authTagValue || !ciphertextValue) {
    throw new Error('The protected value has an unsupported format.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    protectionKey(config, normalizedPurpose),
    decode(ivValue)
  );
  decipher.setAAD(Buffer.from(`recorddrive:${normalizedPurpose}:${VERSION}`, 'utf8'));
  decipher.setAuthTag(decode(authTagValue));
  return Buffer.concat([
    decipher.update(decode(ciphertextValue)),
    decipher.final()
  ]).toString('utf8');
}
