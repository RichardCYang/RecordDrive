import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { purgeAdministratorSessions } from './admin-access.js';
import { sessionAbsoluteDurationMs } from './config.js';
import { ensureSecureUploadRoot, openStoredFile, readInitialAccessTimeMs } from './file-access-time.js';
import { normalizeAndValidateStorageConfiguration } from './storage-path-security.js';
import { applyStoredRepositoryStorageRoot, ensureStorageSettingsTable } from './storage-settings.js';
import { ensureQuotaSettings } from './quota-settings.js';

const activityLogRetentionByDatabase = new WeakMap();

function deleteOldestActivityLogs(db, numberToDelete) {
  if (numberToDelete <= 0) return 0;
  return db.prepare(`
    DELETE FROM activity_logs
    WHERE id IN (
      SELECT id
      FROM activity_logs
      ORDER BY id ASC
      LIMIT ?
    )
  `).run(numberToDelete).changes;
}

function configureActivityLogRetention(db, maxEntries) {
  const safeMaximum = Number.isSafeInteger(maxEntries) && maxEntries > 0
    ? maxEntries
    : 100000;
  let rowCount = db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get().count;
  if (rowCount > safeMaximum) {
    deleteOldestActivityLogs(db, rowCount - safeMaximum);
    rowCount = db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get().count;
  }

  const trimBatch = Math.max(1, Math.min(1000, Math.floor(safeMaximum / 10)));
  activityLogRetentionByDatabase.set(db, {
    maxEntries: safeMaximum,
    trimTo: Math.max(0, safeMaximum - trimBatch),
    rowCount
  });
}

function enforceActivityLogRetention(db) {
  const state = activityLogRetentionByDatabase.get(db);
  if (!state || state.rowCount <= state.maxEntries) return;

  deleteOldestActivityLogs(db, state.rowCount - state.trimTo);
  state.rowCount = db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get().count;
}

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
  restrictPermissions(databaseDirectory, 0o700);

  const db = new DatabaseSync(config.dbPath, {
    timeout: 5000,
    enableForeignKeyConstraints: true
  });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  try {
    ensureStorageSettingsTable(db);
    applyStoredRepositoryStorageRoot(db, config);
    ensureSecureUploadRoot(config);
  } catch (error) {
    db.close();
    throw error;
  }
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
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
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
      max_file_size_mb REAL,
      max_storage_mb REAL,
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

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL,
      parent_id TEXT,
      name TEXT NOT NULL COLLATE NOCASE,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_sibling_name
      ON folders(repository_id, COALESCE(parent_id, ''), name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_folders_repository_parent
      ON folders(repository_id, parent_id);

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL,
      folder_id TEXT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      uploaded_by INTEGER,
      initial_access_time_ms REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_files_repository_id ON files(repository_id);
    CREATE INDEX IF NOT EXISTS idx_repositories_created_by ON repositories(created_by);
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

    CREATE TABLE IF NOT EXISTS revoked_sessions (
      sid TEXT PRIMARY KEY,
      expires INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expires
      ON revoked_sessions(expires);

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


  db.exec('DELETE FROM recovery_codes WHERE used_at IS NOT NULL;');

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
  if (!userColumns.has('must_change_password')) {
    db.exec(`
      ALTER TABLE users
      ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
      CHECK (must_change_password IN (0, 1));
      UPDATE users
      SET must_change_password = 1
      WHERE role = 'USER';
    `);
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
  if (!repositoryColumns.has('max_file_size_mb')) {
    db.exec('ALTER TABLE repositories ADD COLUMN max_file_size_mb REAL;');
  }
  if (!repositoryColumns.has('max_storage_mb')) {
    db.exec('ALTER TABLE repositories ADD COLUMN max_storage_mb REAL;');
  }

  ensureQuotaSettings(db, config);

  const fileColumns = new Set(
    db.prepare('PRAGMA table_info(files)').all().map((column) => column.name)
  );
  if (!fileColumns.has('initial_access_time_ms')) {
    db.exec('ALTER TABLE files ADD COLUMN initial_access_time_ms REAL;');
  }
  if (!fileColumns.has('folder_id')) {
    db.exec(`
      ALTER TABLE files
      ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE;
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);
    CREATE INDEX IF NOT EXISTS idx_folders_repository_parent ON folders(repository_id, parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_sibling_name
      ON folders(repository_id, COALESCE(parent_id, ''), name COLLATE NOCASE);
  `);

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
    purgeAdministratorSessions(
      db,
      config.sessionSecret,
      sessionAbsoluteDurationMs(config)
    );
  }

  configureActivityLogRetention(db, config.maxActivityLogEntries);
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

  const retentionState = activityLogRetentionByDatabase.get(db);
  if (retentionState) {
    retentionState.rowCount += 1;
    enforceActivityLogRetention(db);
  }
}
