import fs from 'node:fs';
import path from 'node:path';

const ACCESS_TIME_TOLERANCE_MS = 0.5;

export function resolveStoredFilePath(config, repositoryId, storedName) {
  const repositoryRoot = path.resolve(config.uploadRoot, String(repositoryId));
  const candidate = path.resolve(repositoryRoot, storedName);
  if (!candidate.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error('The requested file path is not allowed.');
  }
  return candidate;
}

export function readInitialAccessTimeMs(filePath) {
  return fs.statSync(filePath).atimeMs;
}

function storedInitialAccessTimeMs(db, file, filePath) {
  const storedValue = Number(file.initial_access_time_ms);
  if (Number.isFinite(storedValue)) return storedValue;

  const detectedValue = readInitialAccessTimeMs(filePath);
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

function applyAccessTimeMs(filePath, targetAccessTimeMs) {
  const stats = fs.statSync(filePath);
  if (Math.abs(stats.atimeMs - targetAccessTimeMs) <= ACCESS_TIME_TOLERANCE_MS) return;
  fs.utimesSync(filePath, targetAccessTimeMs / 1000, stats.mtimeMs / 1000);
}

export function createFileAccessTracker(db, repository, file, filePath) {
  const accessedAtMs = Date.now();
  const initialAccessTimeMs = storedInitialAccessTimeMs(db, file, filePath);
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
      applyAccessTimeMs(filePath, targetAccessTimeMs);
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
    const filePath = resolveStoredFilePath(config, file.repository_id, file.stored_name);
    if (!fs.existsSync(filePath)) continue;
    const initialAccessTimeMs = storedInitialAccessTimeMs(db, file, filePath);
    applyAccessTimeMs(filePath, initialAccessTimeMs);
  }
}
