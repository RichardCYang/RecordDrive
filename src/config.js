import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

function resolveFromCwd(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function booleanFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const nodeEnv = env.NODE_ENV || 'development';
  const sessionSecret = env.SESSION_SECRET || 'recorddrive-change-this-session-secret-at-least-32-chars';
  const adminPassword = env.ADMIN_PASSWORD || 'ChangeMe123!';

  if (nodeEnv === 'production') {
    if (sessionSecret.length < 32 || sessionSecret.includes('change-this')) {
      throw new Error('Production requires a secure SESSION_SECRET of at least 32 characters.');
    }
    if (adminPassword === 'ChangeMe123!') {
      throw new Error('The default ADMIN_PASSWORD cannot be used in production.');
    }
  }

  const maxFileSizeMb = Number.parseInt(env.MAX_FILE_SIZE_MB || '100', 10);
  const maxFilesPerUpload = Number.parseInt(env.MAX_FILES_PER_UPLOAD || '10', 10);
  const httpPort = Number.parseInt(env.HTTP_PORT || env.PORT || '3000', 10);
  const httpsPort = Number.parseInt(env.HTTPS_PORT || '3443', 10);
  const reloadIntervalMinutes = Number.parseInt(env.TLS_RELOAD_INTERVAL_MINUTES || '5', 10);

  return {
    port: Number.isFinite(httpPort) ? httpPort : 3000,
    httpPort: Number.isFinite(httpPort) ? httpPort : 3000,
    httpHost: (env.HTTP_HOST || '0.0.0.0').trim(),
    httpsEnabled: booleanFromEnv(env.HTTPS_ENABLED, false),
    redirectHttpToHttps: booleanFromEnv(env.HTTP_TO_HTTPS_REDIRECT, true),
    httpsPort: Number.isFinite(httpsPort) ? httpsPort : 3443,
    httpsHost: (env.HTTPS_HOST || '0.0.0.0').trim(),
    publicHostname: (env.TLS_PUBLIC_HOSTNAME || '').trim(),
    certificateMode: (env.TLS_CERT_MODE || 'pem').trim().toLowerCase(),
    certificateDirectory: (env.TLS_CERT_DIRECTORY || '').trim(),
    certificatePath: (env.TLS_CERT_PATH || '').trim(),
    privateKeyPath: (env.TLS_KEY_PATH || '').trim(),
    pfxPath: (env.TLS_PFX_PATH || '').trim(),
    passphrase: env.TLS_PASSPHRASE || '',
    autoReloadCertificate: booleanFromEnv(env.TLS_AUTO_RELOAD, true),
    reloadIntervalMinutes: Number.isFinite(reloadIntervalMinutes) ? reloadIntervalMinutes : 5,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    sessionSecret,
    adminUsername: (env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
    adminPassword,
    adminDisplayName: (env.ADMIN_DISPLAY_NAME || 'System Administrator').trim(),
    mfaEncryptionKey: env.MFA_ENCRYPTION_KEY || sessionSecret,
    mfaIssuer: (env.MFA_ISSUER || 'RecordDrive').trim(),
    webAuthnRpName: (env.WEBAUTHN_RP_NAME || 'RecordDrive').trim(),
    webAuthnRpId: (env.WEBAUTHN_RP_ID || '').trim().toLowerCase(),
    webAuthnOrigin: (env.WEBAUTHN_ORIGIN || '').trim(),
    maxFileSizeMb: Number.isFinite(maxFileSizeMb) && maxFileSizeMb > 0 ? maxFileSizeMb : 100,
    maxFilesPerUpload: Number.isFinite(maxFilesPerUpload) && maxFilesPerUpload > 0 ? maxFilesPerUpload : 10,
    dbPath: resolveFromCwd(env.DB_PATH || './data/recorddrive.db'),
    uploadRoot: resolveFromCwd(env.UPLOAD_ROOT || './data/uploads')
  };
}
