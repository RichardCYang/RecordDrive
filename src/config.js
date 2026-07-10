import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';

dotenv.config();

function resolveFromCwd(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
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

  return {
    port: Number.parseInt(env.PORT || '3000', 10),
    nodeEnv,
    isProduction: nodeEnv === 'production',
    sessionSecret,
    adminUsername: (env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
    adminPassword,
    adminDisplayName: (env.ADMIN_DISPLAY_NAME || 'System Administrator').trim(),
    maxFileSizeMb: Number.isFinite(maxFileSizeMb) && maxFileSizeMb > 0 ? maxFileSizeMb : 100,
    maxFilesPerUpload: Number.isFinite(maxFilesPerUpload) && maxFilesPerUpload > 0 ? maxFilesPerUpload : 10,
    dbPath: resolveFromCwd(env.DB_PATH || './data/recorddrive.db'),
    uploadRoot: resolveFromCwd(env.UPLOAD_ROOT || './data/uploads')
  };
}
