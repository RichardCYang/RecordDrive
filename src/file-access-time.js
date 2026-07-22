import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ACCESS_TIME_TOLERANCE_MS = 0.5;
const MAX_STORED_NAME_BYTES = 255;

function validateRepositoryId(repositoryId) {
  const value = Number(repositoryId);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('The repository identifier is not allowed.');
  }
  return String(value);
}

function validateStoredName(storedName) {
  const value = String(storedName || '');
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_STORED_NAME_BYTES ||
    path.basename(value) !== value ||
    path.win32.basename(value) !== value
  ) {
    throw new Error('The stored file name is not allowed.');
  }
  return value;
}

function lstatIfPresent(targetPath) {
  return fs.lstatSync(targetPath, { throwIfNoEntry: false });
}

function comparablePath(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function requireSecureDirectory(directoryPath, label) {
  const stats = lstatIfPresent(directoryPath);
  if (!stats) throw new Error(`${label} does not exist.`);
  if (stats.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory.`);
  if (comparablePath(fs.realpathSync(directoryPath)) !== comparablePath(directoryPath)) {
    throw new Error(`${label} must use a canonical path without symbolic-link ancestors.`);
  }
  return stats;
}

export function ensureSecureUploadRoot(config) {
  const uploadRoot = path.resolve(config.uploadRoot);
  fs.mkdirSync(uploadRoot, { recursive: true, mode: 0o700 });
  requireSecureDirectory(uploadRoot, 'The upload root');
  fs.chmodSync(uploadRoot, 0o700);
  return uploadRoot;
}

export function ensureSecureRepositoryDirectory(config, repositoryId) {
  const uploadRoot = ensureSecureUploadRoot(config);
  const repositoryRoot = path.resolve(uploadRoot, validateRepositoryId(repositoryId));
  if (path.dirname(repositoryRoot) !== uploadRoot) {
    throw new Error('The repository directory path is not allowed.');
  }

  try {
    fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  requireSecureDirectory(repositoryRoot, 'The repository directory');
  fs.chmodSync(repositoryRoot, 0o700);
  return repositoryRoot;
}

export function resolveStoredFilePath(config, repositoryId, storedName) {
  const uploadRoot = path.resolve(config.uploadRoot);
  requireSecureDirectory(uploadRoot, 'The upload root');

  const repositoryRoot = path.resolve(uploadRoot, validateRepositoryId(repositoryId));
  if (path.dirname(repositoryRoot) !== uploadRoot) {
    throw new Error('The repository directory path is not allowed.');
  }
  requireSecureDirectory(repositoryRoot, 'The repository directory');

  const safeStoredName = validateStoredName(storedName);
  const candidate = path.resolve(repositoryRoot, safeStoredName);
  if (path.dirname(candidate) !== repositoryRoot) {
    throw new Error('The requested file path is not allowed.');
  }

  const candidateStats = lstatIfPresent(candidate);
  if (candidateStats?.isSymbolicLink()) throw new Error('The stored file cannot be a symbolic link.');
  return candidate;
}

export function openStoredFile(config, repositoryId, storedName) {
  const filePath = resolveStoredFilePath(config, repositoryId, storedName);
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw new Error('The stored file must be a regular file.');
    return { fd, filePath, stats };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function normalizeFileReference(fileReference) {
  if (typeof fileReference === 'number' && Number.isInteger(fileReference)) {
    return { fd: fileReference, filePath: null };
  }
  if (typeof fileReference === 'string' && fileReference) {
    return { fd: null, filePath: fileReference };
  }
  if (fileReference && typeof fileReference === 'object') {
    const fd = Number.isInteger(fileReference.fd) ? fileReference.fd : null;
    const filePath = typeof fileReference.filePath === 'string' && fileReference.filePath
      ? fileReference.filePath
      : null;
    if (fd !== null || filePath) return { fd, filePath };
  }
  throw new TypeError('A valid stored-file reference is required.');
}

function fileStats(fileReference) {
  const reference = normalizeFileReference(fileReference);
  return reference.fd !== null
    ? fs.fstatSync(reference.fd)
    : fs.statSync(reference.filePath);
}

export function readInitialAccessTimeMs(fileReference) {
  return fileStats(fileReference).atimeMs;
}

function storedInitialAccessTimeMs(db, file, fileReference) {
  const storedValue = Number(file.initial_access_time_ms);
  if (Number.isFinite(storedValue)) return storedValue;

  const detectedValue = readInitialAccessTimeMs(fileReference);
  db.prepare(`
    UPDATE files
    SET initial_access_time_ms = COALESCE(initial_access_time_ms, ?)
    WHERE id = ?
  `).run(detectedValue, file.id);

  const saved = db.prepare(`
    SELECT initial_access_time_ms FROM files WHERE id = ?
  `).get(file.id);
  return Number(saved?.initial_access_time_ms ?? detectedValue);
}

function canRetryFutimeByPath(error, reference) {
  return Boolean(
    reference.filePath
    && ['EPERM', 'EACCES'].includes(error?.code)
    && (!error?.syscall || ['futime', 'futimes'].includes(error.syscall))
  );
}

function requirePathToReferenceOpenFile(reference) {
  const openedStats = fs.fstatSync(reference.fd, { bigint: true });
  const pathStats = fs.lstatSync(reference.filePath, { bigint: true });
  if (
    !openedStats.isFile()
    || !pathStats.isFile()
    || pathStats.isSymbolicLink()
    || openedStats.dev !== pathStats.dev
    || openedStats.ino !== pathStats.ino
  ) {
    const error = new Error('The stored file changed before its access time could be updated.');
    error.code = 'ESTALE';
    throw error;
  }
}

function applyAccessTimeMs(fileReference, targetAccessTimeMs) {
  const reference = normalizeFileReference(fileReference);
  const stats = reference.fd !== null
    ? fs.fstatSync(reference.fd)
    : fs.statSync(reference.filePath);
  if (Math.abs(stats.atimeMs - targetAccessTimeMs) <= ACCESS_TIME_TOLERANCE_MS) return;

  const accessTimeSeconds = targetAccessTimeMs / 1000;
  const modifiedTimeSeconds = stats.mtimeMs / 1000;
  if (reference.fd === null) {
    fs.utimesSync(reference.filePath, accessTimeSeconds, modifiedTimeSeconds);
    return;
  }

  try {
    fs.futimesSync(reference.fd, accessTimeSeconds, modifiedTimeSeconds);
  } catch (error) {
    if (!canRetryFutimeByPath(error, reference)) throw error;

    // On Windows, a descriptor opened read-only can lack FILE_WRITE_ATTRIBUTES,
    // causing futime to fail with EPERM. Verify the path still names the exact
    // open regular file before using the path-based SetFileTime fallback.
    requirePathToReferenceOpenFile(reference);
    fs.utimesSync(reference.filePath, accessTimeSeconds, modifiedTimeSeconds);
  }
}

export async function withTrackedFileAccess(tracker, operation, onCompletionError = null) {
  try {
    const result = await operation();
    tracker.complete();
    return result;
  } catch (error) {
    try {
      tracker.complete();
    } catch (completionError) {
      if (typeof onCompletionError === 'function') {
        onCompletionError(completionError, error);
      } else {
        console.error(
          'File access time update failed after the file operation failed.',
          completionError
        );
      }
    }
    // Preserve the domain error from the operation (for example
    // SEVEN_ZIP_METADATA_LIMIT) instead of replacing it with AggregateError.
    throw error;
  }
}

export function createFileAccessTracker(db, repository, file, fileReference) {
  const accessedAtMs = Date.now();
  const initialAccessTimeMs = storedInitialAccessTimeMs(db, file, fileReference);
  let completed = false;

  return {
    complete() {
      if (completed) return;
      completed = true;

      const currentRepository = db.prepare(`
        SELECT update_file_access_time FROM repositories WHERE id = ?
      `).get(repository.id);
      if (!currentRepository) return;

      const targetAccessTimeMs = currentRepository.update_file_access_time
        ? accessedAtMs
        : initialAccessTimeMs;
      applyAccessTimeMs(fileReference, targetAccessTimeMs);
    }
  };
}

export function restoreRepositoryInitialAccessTimes(db, config, repositoryId) {
  const files = db.prepare(`
    SELECT id, repository_id, stored_name, initial_access_time_ms
    FROM files
    WHERE repository_id = ?
  `).all(repositoryId);

  for (const file of files) {
    let opened;
    try {
      opened = openStoredFile(config, file.repository_id, file.stored_name);
      const initialAccessTimeMs = storedInitialAccessTimeMs(db, file, opened);
      applyAccessTimeMs(opened, initialAccessTimeMs);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      if (opened) fs.closeSync(opened.fd);
    }
  }
}
