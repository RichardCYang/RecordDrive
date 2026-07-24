import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logActivity } from './database.js';
import { ensureSecureRepositoryDirectory } from './file-access-time.js';

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 127;
const MAX_SERVER_NAME_LENGTH = 255;
const SMB_STATUS_MAX_AGE_MS = 30_000;

export class SmbSettingsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SmbSettingsError';
    this.code = code;
    this.statusCode = 400;
  }
}

function ensureRealDirectory(directoryPath, mode = 0o700) {
  fs.mkdirSync(directoryPath, { recursive: true, mode });
  const stats = fs.lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new SmbSettingsError('INVALID_SMB_PATH', 'The SMB path must be a real directory.');
  }
  fs.chmodSync(directoryPath, mode);
  return directoryPath;
}

function atomicWriteJson(targetPath, value, mode = 0o600) {
  const directory = path.dirname(targetPath);
  ensureRealDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
  fs.chmodSync(temporaryPath, mode);
  fs.renameSync(temporaryPath, targetPath);
  fs.chmodSync(targetPath, mode);
}

export function readSmbRuntimeStatus(config) {
  if (!config.smbEnabled) return null;
  const statusPath = path.resolve(config.smbControlRoot, 'status.json');
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(statusPath, fs.constants.O_RDONLY | noFollow);
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size < 2 || stats.size > 64 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (parsed?.version !== 1 || typeof parsed.xattrSupported !== 'boolean') return null;
    const generatedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '';
    const generatedAtMs = Date.parse(generatedAt);
    const ageMs = Date.now() - generatedAtMs;
    if (!Number.isFinite(generatedAtMs) || ageMs < -SMB_STATUS_MAX_AGE_MS || ageMs > SMB_STATUS_MAX_AGE_MS) {
      return null;
    }
    return {
      generatedAt,
      xattrSupported: parsed.xattrSupported,
      protocolMin: typeof parsed.protocolMin === 'string' ? parsed.protocolMin : null,
      protocolMax: typeof parsed.protocolMax === 'string' ? parsed.protocolMax : null
    };
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EINVAL', 'SyntaxError'].includes(error.code || error.name)) return null;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validatePassword(password) {
  const value = String(password || '');
  if (
    value.length < PASSWORD_MIN_LENGTH
    || value.length > PASSWORD_MAX_LENGTH
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new SmbSettingsError(
      'INVALID_SMB_PASSWORD',
      `The SMB password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters and cannot contain line breaks.`
    );
  }
  return value;
}

export function smbShareName(repositoryId) {
  const id = Number(repositoryId);
  if (!Number.isSafeInteger(id) || id < 1) throw new SmbSettingsError('INVALID_REPOSITORY');
  return `recorddrive-${id}`;
}

export function smbUsername(repositoryId) {
  const id = Number(repositoryId);
  if (!Number.isSafeInteger(id) || id < 1) throw new SmbSettingsError('INVALID_REPOSITORY');
  return `rd_repo_${id}`;
}

export function smbRepositoryProjectionPath(config, repositoryId) {
  const root = ensureRealDirectory(path.resolve(config.smbShareRoot));
  const target = path.resolve(root, String(Number(repositoryId)));
  if (path.dirname(target) !== root) throw new SmbSettingsError('INVALID_SMB_PATH');
  ensureRealDirectory(target);
  return target;
}

function validateHardlinkProjection(config, repositoryId) {
  const repositoryRoot = ensureSecureRepositoryDirectory(config, repositoryId);
  const projectionRoot = smbRepositoryProjectionPath(config, repositoryId);
  const source = path.join(repositoryRoot, `.smb-hardlink-test-${crypto.randomUUID()}`);
  const destination = path.join(projectionRoot, `.smb-hardlink-test-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(source, '', { flag: 'wx', mode: 0o600 });
    fs.linkSync(source, destination);
    const sourceStats = fs.statSync(source, { bigint: true });
    const destinationStats = fs.statSync(destination, { bigint: true });
    if (sourceStats.dev !== destinationStats.dev || sourceStats.ino !== destinationStats.ino) {
      throw new SmbSettingsError(
        'SMB_HARDLINK_UNAVAILABLE',
        'SMB projection storage must be on the same filesystem as repository storage.'
      );
    }
  } catch (error) {
    if (error instanceof SmbSettingsError) throw error;
    throw new SmbSettingsError(
      'SMB_HARDLINK_UNAVAILABLE',
      'SMB requires repository storage and SMB projection storage to support hard links on the same filesystem.'
    );
  } finally {
    fs.rmSync(destination, { force: true });
    fs.rmSync(source, { force: true });
  }
}

export function resolvedSmbServerName(config, requestHostname = '') {
  const configured = String(config.smbServerName || '').trim();
  const fallback = String(requestHostname || '').trim();
  const value = configured || fallback || 'recorddrive';
  if (
    value.length > MAX_SERVER_NAME_LENGTH
    || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(value)
  ) {
    return 'recorddrive';
  }
  return value;
}

export function repositorySmbView(repository, config, requestHostname = '') {
  const enabled = Boolean(Number(repository.smb_enabled));
  const shareName = smbShareName(repository.id);
  const username = smbUsername(repository.id);
  const serverName = resolvedSmbServerName(config, requestHostname);
  const runtimeStatus = readSmbRuntimeStatus(config);
  return {
    available: Boolean(config.smbEnabled),
    enabled,
    readOnly: Boolean(Number(repository.smb_read_only)),
    shareName,
    username,
    serverName,
    uncPath: `\\\\${serverName}\\${shareName}`,
    credentialConfigured: Boolean(repository.smb_credential_updated_at),
    credentialUpdatedAt: repository.smb_credential_updated_at || null,
    runtimeReady: Boolean(runtimeStatus),
    xattrSupported: runtimeStatus?.xattrSupported ?? null,
    runtimeGeneratedAt: runtimeStatus?.generatedAt || null
  };
}

export function writeSmbManifest(db, config) {
  if (!config.smbEnabled) return null;
  const controlRoot = ensureRealDirectory(path.resolve(config.smbControlRoot));
  ensureRealDirectory(path.join(controlRoot, 'credentials'));
  ensureRealDirectory(path.resolve(config.smbShareRoot));

  const repositories = db.prepare(`
    SELECT id, name, smb_read_only
    FROM repositories
    WHERE smb_enabled = 1
    ORDER BY id ASC
  `).all();

  const shares = repositories.map((repository) => {
    smbRepositoryProjectionPath(config, repository.id);
    return {
      repositoryId: repository.id,
      displayName: repository.name,
      shareName: smbShareName(repository.id),
      username: smbUsername(repository.id),
      path: path.posix.join(
        String(config.smbContainerShareRoot || '/data/smb-shares').replace(/\/+$/, ''),
        String(repository.id)
      ),
      readOnly: Boolean(Number(repository.smb_read_only))
    };
  });

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    serverName: resolvedSmbServerName(config),
    shares
  };
  atomicWriteJson(path.join(controlRoot, 'shares.json'), manifest);
  return manifest;
}

function writeCredentialCommand(config, repositoryId, password, action = 'set') {
  const controlRoot = ensureRealDirectory(path.resolve(config.smbControlRoot));
  const commandDirectory = ensureRealDirectory(path.join(controlRoot, 'credentials'));
  const commandPath = path.join(
    commandDirectory,
    `${Date.now()}-${crypto.randomUUID()}.json`
  );
  const command = {
    version: 1,
    action,
    repositoryId: Number(repositoryId),
    username: smbUsername(repositoryId)
  };
  if (action === 'set') command.password = validatePassword(password);
  atomicWriteJson(commandPath, command);
  return commandPath;
}

export function updateRepositorySmbSettings(db, config, repository, form, actorId) {
  if (!config.smbEnabled) {
    throw new SmbSettingsError('SMB_DISABLED', 'SMB support is disabled by the server administrator.');
  }

  const enabled = Boolean(form.enabled);
  const readOnly = Boolean(form.readOnly);
  const password = enabled ? String(form.password || '') : '';
  const previouslyEnabled = Boolean(Number(repository.smb_enabled));
  const hasCredential = Boolean(repository.smb_credential_updated_at);

  if (enabled) {
    const runtimeStatus = readSmbRuntimeStatus(config);
    if (!runtimeStatus) {
      throw new SmbSettingsError(
        'SMB_RUNTIME_UNAVAILABLE',
        'The SMB sidecar is not ready. Start it before enabling a repository share.'
      );
    }
    if (!runtimeStatus.xattrSupported) {
      throw new SmbSettingsError(
        'SMB_XATTR_UNAVAILABLE',
        'The SMB projection filesystem does not support the extended attributes required for exact Windows creation-time preservation.'
      );
    }
    validateHardlinkProjection(config, repository.id);
    if (!hasCredential && !password) {
      throw new SmbSettingsError(
        'SMB_PASSWORD_REQUIRED',
        'Set an SMB password before enabling this repository.'
      );
    }
  }
  if (password) validatePassword(password);

  const credentialUpdatedAt = enabled
    ? (password ? new Date().toISOString() : repository.smb_credential_updated_at)
    : null;
  const previousAccessTimePolicy = Number(repository.update_file_access_time);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE repositories
      SET smb_enabled = ?,
          smb_read_only = ?,
          smb_credential_updated_at = ?,
          update_file_access_time = CASE WHEN ? = 1 THEN 0 ELSE update_file_access_time END
      WHERE id = ?
    `).run(Number(enabled), Number(readOnly), credentialUpdatedAt, Number(enabled), repository.id);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }

  try {
    // Publish or withdraw the share before changing passdb. This prevents a
    // credential command from being consumed if manifest generation fails.
    writeSmbManifest(db, config);
    if (password) writeCredentialCommand(config, repository.id, password, 'set');
    if (!enabled && previouslyEnabled) writeCredentialCommand(config, repository.id, '', 'delete');
  } catch (error) {
    db.prepare(`
      UPDATE repositories
      SET smb_enabled = ?,
          smb_read_only = ?,
          smb_credential_updated_at = ?,
          update_file_access_time = ?
      WHERE id = ?
    `).run(
      Number(repository.smb_enabled),
      Number(repository.smb_read_only),
      repository.smb_credential_updated_at,
      previousAccessTimePolicy,
      repository.id
    );
    try {
      writeSmbManifest(db, config);
    } catch (manifestError) {
      console.error('Failed to restore the SMB manifest after rolling back repository settings.', manifestError);
    }
    throw error;
  }

  logActivity(db, {
    actorId,
    action: enabled ? 'ENABLE_REPOSITORY_SMB' : 'DISABLE_REPOSITORY_SMB',
    targetType: 'REPOSITORY',
    targetLabel: `${repository.name} [${smbShareName(repository.id)}${readOnly ? ', read-only' : ''}]`,
    repositoryId: repository.id
  });

  return {
    enabled,
    readOnly,
    passwordChanged: Boolean(password),
    shareName: smbShareName(repository.id),
    username: smbUsername(repository.id)
  };
}
