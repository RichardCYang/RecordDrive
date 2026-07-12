import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ensureSecureUploadRoot, openStoredFile } from './file-access-time.js';
import { normalizeAndValidateStorageConfiguration } from './storage-path-security.js';

const SETTINGS_KEY = 'storage.repositoryRoot';
const MAX_PATH_LENGTH = 4096;
const MIGRATION_MODES = new Set(['move', 'use-existing']);

export class StorageSettingsError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'StorageSettingsError';
    this.statusCode = 400;
  }
}

function comparablePath(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(leftPath, rightPath) {
  return comparablePath(leftPath) === comparablePath(rightPath);
}

function isSameOrDescendant(parentPath, candidatePath) {
  const parent = comparablePath(parentPath);
  const candidate = comparablePath(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function expandEnvironmentVariables(value) {
  return value
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? match)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => process.env[name] ?? match)
    .replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
}

function cleanConfiguredPath(value) {
  const cleaned = String(value ?? '').trim();
  if (!cleaned) throw new StorageSettingsError('Enter an absolute local filesystem path.');
  if (cleaned.length > MAX_PATH_LENGTH) {
    throw new StorageSettingsError('The repository storage path is too long.');
  }
  if (/\u0000|[\u0001-\u001f\u007f]/.test(cleaned)) {
    throw new StorageSettingsError('The repository storage path contains unsupported control characters.');
  }

  const expanded = expandEnvironmentVariables(cleaned);
  if (!path.isAbsolute(expanded)) {
    throw new StorageSettingsError('The repository storage path must be absolute.');
  }
  return expanded;
}

function validatedRepositoryRoot(config, value) {
  const expanded = cleanConfiguredPath(value);
  try {
    return normalizeAndValidateStorageConfiguration({
      ...config,
      uploadRoot: expanded
    }).uploadRoot;
  } catch (error) {
    throw new StorageSettingsError(error.message, { cause: error });
  }
}

function readStoredRepositoryRoot(db) {
  const row = db.prepare(`
    SELECT setting_value
    FROM app_settings
    WHERE setting_key = ?
  `).get(SETTINGS_KEY);
  if (!row) return null;

  try {
    const parsed = JSON.parse(row.setting_value);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed.repositoryRoot === 'string') return parsed.repositoryRoot;
  } catch {
    if (typeof row.setting_value === 'string' && row.setting_value.trim()) {
      return row.setting_value.trim();
    }
  }
  throw new Error('The saved repository storage setting is invalid.');
}

function saveStoredRepositoryRoot(db, repositoryRoot) {
  db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `).run(SETTINGS_KEY, JSON.stringify({ repositoryRoot }));
}

function ensureCanonicalDirectory(directoryPath, label) {
  const stats = fs.lstatSync(directoryPath, { throwIfNoEntry: false });
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new StorageSettingsError(`${label} must be a real directory and cannot be a symbolic link.`);
  }
  if (!isSamePath(fs.realpathSync(directoryPath), directoryPath)) {
    throw new StorageSettingsError(`${label} must use a canonical path without symbolic-link ancestors.`);
  }
}

function verifyWritableDirectory(directoryPath) {
  const probePath = path.join(directoryPath, `.recorddrive-write-test-${crypto.randomUUID()}`);
  try {
    const descriptor = fs.openSync(
      probePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    fs.closeSync(descriptor);
  } catch (error) {
    throw new StorageSettingsError('The RecordDrive process cannot write to the selected repository storage path.', {
      cause: error
    });
  } finally {
    try {
      fs.rmSync(probePath, { force: true });
    } catch {
      // Preserve the original validation result if probe cleanup also fails.
    }
  }
}

function storageManifest(rootPath) {
  const entries = [];

  function walk(currentPath, relativePath) {
    const stats = fs.lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      throw new StorageSettingsError('Repository storage cannot contain symbolic links.');
    }
    if (stats.isDirectory()) {
      if (relativePath) entries.push(`D:${relativePath}`);
      const children = fs.readdirSync(currentPath).sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        walk(path.join(currentPath, child), relativePath ? path.join(relativePath, child) : child);
      }
      return;
    }
    if (stats.isFile()) {
      entries.push(`F:${relativePath}:${stats.size}`);
      return;
    }
    throw new StorageSettingsError('Repository storage can contain only directories and regular files.');
  }

  walk(rootPath, '');
  return entries;
}

function manifestsMatch(left, right) {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
}

function prepareRelocationTarget(targetRoot) {
  const targetParent = path.dirname(targetRoot);
  fs.mkdirSync(targetParent, { recursive: true, mode: 0o700 });
  ensureCanonicalDirectory(targetParent, 'The repository storage parent directory');

  const targetStats = fs.lstatSync(targetRoot, { throwIfNoEntry: false });
  if (!targetStats) return;
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    throw new StorageSettingsError('The selected repository storage path must be an empty directory or a path that does not exist.');
  }
  ensureCanonicalDirectory(targetRoot, 'The selected repository storage directory');
  if (fs.readdirSync(targetRoot).length > 0) {
    throw new StorageSettingsError('The selected repository storage path must be empty when moving existing data.');
  }
  fs.rmdirSync(targetRoot);
}

function copyStorageRoot(sourceRoot, targetRoot, expectedManifest) {
  try {
    fs.cpSync(sourceRoot, targetRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true
    });
    const copiedManifest = storageManifest(targetRoot);
    if (!manifestsMatch(expectedManifest, copiedManifest)) {
      throw new StorageSettingsError('Repository storage verification failed after copying the data.');
    }
  } catch (error) {
    try {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    } catch {
      // Preserve the original copy error if cleanup also fails.
    }
    if (error instanceof StorageSettingsError) throw error;
    throw new StorageSettingsError('Repository data could not be copied to the selected storage path.', {
      cause: error
    });
  }
}

function relocateStorageRoot(sourceRoot, targetRoot) {
  if (isSameOrDescendant(sourceRoot, targetRoot) || isSameOrDescendant(targetRoot, sourceRoot)) {
    throw new StorageSettingsError('The current and new repository storage paths cannot contain one another.');
  }

  ensureCanonicalDirectory(sourceRoot, 'The current repository storage directory');
  const sourceManifest = storageManifest(sourceRoot);
  prepareRelocationTarget(targetRoot);

  try {
    fs.renameSync(sourceRoot, targetRoot);
    fs.chmodSync(targetRoot, 0o700);
    return {
      cleanupRequired: false,
      rollback() {
        prepareRelocationTarget(sourceRoot);
        fs.renameSync(targetRoot, sourceRoot);
        fs.chmodSync(sourceRoot, 0o700);
      }
    };
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw new StorageSettingsError('Repository data could not be moved to the selected storage path.', {
        cause: error
      });
    }
  }

  copyStorageRoot(sourceRoot, targetRoot, sourceManifest);
  fs.chmodSync(targetRoot, 0o700);
  let cleanupRequired = false;
  try {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  } catch {
    cleanupRequired = true;
  }

  return {
    cleanupRequired,
    rollback() {
      if (fs.existsSync(sourceRoot)) {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
      copyStorageRoot(targetRoot, sourceRoot, sourceManifest);
      fs.chmodSync(sourceRoot, 0o700);
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  };
}

function requireMatchingExistingStorageTree(db, repositoryRoot) {
  const rootStats = fs.lstatSync(repositoryRoot, { throwIfNoEntry: false });
  if (!rootStats) return;
  ensureCanonicalDirectory(repositoryRoot, 'The selected repository storage directory');

  const repositoryIds = new Set(
    db.prepare('SELECT id FROM repositories').all().map(({ id }) => String(id))
  );
  const expectedFiles = new Map();
  for (const file of db.prepare('SELECT repository_id, stored_name FROM files').all()) {
    const repositoryId = String(file.repository_id);
    if (!expectedFiles.has(repositoryId)) expectedFiles.set(repositoryId, new Set());
    expectedFiles.get(repositoryId).add(file.stored_name);
  }

  for (const entry of fs.readdirSync(repositoryRoot, { withFileTypes: true })) {
    if (!/^\d+$/.test(entry.name) || !repositoryIds.has(entry.name)) {
      throw new StorageSettingsError('The selected path contains files or directories that are not managed by this database.');
    }
    const repositoryPath = path.join(repositoryRoot, entry.name);
    const repositoryStats = fs.lstatSync(repositoryPath);
    if (repositoryStats.isSymbolicLink() || !repositoryStats.isDirectory()) {
      throw new StorageSettingsError('The selected path contains files or directories that are not managed by this database.');
    }
    ensureCanonicalDirectory(repositoryPath, 'A repository storage directory');

    const expectedRepositoryFiles = expectedFiles.get(entry.name) || new Set();
    for (const storedEntry of fs.readdirSync(repositoryPath, { withFileTypes: true })) {
      const storedPath = path.join(repositoryPath, storedEntry.name);
      const storedStats = fs.lstatSync(storedPath);
      if (storedStats.isSymbolicLink() || !storedStats.isFile() || !expectedRepositoryFiles.has(storedEntry.name)) {
        throw new StorageSettingsError('The selected path contains files or directories that are not managed by this database.');
      }
    }
  }
}

function verifyExistingRepositoryData(db, config, repositoryRoot, { requireExactTree = false } = {}) {
  const candidateConfig = { ...config, uploadRoot: repositoryRoot };
  if (requireExactTree) requireMatchingExistingStorageTree(db, repositoryRoot);
  ensureSecureUploadRoot(candidateConfig);
  verifyWritableDirectory(repositoryRoot);

  const files = db.prepare(`
    SELECT repository_id, stored_name
    FROM files
    ORDER BY repository_id, id
  `).all();
  for (const file of files) {
    let opened;
    try {
      opened = openStoredFile(candidateConfig, file.repository_id, file.stored_name);
    } catch (error) {
      throw new StorageSettingsError('The selected path does not contain every file recorded in the database.', {
        cause: error
      });
    } finally {
      if (opened) fs.closeSync(opened.fd);
    }
  }
}

export function ensureStorageSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export function applyStoredRepositoryStorageRoot(db, config) {
  ensureStorageSettingsTable(db);
  if (!config.environmentUploadRoot) config.environmentUploadRoot = config.uploadRoot;
  const storedRoot = readStoredRepositoryRoot(db);
  if (!storedRoot) return config.uploadRoot;
  const repositoryRoot = validatedRepositoryRoot(config, storedRoot);
  config.uploadRoot = repositoryRoot;
  return repositoryRoot;
}

export function loadRepositoryStorageSettings(db, config) {
  ensureStorageSettingsTable(db);
  const storedRoot = readStoredRepositoryRoot(db);
  return {
    repositoryRoot: config.uploadRoot,
    activeRepositoryRoot: config.uploadRoot,
    environmentRepositoryRoot: config.environmentUploadRoot || config.uploadRoot,
    persisted: Boolean(storedRoot)
  };
}

export function updateRepositoryStorageSettings(db, config, input = {}) {
  ensureStorageSettingsTable(db);
  const migrationMode = MIGRATION_MODES.has(input.migrationMode)
    ? input.migrationMode
    : 'move';
  const currentRoot = path.resolve(config.uploadRoot);
  const repositoryRoot = validatedRepositoryRoot(config, input.repositoryRoot);

  if (isSamePath(currentRoot, repositoryRoot)) {
    verifyExistingRepositoryData(db, config, repositoryRoot);
    saveStoredRepositoryRoot(db, repositoryRoot);
    config.uploadRoot = repositoryRoot;
    return { changed: false, migrationMode, repositoryRoot, cleanupRequired: false };
  }

  if (migrationMode === 'use-existing') {
    verifyExistingRepositoryData(db, config, repositoryRoot, { requireExactTree: true });
    saveStoredRepositoryRoot(db, repositoryRoot);
    config.uploadRoot = repositoryRoot;
    return { changed: true, migrationMode, repositoryRoot, cleanupRequired: false };
  }

  ensureSecureUploadRoot(config);
  const relocation = relocateStorageRoot(currentRoot, repositoryRoot);
  try {
    verifyWritableDirectory(repositoryRoot);
    saveStoredRepositoryRoot(db, repositoryRoot);
  } catch (error) {
    try {
      relocation.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'The repository storage setting could not be saved and the data rollback also failed.'
      );
    }
    throw error;
  }

  config.uploadRoot = repositoryRoot;
  return {
    changed: true,
    migrationMode,
    repositoryRoot,
    cleanupRequired: relocation.cleanupRequired
  };
}
