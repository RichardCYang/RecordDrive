function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function repositoryIndexRows(db) {
  return db.prepare('PRAGMA index_list(repositories)').all();
}

function indexedColumnNames(db, indexName) {
  return db.prepare(`PRAGMA index_info(${quoteIdentifier(indexName)})`)
    .all()
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map((row) => row.name);
}

export function hasGlobalRepositoryNameUniqueness(db) {
  return repositoryIndexRows(db).some((index) => {
    if (Number(index.unique) !== 1 || Number(index.partial) === 1) return false;
    const columns = indexedColumnNames(db, index.name);
    return columns.length === 1 && columns[0] === 'name';
  });
}

function ensureOwnerScopedIndex(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_repositories_created_by
      ON repositories(created_by);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_owner_name
      ON repositories(created_by, name COLLATE NOCASE)
      WHERE created_by IS NOT NULL;
  `);
}

function restoreForeignKeys(db, enabled) {
  db.exec(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'};`);
}

/**
 * Removes the legacy global repository-name uniqueness constraint without
 * changing repository IDs or their dependent rows. Repository names are
 * confidential tenant metadata, so uniqueness is enforced only within the
 * creator's namespace.
 */
export function ensureOwnerScopedRepositoryNames(db) {
  if (!hasGlobalRepositoryNameUniqueness(db)) {
    ensureOwnerScopedIndex(db);
    return { migrated: false };
  }

  const foreignKeysEnabled = Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) === 1;
  const integrityBefore = db.prepare('PRAGMA foreign_key_check').all();
  if (integrityBefore.length > 0) {
    throw new Error('Repository-name migration refused because foreign-key violations already exist.');
  }

  db.exec('PRAGMA foreign_keys = OFF;');
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    db.exec(`
      CREATE TABLE repositories_owner_scoped_name_migration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        created_by INTEGER,
        update_file_access_time INTEGER NOT NULL DEFAULT 1
          CHECK (update_file_access_time IN (0, 1)),
        max_file_size_mb REAL,
        max_storage_mb REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      INSERT INTO repositories_owner_scoped_name_migration (
        id,
        name,
        description,
        created_by,
        update_file_access_time,
        max_file_size_mb,
        max_storage_mb,
        created_at
      )
      SELECT
        id,
        name,
        description,
        created_by,
        update_file_access_time,
        max_file_size_mb,
        max_storage_mb,
        created_at
      FROM repositories;

      DROP TABLE repositories;
      ALTER TABLE repositories_owner_scoped_name_migration RENAME TO repositories;

      CREATE INDEX idx_repositories_created_by
        ON repositories(created_by);
      CREATE UNIQUE INDEX idx_repositories_owner_name
        ON repositories(created_by, name COLLATE NOCASE)
        WHERE created_by IS NOT NULL;
    `);

    const integrityAfter = db.prepare('PRAGMA foreign_key_check').all();
    if (integrityAfter.length > 0) {
      throw new Error('Repository-name migration created a foreign-key violation.');
    }

    db.exec('COMMIT;');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Preserve the migration error if rollback itself cannot complete.
      }
    }
    throw error;
  } finally {
    restoreForeignKeys(db, foreignKeysEnabled);
  }

  const integrityFinal = db.prepare('PRAGMA foreign_key_check').all();
  if (integrityFinal.length > 0) {
    throw new Error('Repository-name migration failed the final foreign-key integrity check.');
  }

  return { migrated: true };
}
