import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { purgeAdministratorSessions } from './admin-access.js';
import { ensureSecureUploadRoot, openStoredFile, readInitialAccessTimeMs } from './file-access-time.js';
import { normalizeAndValidateStorageConfiguration } from './storage-path-security.js';

function comparablePath(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function requireSecureDatabasePath(databaseDirectory, databasePath) {
  const directoryStats = fs.lstatSync(databaseDirectory, { throwIfNoEntry: false });
  if (!directoryStats || directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error('The database directory must be a real directory and cannot be a symbolic link.');
  }
  if (comparablePath(fs.realpathSync(databaseDirectory)) !== comparablePath(databaseDirectory)) {
    throw new Error('The database directory must use a canonical path without symbolic-link ancestors.');
  }

  const databaseStats = fs.lstatSync(databasePath, { throwIfNoEntry: false });
  if (databaseStats && (databaseStats.isSymbolicLink() || !databaseStats.isFile())) {
    throw new Error('The database path must be a regular file and cannot be a symbolic link.');
  }
}

function restrictPermissions(targetPath, mode, options = {}) {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    if (options.allowMissing && error.code === 'ENOENT') return;
    if (process.platform === 'win32' && ['EINVAL', 'ENOSYS', 'EPERM'].includes(error.code)) return;
    throw error;
  }
}

export function createDatabase(providedConfig) {
  const config = normalizeAndValidateStorageConfiguration(providedConfig);
  const databaseDirectory = path.dirname(config.dbPath);
  fs.mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
  requireSecureDatabasePath(databaseDirectory, config.dbPath);
  ensureSecureUploadRoot(config);
  restrictPermissions(databaseDirectory, 0o700);

  const db = new DatabaseSync(config.dbPath, {
    timeout: 5000,
    enableForeignKeyConstraints: true
  });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  restrictPermissions(config.dbPath, 0o600);
  restrictPermissions(`${config.dbPath}-wal`, 0o600, { allowMissing: true });
  restrictPermissions(`${config.dbPath}-shm`, 0o600, { allowMissing: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN', 'USER')),
      totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
      totp_secret_encrypted TEXT,
      totp_last_used_step INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      update_file_access_time INTEGER NOT NULL DEFAULT 1 CHECK (update_file_access_time IN (0, 1)),
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
      initial_access_time_ms REAL,
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

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      device_type TEXT NOT NULL DEFAULT '',
      backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id
      ON webauthn_credentials(user_id);

    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id
      ON recovery_codes(user_id, used_at);
  
  `);


  const userColumns = new Set(
    db.prepare('PRAGMA table_info(users)').all().map((column) => column.name)
  );
  if (!userColumns.has('totp_enabled')) {
    db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1));");
  }
  if (!userColumns.has('totp_secret_encrypted')) {
    db.exec('ALTER TABLE users ADD COLUMN totp_secret_encrypted TEXT;');
  }
  if (!userColumns.has('totp_last_used_step')) {
    db.exec('ALTER TABLE users ADD COLUMN totp_last_used_step INTEGER;');
  }

  const repositoryColumns = new Set(
    db.prepare('PRAGMA table_info(repositories)').all().map((column) => column.name)
  );
  if (!repositoryColumns.has('update_file_access_time')) {
    db.exec(`
      ALTER TABLE repositories
      ADD COLUMN update_file_access_time INTEGER NOT NULL DEFAULT 1
      CHECK (update_file_access_time IN (0, 1));
    `);
  }

  const fileColumns = new Set(
    db.prepare('PRAGMA table_info(files)').all().map((column) => column.name)
  );
  if (!fileColumns.has('initial_access_time_ms')) {
    db.exec('ALTER TABLE files ADD COLUMN initial_access_time_ms REAL;');
  }

  const filesWithoutInitialAccessTime = db.prepare(`
    SELECT id, repository_id, stored_name
    FROM files
    WHERE initial_access_time_ms IS NULL
  `).all();
  const saveInitialAccessTime = db.prepare(`
    UPDATE files SET initial_access_time_ms = ? WHERE id = ?
  `);
  for (const file of filesWithoutInitialAccessTime) {
    let opened;
    try {
      opened = openStoredFile(config, file.repository_id, file.stored_name);
      saveInitialAccessTime.run(readInitialAccessTimeMs(opened.fd), file.id);
    } catch {
      // Leave unavailable file records unchanged so startup can continue.
    } finally {
      if (opened) fs.closeSync(opened.fd);
    }
  }

  if (!config.adminAccessDisabled) {
    const admin = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('ADMIN');
    if (!admin) {
      const passwordHash = bcrypt.hashSync(config.adminPassword, 12);
      db.prepare(`
        INSERT INTO users (username, display_name, password_hash, role)
        VALUES (?, ?, ?, 'ADMIN')
      `).run(config.adminUsername, config.adminDisplayName, passwordHash);
    }
  } else {
    purgeAdministratorSessions(db);
  }

  restrictPermissions(config.dbPath, 0o600);
  restrictPermissions(`${config.dbPath}-wal`, 0o600, { allowMissing: true });
  restrictPermissions(`${config.dbPath}-shm`, 0o600, { allowMissing: true });
  return db;
}

export function logActivity(db, { actorId = null, action, targetType, targetLabel, repositoryId = null }) {
  db.prepare(`
    INSERT INTO activity_logs (actor_id, action, target_type, target_label, repository_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(actorId, action, targetType, targetLabel, repositoryId);
}
