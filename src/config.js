import path from 'node:path';
import process from 'node:process';
import { isIP } from 'node:net';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config({ quiet: true });

const DEFAULT_SESSION_SECRET = 'recorddrive-change-this-session-secret-at-least-32-chars';
const DEFAULT_ADMIN_PASSWORD = 'ChangeMe123!';

function resolveFromCwd(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function booleanFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function timeoutFromEnv(value, fallback, { allowZero = true } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isSafeInteger(parsed)) return fallback;
  if (allowZero ? parsed < 0 : parsed <= 0) return fallback;
  return parsed;
}

function trustProxyFromEnv(value) {
  if (value === undefined || value === null || String(value).trim() === '') return false;
  const normalized = String(value).trim();
  const lower = normalized.toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  if (['true', 'yes', 'on'].includes(lower)) {
    throw new Error('TRUST_PROXY cannot trust every source. Use a positive hop count or trusted addresses/subnets.');
  }
  if (/^[1-9]\d*$/.test(normalized)) return Number.parseInt(normalized, 10);
  return normalized.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
  const sessionSecret = env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
  const adminPassword = env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  const adminAccessDisabled = booleanFromEnv(env.ADMIN_ACCESS_DISABLED, false);
  const isProduction = !['development', 'test'].includes(nodeEnv);
  const configuredMfaEncryptionKey = String(env.MFA_ENCRYPTION_KEY || '');

  if (isProduction) {
    if (Buffer.byteLength(sessionSecret, 'utf8') < 32 || sessionSecret.includes('change-this')) {
      throw new Error('Production requires a secure SESSION_SECRET of at least 32 UTF-8 bytes.');
    }
    if (!adminAccessDisabled && adminPassword === DEFAULT_ADMIN_PASSWORD) {
      throw new Error('The default ADMIN_PASSWORD cannot be used in production while administrator access is enabled.');
    }
    if (!adminAccessDisabled && (adminPassword.length < 12 || adminPassword.length > 128 || bcrypt.truncates(adminPassword))) {
      throw new Error("ADMIN_PASSWORD must be 12 to 128 characters and remain within bcrypt's 72-byte input limit.");
    }
    if (configuredMfaEncryptionKey && Buffer.byteLength(configuredMfaEncryptionKey, 'utf8') < 32) {
      throw new Error('MFA_ENCRYPTION_KEY must contain at least 32 UTF-8 bytes in production.');
    }
  }

  const maxFileSizeMb = Number.parseInt(env.MAX_FILE_SIZE_MB || '0', 10);
  const maxFilesPerUpload = Number.parseInt(env.MAX_FILES_PER_UPLOAD || '10', 10);
  const httpPort = Number.parseInt(env.HTTP_PORT || env.PORT || '3000', 10);
  const httpsPort = Number.parseInt(env.HTTPS_PORT || '3443', 10);
  const defaultBindHost = isProduction ? '0.0.0.0' : '127.0.0.1';
  const reloadIntervalMinutes = Number.parseInt(env.TLS_RELOAD_INTERVAL_MINUTES || '5', 10);
  const maxRepositoryStorageMb = Number.parseInt(env.MAX_REPOSITORY_STORAGE_MB || '10240', 10);
  const maxTotalStorageMb = Number.parseInt(env.MAX_TOTAL_STORAGE_MB || '102400', 10);
  const maxRepositoriesPerUser = Number.parseInt(env.MAX_REPOSITORIES_PER_USER || '1000', 10);
  const maxTotalRepositories = Number.parseInt(env.MAX_TOTAL_REPOSITORIES || '10000', 10);
  const maxRepositoryFiles = Number.parseInt(env.MAX_REPOSITORY_FILES || '10000', 10);
  const maxTotalFiles = Number.parseInt(env.MAX_TOTAL_FILES || '100000', 10);
  const maxSessionsPerUser = Number.parseInt(env.MAX_SESSIONS_PER_USER || '10', 10);
  const maxActivityLogEntries = Number.parseInt(env.MAX_ACTIVITY_LOG_ENTRIES || '100000', 10);
  const sessionIdleHours = Number.parseInt(env.SESSION_IDLE_HOURS || '12', 10);
  const sessionAbsoluteHours = Number.parseInt(env.SESSION_ABSOLUTE_HOURS || '168', 10);
  const httpRequestTimeoutMs = timeoutFromEnv(env.HTTP_REQUEST_TIMEOUT_MS, 60 * 60 * 1000);
  const configuredHttpHeadersTimeoutMs = timeoutFromEnv(
    env.HTTP_HEADERS_TIMEOUT_MS,
    60 * 1000,
    { allowZero: false }
  );
  const httpHeadersTimeoutMs = httpRequestTimeoutMs > 0
    ? Math.min(configuredHttpHeadersTimeoutMs, httpRequestTimeoutMs)
    : configuredHttpHeadersTimeoutMs;

  return {
    port: Number.isFinite(httpPort) ? httpPort : 3000,
    httpPort: Number.isFinite(httpPort) ? httpPort : 3000,
    httpHost: (env.HTTP_HOST || defaultBindHost).trim(),
    httpsEnabled: booleanFromEnv(env.HTTPS_ENABLED, false),
    redirectHttpToHttps: booleanFromEnv(env.HTTP_TO_HTTPS_REDIRECT, true),
    httpsPort: Number.isFinite(httpsPort) ? httpsPort : 3443,
    httpsHost: (env.HTTPS_HOST || defaultBindHost).trim(),
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
    isProduction,
    trustProxy: trustProxyFromEnv(env.TRUST_PROXY),
    httpRequestTimeoutMs,
    httpHeadersTimeoutMs,
    sessionSecret,
    adminAccessDisabled,
    adminUsername: (env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
    adminPassword,
    adminDisplayName: (env.ADMIN_DISPLAY_NAME || 'System Administrator').trim(),
    mfaEncryptionKey: configuredMfaEncryptionKey || sessionSecret,
    mfaIssuer: (env.MFA_ISSUER || 'RecordDrive').trim(),
    webAuthnRpName: (env.WEBAUTHN_RP_NAME || 'RecordDrive').trim(),
    webAuthnRpId: (env.WEBAUTHN_RP_ID || '').trim().toLowerCase(),
    webAuthnOrigin: (env.WEBAUTHN_ORIGIN || '').trim(),
    maxFileSizeMb: Number.isFinite(maxFileSizeMb) && maxFileSizeMb >= 0
      ? Math.min(maxFileSizeMb, 10240)
      : 0,
    maxFilesPerUpload: Number.isFinite(maxFilesPerUpload) && maxFilesPerUpload > 0
      ? Math.min(maxFilesPerUpload, 100)
      : 10,
    maxRepositoryStorageMb: Number.isFinite(maxRepositoryStorageMb) && maxRepositoryStorageMb >= 0
      ? Math.min(maxRepositoryStorageMb, 1024 * 1024)
      : 10240,
    maxTotalStorageMb: Number.isFinite(maxTotalStorageMb) && maxTotalStorageMb >= 0
      ? Math.min(maxTotalStorageMb, 1024 * 1024)
      : 102400,
    maxRepositoriesPerUser: Number.isFinite(maxRepositoriesPerUser) && maxRepositoriesPerUser > 0
      ? Math.min(maxRepositoriesPerUser, 1_000_000)
      : 1000,
    maxTotalRepositories: Number.isFinite(maxTotalRepositories) && maxTotalRepositories > 0
      ? Math.min(maxTotalRepositories, 10_000_000)
      : 10000,
    maxRepositoryFiles: Number.isFinite(maxRepositoryFiles) && maxRepositoryFiles >= 0
      ? Math.min(maxRepositoryFiles, 10_000_000)
      : 10000,
    maxTotalFiles: Number.isFinite(maxTotalFiles) && maxTotalFiles >= 0
      ? Math.min(maxTotalFiles, 100_000_000)
      : 100000,
    maxSessionsPerUser: Number.isFinite(maxSessionsPerUser) && maxSessionsPerUser > 0
      ? Math.min(maxSessionsPerUser, 100)
      : 10,
    maxActivityLogEntries: Number.isFinite(maxActivityLogEntries) && maxActivityLogEntries > 0
      ? Math.min(maxActivityLogEntries, 10_000_000)
      : 100000,
    sessionIdleHours: Number.isFinite(sessionIdleHours) && sessionIdleHours > 0
      ? Math.min(sessionIdleHours, 24 * 30)
      : 12,
    sessionAbsoluteHours: Number.isFinite(sessionAbsoluteHours) && sessionAbsoluteHours > 0
      ? Math.min(sessionAbsoluteHours, 24 * 365)
      : 168,
    sevenZipPreviewEnabled: booleanFromEnv(env.SEVEN_ZIP_PREVIEW_ENABLED, true),
    sevenZipPreviewTimeoutMs: timeoutFromEnv(
      env.SEVEN_ZIP_PREVIEW_TIMEOUT_MS,
      20 * 1000,
      { allowZero: false }
    ),
    dbPath: resolveFromCwd(env.DB_PATH || './data/recorddrive.db'),
    uploadRoot: resolveFromCwd(env.UPLOAD_ROOT || './data/uploads')
  };
}


function normalizeListenerHost(value) {
  let host = String(value ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zoneIndex = host.indexOf('%');
  if (zoneIndex >= 0) host = host.slice(0, zoneIndex);
  return host;
}

export function isLoopbackListenerHost(value) {
  const host = normalizeListenerHost(value);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const addressFamily = isIP(host);
  if (addressFamily === 4) return host.split('.')[0] === '127';
  if (addressFamily === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return false;
}

function validateExternallyReachableSecrets(config) {
  const sessionSecret = String(config.sessionSecret || '');
  if (
    Buffer.byteLength(sessionSecret, 'utf8') < 32
    || sessionSecret === DEFAULT_SESSION_SECRET
    || sessionSecret.includes('change-this')
  ) {
    throw new Error('A non-loopback listener requires a unique SESSION_SECRET of at least 32 UTF-8 bytes.');
  }

  if (!config.adminAccessDisabled) {
    const adminPassword = String(config.adminPassword || '');
    if (adminPassword === DEFAULT_ADMIN_PASSWORD) {
      throw new Error('The default ADMIN_PASSWORD cannot be used on a non-loopback listener.');
    }
    if (adminPassword.length < 12 || adminPassword.length > 128 || bcrypt.truncates(adminPassword)) {
      throw new Error("A non-loopback listener requires ADMIN_PASSWORD to be 12 to 128 characters and within bcrypt's 72-byte input limit.");
    }
  }

  const mfaEncryptionKey = String(config.mfaEncryptionKey || '');
  if (Buffer.byteLength(mfaEncryptionKey, 'utf8') < 32) {
    throw new Error('A non-loopback listener requires an MFA encryption key source of at least 32 UTF-8 bytes.');
  }
}

export function applyRuntimeConfidentialityPolicy(config, networkSettings = {}) {
  const activeHosts = [networkSettings.httpHost || config.httpHost];
  if (networkSettings.httpsEnabled) {
    activeHosts.push(networkSettings.httpsHost || config.httpsHost);
  }

  const externallyReachable = activeHosts.some((host) => !isLoopbackListenerHost(host));
  if (externallyReachable) validateExternallyReachableSecrets(config);

  config.externallyReachable = externallyReachable;
  config.requireHttps = Boolean(config.isProduction || externallyReachable);
  return config;
}
