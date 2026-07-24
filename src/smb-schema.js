export function ensureSmbSchema(db) {
  const repositoryColumns = new Set(
    db.prepare('PRAGMA table_info(repositories)').all().map((column) => column.name)
  );

  if (!repositoryColumns.has('smb_enabled')) {
    db.exec(`
      ALTER TABLE repositories
      ADD COLUMN smb_enabled INTEGER NOT NULL DEFAULT 0
      CHECK (smb_enabled IN (0, 1));
    `);
  }
  if (!repositoryColumns.has('smb_read_only')) {
    db.exec(`
      ALTER TABLE repositories
      ADD COLUMN smb_read_only INTEGER NOT NULL DEFAULT 0
      CHECK (smb_read_only IN (0, 1));
    `);
  }
  if (!repositoryColumns.has('smb_credential_updated_at')) {
    db.exec('ALTER TABLE repositories ADD COLUMN smb_credential_updated_at TEXT;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS repository_smb_entries (
      repository_id INTEGER NOT NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('FILE', 'FOLDER')),
      object_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      device TEXT,
      inode TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repository_id, entry_type, object_id),
      UNIQUE (repository_id, relative_path COLLATE NOCASE),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_repository_smb_entries_path
      ON repository_smb_entries(repository_id, relative_path COLLATE NOCASE);
  `);
}
