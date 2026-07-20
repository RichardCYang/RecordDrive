import crypto from 'node:crypto';
import fs from 'node:fs';
import { logActivity } from './database.js';
import { resolveStoredFilePath } from './file-access-time.js';

const MAX_FOLDER_NAME_LENGTH = 100;
const MAX_FOLDER_ID_LENGTH = 64;
const DEFAULT_MAX_FOLDERS_PER_REPOSITORY = 1000;
export const MAX_FOLDER_DEPTH = 32;

export class RepositoryFolderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RepositoryFolderError';
    this.code = code;
  }
}

export function normalizeFolderId(value) {
  const folderId = String(value || '').trim();
  if (!folderId) return null;
  if (
    folderId.length > MAX_FOLDER_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(folderId)
  ) {
    throw new RepositoryFolderError('FOLDER_NOT_FOUND');
  }
  return folderId;
}

export function normalizeFolderName(value) {
  const name = String(value || '').trim().normalize('NFC');
  if (!name || name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new RepositoryFolderError('INVALID_NAME_LENGTH');
  }
  if (
    name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new RepositoryFolderError('INVALID_NAME');
  }
  return name;
}

function configuredFolderLimit(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0
    ? count
    : DEFAULT_MAX_FOLDERS_PER_REPOSITORY;
}

export function getRepositoryFolder(db, repositoryId, folderId) {
  const normalizedFolderId = normalizeFolderId(folderId);
  if (!normalizedFolderId) return null;
  return db.prepare(`
    SELECT folders.*, users.display_name AS creator_name, users.username AS creator_username
    FROM folders
    LEFT JOIN users ON users.id = folders.created_by
    WHERE folders.id = ? AND folders.repository_id = ?
  `).get(normalizedFolderId, repositoryId) || null;
}

export function getRepositoryFolderBreadcrumbs(db, repositoryId, folderId) {
  const normalizedFolderId = normalizeFolderId(folderId);
  if (!normalizedFolderId) return [];

  return db.prepare(`
    WITH RECURSIVE ancestors(id, parent_id, name, depth) AS (
      SELECT id, parent_id, name, 0
      FROM folders
      WHERE id = ? AND repository_id = ?

      UNION ALL

      SELECT parent.id, parent.parent_id, parent.name, ancestors.depth + 1
      FROM folders parent
      INNER JOIN ancestors ON ancestors.parent_id = parent.id
      WHERE parent.repository_id = ?
        AND ancestors.depth < ?
    )
    SELECT id, parent_id, name
    FROM ancestors
    ORDER BY depth DESC
  `).all(normalizedFolderId, repositoryId, repositoryId, MAX_FOLDER_DEPTH);
}

export function listRepositoryFolders(db, repositoryId, parentId, { search = '', sort = 'newest' } = {}) {
  const normalizedParentId = normalizeFolderId(parentId);
  const sortOptions = {
    newest: 'folders.created_at DESC, folders.name COLLATE NOCASE ASC',
    oldest: 'folders.created_at ASC, folders.name COLLATE NOCASE ASC',
    'name-asc': 'folders.name COLLATE NOCASE ASC',
    'name-desc': 'folders.name COLLATE NOCASE DESC',
    'size-desc': 'folders.name COLLATE NOCASE ASC',
    'size-asc': 'folders.name COLLATE NOCASE ASC'
  };
  const selectedSort = Object.hasOwn(sortOptions, sort) ? sort : 'newest';
  const params = [repositoryId];
  let parentSql = 'folders.parent_id IS NULL';
  if (normalizedParentId) {
    parentSql = 'folders.parent_id = ?';
    params.push(normalizedParentId);
  }
  let searchSql = '';
  if (search) {
    searchSql = 'AND folders.name LIKE ?';
    params.push(`%${search}%`);
  }

  return db.prepare(`
    SELECT
      folders.*,
      users.display_name AS creator_name,
      users.username AS creator_username,
      (SELECT COUNT(*) FROM folders child WHERE child.parent_id = folders.id) AS child_folder_count,
      (SELECT COUNT(*) FROM files child_file WHERE child_file.folder_id = folders.id) AS direct_file_count
    FROM folders
    LEFT JOIN users ON users.id = folders.created_by
    WHERE folders.repository_id = ?
      AND ${parentSql}
      ${searchSql}
    ORDER BY ${sortOptions[selectedSort]}
  `).all(...params);
}

function folderDepth(db, repositoryId, folderId) {
  if (!folderId) return 0;
  const result = db.prepare(`
    WITH RECURSIVE ancestors(id, parent_id, depth) AS (
      SELECT id, parent_id, 1
      FROM folders
      WHERE id = ? AND repository_id = ?

      UNION ALL

      SELECT parent.id, parent.parent_id, ancestors.depth + 1
      FROM folders parent
      INNER JOIN ancestors ON ancestors.parent_id = parent.id
      WHERE parent.repository_id = ?
        AND ancestors.depth <= ?
    )
    SELECT MAX(depth) AS depth FROM ancestors
  `).get(folderId, repositoryId, repositoryId, MAX_FOLDER_DEPTH);
  return Number(result?.depth || 0);
}

export function createRepositoryFolder(db, config, repository, { parentId, name, userId }) {
  const normalizedParentId = normalizeFolderId(parentId);
  const normalizedName = normalizeFolderName(name);

  db.exec('BEGIN IMMEDIATE');
  try {
    if (normalizedParentId) {
      const parent = db.prepare(`
        SELECT id FROM folders WHERE id = ? AND repository_id = ?
      `).get(normalizedParentId, repository.id);
      if (!parent) throw new RepositoryFolderError('FOLDER_NOT_FOUND');
      if (folderDepth(db, repository.id, normalizedParentId) >= MAX_FOLDER_DEPTH) {
        throw new RepositoryFolderError('DEPTH_LIMIT');
      }
    }

    const folderCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM folders WHERE repository_id = ?
    `).get(repository.id).count);
    if (folderCount >= configuredFolderLimit(config.maxFoldersPerRepository)) {
      throw new RepositoryFolderError('FOLDER_LIMIT');
    }

    const duplicate = normalizedParentId
      ? db.prepare(`
          SELECT 1 FROM folders
          WHERE repository_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
        `).get(repository.id, normalizedParentId, normalizedName)
      : db.prepare(`
          SELECT 1 FROM folders
          WHERE repository_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
        `).get(repository.id, normalizedName);
    if (duplicate) throw new RepositoryFolderError('DUPLICATE_NAME');

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO folders (id, repository_id, parent_id, name, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, repository.id, normalizedParentId, normalizedName, userId);
    db.exec('COMMIT');

    logActivity(db, {
      actorId: userId,
      action: 'CREATE_FOLDER',
      targetType: 'FOLDER',
      targetLabel: normalizedName,
      repositoryId: repository.id
    });
    return getRepositoryFolder(db, repository.id, id);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (
      error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || (error?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/i.test(error.message))
    ) {
      throw new RepositoryFolderError('DUPLICATE_NAME');
    }
    throw error;
  }
}

function filesInFolderTree(db, repositoryId, folderId) {
  return db.prepare(`
    WITH RECURSIVE folder_tree(id) AS (
      SELECT id
      FROM folders
      WHERE id = ? AND repository_id = ?

      UNION ALL

      SELECT child.id
      FROM folders child
      INNER JOIN folder_tree ON child.parent_id = folder_tree.id
      WHERE child.repository_id = ?
    )
    SELECT files.*
    FROM files
    INNER JOIN folder_tree ON files.folder_id = folder_tree.id
    WHERE files.repository_id = ?
  `).all(folderId, repositoryId, repositoryId, repositoryId);
}

export function deleteRepositoryFolder(db, config, repository, folder, actorId) {
  const storedFiles = filesInFolderTree(db, repository.id, folder.id);
  const filePaths = storedFiles.map((file) => resolveStoredFilePath(
    config,
    repository.id,
    file.stored_name
  ));

  for (const filePath of filePaths) {
    fs.rmSync(filePath, { force: true });
  }

  const result = db.prepare(`
    DELETE FROM folders WHERE id = ? AND repository_id = ?
  `).run(folder.id, repository.id);
  if (result.changes === 0) throw new RepositoryFolderError('FOLDER_NOT_FOUND');

  logActivity(db, {
    actorId,
    action: 'DELETE_FOLDER',
    targetType: 'FOLDER',
    targetLabel: folder.name,
    repositoryId: repository.id
  });

  return { deletedFileCount: storedFiles.length };
}

export function repositoryFolderUrl(repositoryId, folderId = null) {
  const normalizedFolderId = normalizeFolderId(folderId);
  return normalizedFolderId
    ? `/repositories/${repositoryId}?folder=${encodeURIComponent(normalizedFolderId)}`
    : `/repositories/${repositoryId}`;
}
