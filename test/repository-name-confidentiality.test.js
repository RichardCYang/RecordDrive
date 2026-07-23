import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createRepositoryRecord, RepositoryCreationError } from '../src/repository-creation.js';
import {
  ensureOwnerScopedRepositoryNames,
  hasGlobalRepositoryNameUniqueness
} from '../src/repository-name-security.js';

function createLegacyDatabase() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      update_file_access_time INTEGER NOT NULL DEFAULT 1
        CHECK (update_file_access_time IN (0, 1)),
      max_file_size_mb REAL,
      max_storage_mb REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX idx_repositories_created_by ON repositories(created_by);
    CREATE TABLE repository_permissions (
      repository_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repository_id, user_id),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );
  `);
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(1, 'owner');
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(2, 'attacker');
  db.prepare(`
    INSERT INTO repositories (id, name, description, created_by)
    VALUES (10, 'Project Apollo', 'confidential customer project', 1)
  `).run();
  db.prepare(`
    INSERT INTO repository_permissions (repository_id, user_id, can_view)
    VALUES (10, 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO files (id, repository_id, original_name)
    VALUES ('file-1', 10, 'secret.txt')
  `).run();
  return db;
}

const limits = {
  maxRepositoriesPerUser: 1000,
  maxTotalRepositories: 10000
};

test('legacy global uniqueness exposes repository-name existence across owners', () => {
  const db = createLegacyDatabase();
  try {
    assert.equal(hasGlobalRepositoryNameUniqueness(db), true);
    assert.throws(
      () => createRepositoryRecord(db, limits, {
        name: 'project apollo',
        description: '',
        userId: 2
      }),
      (error) => error instanceof RepositoryCreationError && error.code === 'DUPLICATE_NAME'
    );
  } finally {
    db.close();
  }
});

test('migration preserves dependent rows and scopes names to the repository owner', () => {
  const db = createLegacyDatabase();
  try {
    const result = ensureOwnerScopedRepositoryNames(db);
    assert.deepEqual(result, { migrated: true });
    assert.equal(hasGlobalRepositoryNameUniqueness(db), false);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    assert.deepEqual(
      { ...db.prepare('SELECT id, name, created_by FROM repositories WHERE id = 10').get() },
      { id: 10, name: 'Project Apollo', created_by: 1 }
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM repository_permissions WHERE repository_id = 10').get().count,
      1
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM files WHERE repository_id = 10').get().count,
      1
    );

    const attackerRepositoryId = createRepositoryRecord(db, limits, {
      name: 'project apollo',
      description: 'independent namespace',
      userId: 2
    });
    assert.equal(attackerRepositoryId, 11);

    assert.throws(
      () => createRepositoryRecord(db, limits, {
        name: 'PROJECT APOLLO',
        description: '',
        userId: 1
      }),
      (error) => error instanceof RepositoryCreationError && error.code === 'DUPLICATE_NAME'
    );

    assert.deepEqual(
      db.prepare(`
        SELECT created_by, name
        FROM repositories
        WHERE name = ? COLLATE NOCASE
        ORDER BY created_by
      `).all('Project Apollo').map((row) => ({ ...row })),
      [
        { created_by: 1, name: 'Project Apollo' },
        { created_by: 2, name: 'project apollo' }
      ]
    );

    assert.deepEqual(ensureOwnerScopedRepositoryNames(db), { migrated: false });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
