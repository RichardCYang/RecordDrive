import fs from 'node:fs';
import path from 'node:path';
import { logActivity } from './database.js';
import { ensureSecureUploadRoot } from './file-access-time.js';

function removableRepositoryPath(config, repositoryId) {
  const id = Number(repositoryId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('The repository identifier is not allowed.');
  }

  const uploadRoot = ensureSecureUploadRoot(config);
  const repositoryPath = path.resolve(uploadRoot, String(id));
  if (path.dirname(repositoryPath) !== uploadRoot) {
    throw new Error('The repository directory path is not allowed.');
  }

  const stats = fs.lstatSync(repositoryPath, { throwIfNoEntry: false });
  if (stats?.isSymbolicLink()) throw new Error('The repository directory cannot be a symbolic link.');
  if (stats && !stats.isDirectory()) throw new Error('The repository storage path must be a directory.');
  return repositoryPath;
}

export function deleteRepository(db, config, repository, actorId) {
  fs.rmSync(removableRepositoryPath(config, repository.id), { recursive: true, force: true });
  db.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id);
  logActivity(db, {
    actorId,
    action: 'DELETE_REPOSITORY',
    targetType: 'REPOSITORY',
    targetLabel: repository.name
  });
}
