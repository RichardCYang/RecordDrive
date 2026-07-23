import { DatabaseSync } from 'node:sqlite';
import { createRepositoryRecord } from '../src/repository-creation.js';
import { ensureOwnerScopedRepositoryNames } from '../src/repository-name-security.js';

const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
const limits = { maxRepositoriesPerUser: 1000, maxTotalRepositories: 10000 };

db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    update_file_access_time INTEGER NOT NULL DEFAULT 1,
    max_file_size_mb REAL,
    max_storage_mb REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );
  INSERT INTO users (id, username) VALUES (1, 'owner'), (2, 'attacker');
  INSERT INTO repositories (name, description, created_by)
  VALUES ('Project Apollo', 'confidential customer project', 1);
`);

console.log('RecordDrive repository-name confidentiality PoC');
console.log('Candidate: Project Apollo');

try {
  createRepositoryRecord(db, limits, {
    name: 'project apollo',
    description: '',
    userId: 2
  });
  console.log('[legacy] unexpected: duplicate candidate was accepted');
} catch (error) {
  console.log(`[legacy] candidate rejected: ${error.message}`);
  console.log('[legacy] result: another tenant can distinguish an existing repository name');
}

const migration = ensureOwnerScopedRepositoryNames(db);
const newRepositoryId = createRepositoryRecord(db, limits, {
  name: 'project apollo',
  description: 'attacker namespace',
  userId: 2
});

console.log(`[patched] migration applied: ${migration.migrated}`);
console.log(`[patched] same candidate accepted in requester namespace as repository ${newRepositoryId}`);
console.log('[patched] result: the create response no longer reveals another tenant\'s name');
console.log(`[patched] foreign-key violations: ${db.prepare('PRAGMA foreign_key_check').all().length}`);

db.close();
