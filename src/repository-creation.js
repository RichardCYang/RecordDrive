export class RepositoryCreationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RepositoryCreationError';
    this.code = code;
  }
}

function configuredRepositoryLimit(value, fallback) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) return fallback;
  return count;
}

function isRepositoryNameUniquenessError(error) {
  if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  return /UNIQUE constraint failed: repositories\.(?:created_by|name)/i.test(
    String(error?.message || '')
  );
}

export function createRepositoryRecord(db, config, { name, description, userId }) {
  const perUserLimit = configuredRepositoryLimit(config.maxRepositoriesPerUser, 1000);
  const totalLimit = configuredRepositoryLimit(config.maxTotalRepositories, 10000);

  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare(`
      SELECT 1
      FROM repositories
      WHERE created_by = ? AND name = ? COLLATE NOCASE
    `).get(userId, name)) {
      throw new RepositoryCreationError('DUPLICATE_NAME');
    }

    const userCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM repositories WHERE created_by = ?
    `).get(userId).count);
    if (userCount >= perUserLimit) {
      throw new RepositoryCreationError('USER_LIMIT');
    }

    const totalCount = Number(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count);
    if (totalCount >= totalLimit) {
      throw new RepositoryCreationError('TOTAL_LIMIT');
    }

    const result = db.prepare(`
      INSERT INTO repositories (name, description, created_by) VALUES (?, ?, ?)
    `).run(name, description, userId);
    db.exec('COMMIT');
    return Number(result.lastInsertRowid);
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original creation error if rollback cannot complete.
    }
    if (isRepositoryNameUniquenessError(error)) {
      throw new RepositoryCreationError('DUPLICATE_NAME');
    }
    throw error;
  }
}
