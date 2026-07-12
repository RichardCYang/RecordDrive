import fs from 'node:fs';
import path from 'node:path';

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

function requireSecureDirectory(directoryPath, label) {
  const stats = lstatIfPresent(directoryPath);
  if (!stats) throw new Error(`${label} does not exist.`);
  if (stats.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory.`);
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

function fileStats(fileReference) {
  return typeof fileReference === 'number'
    ? fs.fstatSync(fileReference)
    : fs.statSync(fileReference);
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

function applyAccessTimeMs(fileReference, targetAccessTimeMs) {
  const stats = fileStats(fileReference);
  if (Math.abs(stats.atimeMs - targetAccessTimeMs) <= ACCESS_TIME_TOLERANCE_MS) return;
  if (typeof fileReference === 'number') {
    fs.futimesSync(fileReference, targetAccessTimeMs / 1000, stats.mtimeMs / 1000);
  } else {
    fs.utimesSync(fileReference, targetAccessTimeMs / 1000, stats.mtimeMs / 1000);
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
      const initialAccessTimeMs = storedInitialAccessTimeMs(db, file, opened.fd);
      applyAccessTimeMs(opened.fd, initialAccessTimeMs);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      if (opened) fs.closeSync(opened.fd);
    }
  }
}
