import fs from 'node:fs';
import path from 'node:path';
import { logActivity } from './database.js';

export function deleteRepository(db, config, repository, actorId) {
  const repositoryPath = path.join(config.uploadRoot, String(repository.id));
  fs.rmSync(repositoryPath, { recursive: true, force: true });
  db.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id);
  logActivity(db, {
    actorId,
    action: 'DELETE_REPOSITORY',
    targetType: 'REPOSITORY',
    targetLabel: repository.name
  });
}
