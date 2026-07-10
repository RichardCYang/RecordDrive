import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';

export function createDatabase(config) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.uploadRoot, { recursive: true });

  const db = new DatabaseSync(config.dbPath, {
    timeout: 5000,
    enableForeignKeyConstraints: true
  });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN', 'USER')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS repository_permissions (
      repository_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 0 CHECK (can_view IN (0, 1)),
      can_upload INTEGER NOT NULL DEFAULT 0 CHECK (can_upload IN (0, 1)),
      can_download INTEGER NOT NULL DEFAULT 0 CHECK (can_download IN (0, 1)),
      can_delete INTEGER NOT NULL DEFAULT 0 CHECK (can_delete IN (0, 1)),
      added_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repository_id, user_id),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      uploaded_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_files_repository_id ON files(repository_id);
    CREATE INDEX IF NOT EXISTS idx_repository_permissions_user_id ON repository_permissions(user_id);

    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_label TEXT NOT NULL,
      repository_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
  `);


  const admin = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('ADMIN');
  if (!admin) {
    const passwordHash = bcrypt.hashSync(config.adminPassword, 12);
    db.prepare(`
      INSERT INTO users (username, display_name, password_hash, role)
      VALUES (?, ?, ?, 'ADMIN')
    `).run(config.adminUsername, config.adminDisplayName, passwordHash);
  }

  return db;
}

export function logActivity(db, { actorId = null, action, targetType, targetLabel, repositoryId = null }) {
  db.prepare(`
    INSERT INTO activity_logs (actor_id, action, target_type, target_label, repository_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(actorId, action, targetType, targetLabel, repositoryId);
}
