import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logActivity } from './database.js';
import {
  ensureSecureRepositoryDirectory,
  readInitialAccessTimeMs,
  resolveStoredFilePath
} from './file-access-time.js';
import { loadEffectiveQuotaSettings } from './quota-settings.js';
import { MAX_FOLDER_DEPTH } from './repository-folders.js';
import {
  smbRepositoryProjectionPath,
  writeSmbManifest
} from './smb-settings.js';
import { safeOriginalName } from './utils.js';

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_COMPONENT_LENGTH = 180;
const PROJECTION_MARKER = '.recorddrive-projection';
const DEFAULT_MAX_FOLDERS_PER_REPOSITORY = 1000;
const BYTES_PER_MEGABYTE = 1024 * 1024;

class SmbQuotaError extends Error {
  constructor(quota) {
    super(`SMB import rejected by ${quota} quota.`);
    this.name = 'SmbQuotaError';
    this.code = 'SMB_QUOTA_EXCEEDED';
    this.quota = quota;
  }
}

function statIdentity(stats) {
  return { device: String(stats.dev), inode: String(stats.ino) };
}

function identityKey(statsOrRow) {
  const device = String(statsOrRow?.device ?? statsOrRow?.dev ?? '');
  const inode = String(statsOrRow?.inode ?? statsOrRow?.ino ?? '');
  return device && inode ? `${device}:${inode}` : '';
}

function sameIdentity(left, right) {
  const leftKey = identityKey(left);
  return Boolean(leftKey && leftKey === identityKey(right));
}

function lstatIfPresent(targetPath, options = {}) {
  try {
    return fs.lstatSync(targetPath, options);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeRelativePath(value) {
  const normalized = path.posix.normalize(String(value || '').replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return '';
  }
  return normalized;
}

function relativeToAbsolute(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return root;
  const target = path.resolve(root, ...normalized.split('/'));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('The SMB projection path escaped its repository root.');
  }
  return target;
}

function windowsSafeComponent(value, fallback) {
  let name = String(value || fallback || 'unnamed').normalize('NFC');
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '_');
  if (!name || name === '.' || name === '..') name = fallback || 'unnamed';
  if (WINDOWS_RESERVED_NAMES.test(name)) name = `_${name}`;
  if (name.length > MAX_COMPONENT_LENGTH) {
    const extension = path.extname(name).slice(0, 24);
    const base = name.slice(0, Math.max(1, MAX_COMPONENT_LENGTH - extension.length - 9));
    name = `${base}-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 8)}${extension}`;
  }
  return name;
}

function suffixName(name, index, maximumLength = MAX_COMPONENT_LENGTH) {
  if (index <= 1) return name;
  const extension = path.extname(name);
  const suffix = ` (${index})`;
  const available = Math.max(1, maximumLength - extension.length - suffix.length);
  return `${name.slice(0, name.length - extension.length).slice(0, available)}${suffix}${extension}`;
}

function mappingRows(db, repositoryId) {
  return db.prepare(`
    SELECT repository_id, entry_type, object_id, relative_path, device, inode
    FROM repository_smb_entries
    WHERE repository_id = ?
  `).all(repositoryId);
}

function insertMapping(db, repositoryId, entryType, objectId, relativePath, stats) {
  const identity = statIdentity(stats);
  db.prepare(`
    INSERT INTO repository_smb_entries (
      repository_id, entry_type, object_id, relative_path, device, inode, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(repository_id, entry_type, object_id) DO UPDATE SET
      relative_path = excluded.relative_path,
      device = excluded.device,
      inode = excluded.inode,
      updated_at = CURRENT_TIMESTAMP
  `).run(repositoryId, entryType, objectId, relativePath, identity.device, identity.inode);
}

function updateMappingPath(db, repositoryId, entryType, objectId, relativePath, stats) {
  const identity = statIdentity(stats);
  db.prepare(`
    UPDATE repository_smb_entries
    SET relative_path = ?, device = ?, inode = ?, updated_at = CURRENT_TIMESTAMP
    WHERE repository_id = ? AND entry_type = ? AND object_id = ?
  `).run(relativePath, identity.device, identity.inode, repositoryId, entryType, objectId);
}

function mappingConflict(db, repositoryId, candidate, excludedMapping) {
  const row = db.prepare(`
    SELECT entry_type, object_id
    FROM repository_smb_entries
    WHERE repository_id = ? AND relative_path = ? COLLATE NOCASE
  `).get(repositoryId, candidate);
  if (!row) return false;
  return !excludedMapping
    || row.entry_type !== excludedMapping.entry_type
    || row.object_id !== excludedMapping.object_id;
}

function diskNameConflict(root, candidate, currentRelativePath = '') {
  const parentRelative = normalizeRelativePath(path.posix.dirname(candidate));
  const candidateName = path.posix.basename(candidate).toLowerCase();
  const current = normalizeRelativePath(currentRelativePath).toLowerCase();
  const parentAbsolute = relativeToAbsolute(root, parentRelative);
  const children = fs.readdirSync(parentAbsolute, { withFileTypes: true });
  return children.some((entry) => {
    const entryRelative = parentRelative ? path.posix.join(parentRelative, entry.name) : entry.name;
    return entry.name.toLowerCase() === candidateName && entryRelative.toLowerCase() !== current;
  });
}

function allocateRelativePath(
  db,
  repositoryId,
  root,
  parentPath,
  desiredName,
  excludedMapping = null
) {
  const normalizedParent = normalizeRelativePath(parentPath);
  const baseName = windowsSafeComponent(desiredName, 'unnamed');
  for (let index = 1; index <= 10_000; index += 1) {
    const candidateName = suffixName(baseName, index);
    const candidate = normalizedParent
      ? path.posix.join(normalizedParent, candidateName)
      : candidateName;
    if (mappingConflict(db, repositoryId, candidate, excludedMapping)) continue;
    if (diskNameConflict(root, candidate, excludedMapping?.relative_path || '')) continue;
    return candidate;
  }
  throw new Error('Could not allocate a unique SMB projection name.');
}

function ensureProjectionState(db, config, repository) {
  const root = smbRepositoryProjectionPath(config, repository.id);
  const markerPath = path.join(root, PROJECTION_MARKER);
  const markerStats = lstatIfPresent(markerPath);
  if (!markerStats?.isFile() || markerStats.isSymbolicLink()) {
    for (const entry of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
    db.prepare('DELETE FROM repository_smb_entries WHERE repository_id = ?').run(repository.id);
    fs.writeFileSync(markerPath, `${JSON.stringify({ version: 1, repositoryId: repository.id })}\n`, {
      flag: 'wx',
      mode: 0o600
    });
  }
  fs.chmodSync(markerPath, 0o600);
  return root;
}

function scanProjection(root) {
  const entries = [];
  function visit(relativeDirectory, depth) {
    const absoluteDirectory = relativeToAbsolute(root, relativeDirectory);
    const children = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
    for (const child of children) {
      if (!relativeDirectory && child.name === PROJECTION_MARKER) continue;
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, child.name)
        : child.name;
      const absolutePath = relativeToAbsolute(root, relativePath);
      const stats = lstatIfPresent(absolutePath, { bigint: true });
      if (!stats) continue;
      if (stats.isSymbolicLink()) {
        fs.rmSync(absolutePath, { recursive: true, force: true });
        continue;
      }
      if (stats.isDirectory()) {
        if (depth > MAX_FOLDER_DEPTH) {
          fs.rmSync(absolutePath, { recursive: true, force: true });
          continue;
        }
        entries.push({ type: 'FOLDER', relativePath, absolutePath, stats, depth });
        visit(relativePath, depth + 1);
      } else if (stats.isFile()) {
        entries.push({ type: 'FILE', relativePath, absolutePath, stats, depth });
      } else {
        fs.rmSync(absolutePath, { recursive: true, force: true });
      }
    }
  }
  visit('', 1);
  return entries;
}

function folderRowsInDepthOrder(db, repositoryId) {
  return db.prepare(`
    WITH RECURSIVE folder_tree(id, parent_id, name, depth) AS (
      SELECT id, parent_id, name, 1
      FROM folders
      WHERE repository_id = ? AND parent_id IS NULL
      UNION ALL
      SELECT child.id, child.parent_id, child.name, folder_tree.depth + 1
      FROM folders child
      JOIN folder_tree ON child.parent_id = folder_tree.id
      WHERE child.repository_id = ? AND folder_tree.depth < ?
    )
    SELECT id, parent_id, name, depth
    FROM folder_tree
    ORDER BY depth ASC, id ASC
  `).all(repositoryId, repositoryId, MAX_FOLDER_DEPTH);
}

function updateFolderMappingPrefix(db, repositoryId, mapping, nextPath, stats) {
  const oldPath = mapping.relative_path;
  const descendants = db.prepare(`
    SELECT entry_type, object_id, relative_path
    FROM repository_smb_entries
    WHERE repository_id = ? AND relative_path LIKE ? ESCAPE '\\'
    ORDER BY LENGTH(relative_path) ASC
  `).all(
    repositoryId,
    `${oldPath.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}/%`
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    updateMappingPath(db, repositoryId, 'FOLDER', mapping.object_id, nextPath, stats);
    for (const descendant of descendants) {
      const descendantPath = `${nextPath}${descendant.relative_path.slice(oldPath.length)}`;
      db.prepare(`
        UPDATE repository_smb_entries
        SET relative_path = ?, updated_at = CURRENT_TIMESTAMP
        WHERE repository_id = ? AND entry_type = ? AND object_id = ?
      `).run(descendantPath, repositoryId, descendant.entry_type, descendant.object_id);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function removeWebDeletedProjectionEntries(db, config, repository, root) {
  const rows = mappingRows(db, repository.id);
  const fileExists = db.prepare('SELECT 1 FROM files WHERE id = ? AND repository_id = ?');
  const folderExists = db.prepare('SELECT 1 FROM folders WHERE id = ? AND repository_id = ?');
  const removeMapping = db.prepare(`
    DELETE FROM repository_smb_entries
    WHERE repository_id = ? AND entry_type = ? AND object_id = ?
  `);

  for (const row of rows.sort((left, right) => right.relative_path.length - left.relative_path.length)) {
    const exists = row.entry_type === 'FILE'
      ? fileExists.get(row.object_id, repository.id)
      : folderExists.get(row.object_id, repository.id);
    if (exists) continue;
    const absolutePath = relativeToAbsolute(root, row.relative_path);
    const stats = lstatIfPresent(absolutePath, { bigint: true });
    if (stats && sameIdentity(stats, row)) {
      fs.rmSync(absolutePath, { recursive: row.entry_type === 'FOLDER', force: true });
    }
    removeMapping.run(repository.id, row.entry_type, row.object_id);
  }
}

function applyDatabaseChangesToMappedEntries(db, config, repository, root) {
  let mappings = mappingRows(db, repository.id);
  let mappingByObject = new Map(mappings.map((row) => [`${row.entry_type}:${row.object_id}`, row]));
  const stableFolderPaths = new Map();

  for (const folder of folderRowsInDepthOrder(db, repository.id)) {
    let mapping = mappingByObject.get(`FOLDER:${folder.id}`);
    if (!mapping) continue;
    const currentPath = relativeToAbsolute(root, mapping.relative_path);
    const currentStats = lstatIfPresent(currentPath, { bigint: true });
    if (!currentStats?.isDirectory() || !sameIdentity(currentStats, mapping)) continue;
    if (folder.parent_id && !stableFolderPaths.has(folder.parent_id)) continue;

    const parentPath = folder.parent_id ? stableFolderPaths.get(folder.parent_id) : '';
    const nextPath = allocateRelativePath(
      db,
      repository.id,
      root,
      parentPath,
      folder.name,
      mapping
    );
    if (nextPath.toLowerCase() !== mapping.relative_path.toLowerCase()
      || nextPath !== mapping.relative_path) {
      const nextAbsolute = relativeToAbsolute(root, nextPath);
      fs.renameSync(currentPath, nextAbsolute);
      try {
        const nextStats = fs.lstatSync(nextAbsolute, { bigint: true });
        updateFolderMappingPrefix(db, repository.id, mapping, nextPath, nextStats);
      } catch (error) {
        try { fs.renameSync(nextAbsolute, currentPath); } catch { /* retain original error */ }
        throw error;
      }
      mappings = mappingRows(db, repository.id);
      mappingByObject = new Map(mappings.map((row) => [`${row.entry_type}:${row.object_id}`, row]));
      mapping = mappingByObject.get(`FOLDER:${folder.id}`);
    }
    stableFolderPaths.set(folder.id, mapping.relative_path);
  }

  const files = db.prepare(`
    SELECT id, folder_id, original_name, stored_name
    FROM files
    WHERE repository_id = ?
  `).all(repository.id);
  mappings = mappingRows(db, repository.id);
  mappingByObject = new Map(mappings.map((row) => [`${row.entry_type}:${row.object_id}`, row]));

  for (const file of files) {
    const mapping = mappingByObject.get(`FILE:${file.id}`);
    if (!mapping) continue;
    if (file.folder_id && !stableFolderPaths.has(file.folder_id)) continue;
    const currentPath = relativeToAbsolute(root, mapping.relative_path);
    const projectionStats = lstatIfPresent(currentPath, { bigint: true });
    if (!projectionStats?.isFile() || !sameIdentity(projectionStats, mapping)) continue;

    const storedPath = resolveStoredFilePath(config, repository.id, file.stored_name);
    const storedStats = fs.lstatSync(storedPath, { bigint: true });
    const parentPath = file.folder_id ? stableFolderPaths.get(file.folder_id) : '';
    const nextPath = allocateRelativePath(
      db,
      repository.id,
      root,
      parentPath,
      file.original_name,
      mapping
    );
    let nextAbsolute = currentPath;
    if (nextPath.toLowerCase() !== mapping.relative_path.toLowerCase()
      || nextPath !== mapping.relative_path) {
      nextAbsolute = relativeToAbsolute(root, nextPath);
      fs.renameSync(currentPath, nextAbsolute);
    }

    if (!sameIdentity(storedStats, projectionStats)) {
      fs.rmSync(nextAbsolute, { force: true });
      fs.linkSync(storedPath, nextAbsolute);
    }
    const finalStats = fs.lstatSync(nextAbsolute, { bigint: true });
    updateMappingPath(db, repository.id, 'FILE', file.id, nextPath, finalStats);
  }
}

function folderIdForParentPath(db, repositoryId, relativePath) {
  const parentPath = normalizeRelativePath(path.posix.dirname(relativePath));
  if (!parentPath) return null;
  return db.prepare(`
    SELECT object_id FROM repository_smb_entries
    WHERE repository_id = ? AND entry_type = 'FOLDER' AND relative_path = ? COLLATE NOCASE
  `).get(repositoryId, parentPath)?.object_id || null;
}

function uniqueDatabaseFolderName(db, repositoryId, parentId, desiredName, excludedFolderId = null) {
  const normalized = String(desiredName || 'folder').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const base = (normalized || 'folder').slice(0, 100);
  const duplicate = parentId
    ? db.prepare(`
        SELECT id FROM folders
        WHERE repository_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
      `)
    : db.prepare(`
        SELECT id FROM folders
        WHERE repository_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
      `);
  for (let index = 1; index <= 10_000; index += 1) {
    const candidate = suffixName(base, index, 100);
    const row = parentId
      ? duplicate.get(repositoryId, parentId, candidate)
      : duplicate.get(repositoryId, candidate);
    if (!row || row.id === excludedFolderId) return candidate;
  }
  throw new Error('Could not allocate a unique folder name for SMB synchronization.');
}

function configuredFolderLimit(config) {
  const count = Number(config.maxFoldersPerRepository);
  return Number.isSafeInteger(count) && count > 0
    ? count
    : DEFAULT_MAX_FOLDERS_PER_REPOSITORY;
}

function createSmbFolderRecord(db, config, repository, entry) {
  const parentId = folderIdForParentPath(db, repository.id, entry.relativePath);
  if (path.posix.dirname(entry.relativePath) !== '.' && !parentId) return null;
  const folderCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM folders WHERE repository_id = ?
  `).get(repository.id).count);
  if (folderCount >= configuredFolderLimit(config)) {
    fs.rmSync(entry.absolutePath, { recursive: true, force: true });
    logActivity(db, {
      action: 'SMB_REJECT_FOLDER_LIMIT',
      targetType: 'FOLDER',
      targetLabel: path.posix.basename(entry.relativePath),
      repositoryId: repository.id
    });
    return null;
  }

  const id = crypto.randomUUID();
  const name = uniqueDatabaseFolderName(
    db,
    repository.id,
    parentId,
    path.posix.basename(entry.relativePath)
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO folders (id, repository_id, parent_id, name, created_by)
      VALUES (?, ?, ?, ?, NULL)
    `).run(id, repository.id, parentId, name);
    insertMapping(db, repository.id, 'FOLDER', id, entry.relativePath, entry.stats);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  logActivity(db, {
    action: 'SMB_CREATE_FOLDER',
    targetType: 'FOLDER',
    targetLabel: name,
    repositoryId: repository.id
  });
  return id;
}

function configuredQuotaBytes(value) {
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return Number.POSITIVE_INFINITY;
  return megabytes * BYTES_PER_MEGABYTE;
}

function configuredQuotaCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) return Number.POSITIVE_INFINITY;
  return count;
}

function enforceSmbFileQuota(db, config, repository, nextSize, { replacedSize = 0, addsFile = true } = {}) {
  const settings = loadEffectiveQuotaSettings(db, config, repository);
  const size = Number(nextSize);
  const delta = size - Number(replacedSize || 0);
  if (size > configuredQuotaBytes(settings.maxFileSizeMb)) throw new SmbQuotaError('FILE_SIZE');

  const repositoryUsage = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size
    FROM files WHERE repository_id = ?
  `).get(repository.id);
  const totalUsage = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size
    FROM files
  `).get();
  if (Number(repositoryUsage.size || 0) + delta
    > configuredQuotaBytes(settings.maxRepositoryStorageMb)) {
    throw new SmbQuotaError('REPOSITORY_STORAGE');
  }
  if (Number(totalUsage.size || 0) + delta > configuredQuotaBytes(settings.maxTotalStorageMb)) {
    throw new SmbQuotaError('TOTAL_STORAGE');
  }
  if (addsFile && Number(repositoryUsage.count || 0) + 1
    > configuredQuotaCount(settings.maxRepositoryFiles)) {
    throw new SmbQuotaError('REPOSITORY_FILE_COUNT');
  }
  if (addsFile && Number(totalUsage.count || 0) + 1 > configuredQuotaCount(settings.maxTotalFiles)) {
    throw new SmbQuotaError('TOTAL_FILE_COUNT');
  }
}

function rejectSmbFile(db, repository, entry, error) {
  fs.rmSync(entry.absolutePath, { force: true });
  logActivity(db, {
    action: 'SMB_REJECT_FILE_QUOTA',
    targetType: 'FILE',
    targetLabel: `${path.posix.basename(entry.relativePath)} [${error.quota}]`,
    repositoryId: repository.id
  });
}

function importSmbFile(db, config, repository, entry) {
  const parentId = folderIdForParentPath(db, repository.id, entry.relativePath);
  if (path.posix.dirname(entry.relativePath) !== '.' && !parentId) return null;
  enforceSmbFileQuota(db, config, repository, Number(entry.stats.size));
  const repositoryRoot = ensureSecureRepositoryDirectory(config, repository.id);
  const storedName = crypto.randomUUID();
  const storedPath = path.join(repositoryRoot, storedName);
  fs.linkSync(entry.absolutePath, storedPath);
  fs.chmodSync(storedPath, 0o600);
  const id = crypto.randomUUID();
  const originalName = safeOriginalName(path.posix.basename(entry.relativePath));
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      INSERT INTO files (
        id, repository_id, folder_id, original_name, stored_name, mime_type, size,
        uploaded_by, initial_access_time_ms
      ) VALUES (?, ?, ?, ?, ?, 'application/octet-stream', ?, NULL, ?)
    `).run(
      id,
      repository.id,
      parentId,
      originalName,
      storedName,
      Number(entry.stats.size),
      readInitialAccessTimeMs(entry.absolutePath)
    );
    insertMapping(db, repository.id, 'FILE', id, entry.relativePath, entry.stats);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    fs.rmSync(storedPath, { force: true });
    throw error;
  }
  logActivity(db, {
    action: 'SMB_IMPORT_FILE',
    targetType: 'FILE',
    targetLabel: originalName,
    repositoryId: repository.id
  });
  return id;
}

function replaceMappedFile(db, config, repository, mapping, entry, file) {
  enforceSmbFileQuota(db, config, repository, Number(entry.stats.size), {
    replacedSize: Number(file.size || 0),
    addsFile: false
  });
  const repositoryRoot = ensureSecureRepositoryDirectory(config, repository.id);
  const newStoredName = crypto.randomUUID();
  const newStoredPath = path.join(repositoryRoot, newStoredName);
  const oldStoredPath = resolveStoredFilePath(config, repository.id, file.stored_name);
  fs.linkSync(entry.absolutePath, newStoredPath);
  fs.chmodSync(newStoredPath, 0o600);
  const parentId = folderIdForParentPath(db, repository.id, entry.relativePath);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      UPDATE files
      SET folder_id = ?, original_name = ?, stored_name = ?, size = ?, initial_access_time_ms = ?
      WHERE id = ? AND repository_id = ?
    `).run(
      parentId,
      safeOriginalName(path.posix.basename(entry.relativePath)),
      newStoredName,
      Number(entry.stats.size),
      readInitialAccessTimeMs(entry.absolutePath),
      file.id,
      repository.id
    );
    updateMappingPath(db, repository.id, 'FILE', mapping.object_id, entry.relativePath, entry.stats);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    fs.rmSync(newStoredPath, { force: true });
    throw error;
  }
  fs.rmSync(oldStoredPath, { force: true });
}

function deleteFileObject(db, config, repository, objectId, action = 'SMB_DELETE_FILE') {
  const file = db.prepare(`
    SELECT * FROM files WHERE id = ? AND repository_id = ?
  `).get(objectId, repository.id);
  if (file) {
    fs.rmSync(resolveStoredFilePath(config, repository.id, file.stored_name), { force: true });
    db.prepare('DELETE FROM files WHERE id = ? AND repository_id = ?').run(file.id, repository.id);
    logActivity(db, {
      action,
      targetType: 'FILE',
      targetLabel: file.original_name,
      repositoryId: repository.id
    });
  }
  db.prepare(`
    DELETE FROM repository_smb_entries
    WHERE repository_id = ? AND entry_type = 'FILE' AND object_id = ?
  `).run(repository.id, objectId);
}

function filesInFolderTree(db, repositoryId, folderId) {
  return db.prepare(`
    WITH RECURSIVE folder_tree(id) AS (
      SELECT id FROM folders WHERE id = ? AND repository_id = ?
      UNION ALL
      SELECT child.id
      FROM folders child
      JOIN folder_tree ON child.parent_id = folder_tree.id
      WHERE child.repository_id = ?
    )
    SELECT files.*
    FROM files
    JOIN folder_tree ON files.folder_id = folder_tree.id
    WHERE files.repository_id = ?
  `).all(folderId, repositoryId, repositoryId, repositoryId);
}

function deleteFolderObject(db, config, repository, mapping, action = 'SMB_DELETE_FOLDER') {
  const folder = db.prepare(`
    SELECT id, name FROM folders WHERE id = ? AND repository_id = ?
  `).get(mapping.object_id, repository.id);
  if (folder) {
    for (const file of filesInFolderTree(db, repository.id, folder.id)) {
      fs.rmSync(resolveStoredFilePath(config, repository.id, file.stored_name), { force: true });
    }
    db.prepare('DELETE FROM folders WHERE id = ? AND repository_id = ?').run(folder.id, repository.id);
    logActivity(db, {
      action,
      targetType: 'FOLDER',
      targetLabel: folder.name,
      repositoryId: repository.id
    });
  }
  const escaped = mapping.relative_path.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  db.prepare(`
    DELETE FROM repository_smb_entries
    WHERE repository_id = ?
      AND (relative_path = ? COLLATE NOCASE OR relative_path LIKE ? ESCAPE '\\')
  `).run(repository.id, mapping.relative_path, `${escaped}/%`);
}

function moveFolderFromSmb(db, repository, mapping, entry) {
  const parentId = folderIdForParentPath(db, repository.id, entry.relativePath);
  if (path.posix.dirname(entry.relativePath) !== '.' && !parentId) return false;
  const name = uniqueDatabaseFolderName(
    db,
    repository.id,
    parentId,
    path.posix.basename(entry.relativePath),
    mapping.object_id
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE folders SET parent_id = ?, name = ?
      WHERE id = ? AND repository_id = ?
    `).run(parentId, name, mapping.object_id, repository.id);
    const oldPath = mapping.relative_path;
    const descendants = db.prepare(`
      SELECT entry_type, object_id, relative_path
      FROM repository_smb_entries
      WHERE repository_id = ? AND relative_path LIKE ? ESCAPE '\\'
      ORDER BY LENGTH(relative_path) ASC
    `).all(
      repository.id,
      `${oldPath.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}/%`
    );
    updateMappingPath(db, repository.id, 'FOLDER', mapping.object_id, entry.relativePath, entry.stats);
    for (const descendant of descendants) {
      db.prepare(`
        UPDATE repository_smb_entries
        SET relative_path = ?, updated_at = CURRENT_TIMESTAMP
        WHERE repository_id = ? AND entry_type = ? AND object_id = ?
      `).run(
        `${entry.relativePath}${descendant.relative_path.slice(oldPath.length)}`,
        repository.id,
        descendant.entry_type,
        descendant.object_id
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function moveFileFromSmb(db, repository, mapping, entry) {
  const parentId = folderIdForParentPath(db, repository.id, entry.relativePath);
  if (path.posix.dirname(entry.relativePath) !== '.' && !parentId) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE files
      SET folder_id = ?, original_name = ?, size = ?, initial_access_time_ms = ?
      WHERE id = ? AND repository_id = ?
    `).run(
      parentId,
      safeOriginalName(path.posix.basename(entry.relativePath)),
      Number(entry.stats.size),
      Number(entry.stats.atimeMs),
      mapping.object_id,
      repository.id
    );
    updateMappingPath(db, repository.id, 'FILE', mapping.object_id, entry.relativePath, entry.stats);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function syncProjectionToDatabase(db, config, repository, root) {
  const scan = scanProjection(root);
  const scanFolders = scan.filter((entry) => entry.type === 'FOLDER').sort((a, b) => a.depth - b.depth);
  const scanFiles = scan.filter((entry) => entry.type === 'FILE');

  let mappings = mappingRows(db, repository.id);
  let mappingByPath = new Map(mappings.map((row) => [row.relative_path.toLowerCase(), row]));
  let folderByIdentity = new Map(
    mappings.filter((row) => row.entry_type === 'FOLDER')
      .map((row) => [identityKey(row), row])
      .filter(([key]) => key)
  );
  const folderScanByPath = new Map(scanFolders.map((entry) => [entry.relativePath.toLowerCase(), entry]));
  const stableFolderMappings = new Set();
  for (const mapping of mappings.filter((row) => row.entry_type === 'FOLDER')) {
    const entry = folderScanByPath.get(mapping.relative_path.toLowerCase());
    if (entry && sameIdentity(entry.stats, mapping)) stableFolderMappings.add(mapping.object_id);
  }

  // First apply inode-preserving folder moves. Doing this before path replacements
  // correctly handles "rename old A to B, then create a new A" in one interval.
  for (const entry of scanFolders) {
    const moved = folderByIdentity.get(identityKey(entry.stats));
    if (!moved || stableFolderMappings.has(moved.object_id)
      || moved.relative_path.toLowerCase() === entry.relativePath.toLowerCase()) continue;
    if (moveFolderFromSmb(db, repository, moved, entry)) {
      mappings = mappingRows(db, repository.id);
      mappingByPath = new Map(mappings.map((row) => [row.relative_path.toLowerCase(), row]));
      folderByIdentity = new Map(
        mappings.filter((row) => row.entry_type === 'FOLDER')
          .map((row) => [identityKey(row), row])
          .filter(([key]) => key)
      );
    }
  }

  const seenFolders = new Set();
  for (const entry of scanFolders) {
    let pathMapping = mappingByPath.get(entry.relativePath.toLowerCase());
    if (pathMapping?.entry_type === 'FOLDER' && sameIdentity(pathMapping, entry.stats)) {
      const parentId = folderIdForParentPath(db, repository.id, entry.relativePath);
      if (path.posix.dirname(entry.relativePath) !== '.' && !parentId) continue;
      const name = uniqueDatabaseFolderName(
        db,
        repository.id,
        parentId,
        path.posix.basename(entry.relativePath),
        pathMapping.object_id
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          UPDATE folders SET parent_id = ?, name = ?
          WHERE id = ? AND repository_id = ?
        `).run(parentId, name, pathMapping.object_id, repository.id);
        updateMappingPath(
          db,
          repository.id,
          'FOLDER',
          pathMapping.object_id,
          entry.relativePath,
          entry.stats
        );
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      seenFolders.add(pathMapping.object_id);
      continue;
    }
    if (pathMapping?.entry_type === 'FOLDER') {
      deleteFolderObject(db, config, repository, pathMapping, 'SMB_REPLACE_FOLDER');
    } else if (pathMapping?.entry_type === 'FILE') {
      deleteFileObject(db, config, repository, pathMapping.object_id, 'SMB_REPLACE_FILE_WITH_FOLDER');
    }
    try {
      const id = createSmbFolderRecord(db, config, repository, entry);
      if (id) seenFolders.add(id);
    } catch (error) {
      if (!/UNIQUE constraint failed/i.test(error.message)) throw error;
    }
    mappings = mappingRows(db, repository.id);
    mappingByPath = new Map(mappings.map((row) => [row.relative_path.toLowerCase(), row]));
  }

  mappings = mappingRows(db, repository.id);
  mappingByPath = new Map(mappings.map((row) => [row.relative_path.toLowerCase(), row]));
  let fileByIdentity = new Map(
    mappings.filter((row) => row.entry_type === 'FILE')
      .map((row) => [identityKey(row), row])
      .filter(([key]) => key)
  );
  const fileScanByPath = new Map(scanFiles.map((entry) => [entry.relativePath.toLowerCase(), entry]));
  const stableFileMappings = new Set();
  for (const mapping of mappings.filter((row) => row.entry_type === 'FILE')) {
    const entry = fileScanByPath.get(mapping.relative_path.toLowerCase());
    if (entry && sameIdentity(entry.stats, mapping)) stableFileMappings.add(mapping.object_id);
  }

  for (const entry of scanFiles) {
    const moved = fileByIdentity.get(identityKey(entry.stats));
    if (!moved || stableFileMappings.has(moved.object_id)
      || moved.relative_path.toLowerCase() === entry.relativePath.toLowerCase()) continue;
    if (moveFileFromSmb(db, repository, moved, entry)) {
      mappings = mappingRows(db, repository.id);
      mappingByPath = new Map(mappings.map((row) => [row.relative_path.toLowerCase(), row]));
      fileByIdentity = new Map(
        mappings.filter((row) => row.entry_type === 'FILE')
          .map((row) => [identityKey(row), row])
          .filter(([key]) => key)
      );
    }
  }

  const seenFiles = new Set();
  const fileById = new Map(db.prepare(`
    SELECT * FROM files WHERE repository_id = ?
  `).all(repository.id).map((file) => [file.id, file]));

  for (const entry of scanFiles) {
    let pathMapping = mappingByPath.get(entry.relativePath.toLowerCase());
    if (pathMapping?.entry_type === 'FOLDER') {
      deleteFolderObject(db, config, repository, pathMapping, 'SMB_REPLACE_FOLDER_WITH_FILE');
      pathMapping = null;
    }
    if (pathMapping?.entry_type === 'FILE') {
      const file = fileById.get(pathMapping.object_id)
        || db.prepare('SELECT * FROM files WHERE id = ? AND repository_id = ?')
          .get(pathMapping.object_id, repository.id);
      if (!file) continue;
      if (!sameIdentity(pathMapping, entry.stats)) {
        try {
          replaceMappedFile(db, config, repository, pathMapping, entry, file);
        } catch (error) {
          if (!(error instanceof SmbQuotaError)) throw error;
          fs.rmSync(entry.absolutePath, { force: true });
          const oldStoredPath = resolveStoredFilePath(config, repository.id, file.stored_name);
          fs.linkSync(oldStoredPath, entry.absolutePath);
          const restoredStats = fs.lstatSync(entry.absolutePath, { bigint: true });
          updateMappingPath(db, repository.id, 'FILE', file.id, entry.relativePath, restoredStats);
          logActivity(db, {
            action: 'SMB_REJECT_FILE_QUOTA',
            targetType: 'FILE',
            targetLabel: `${file.original_name} [${error.quota}]`,
            repositoryId: repository.id
          });
        }
      } else {
        const parentId = folderIdForParentPath(db, repository.id, entry.relativePath);
        db.prepare(`
          UPDATE files
          SET folder_id = ?, original_name = ?, size = ?, initial_access_time_ms = ?
          WHERE id = ? AND repository_id = ?
        `).run(
          parentId,
          safeOriginalName(path.posix.basename(entry.relativePath)),
          Number(entry.stats.size),
          Number(entry.stats.atimeMs),
          file.id,
          repository.id
        );
        updateMappingPath(db, repository.id, 'FILE', file.id, entry.relativePath, entry.stats);
      }
      seenFiles.add(pathMapping.object_id);
      continue;
    }

    try {
      const id = importSmbFile(db, config, repository, entry);
      if (id) seenFiles.add(id);
    } catch (error) {
      if (error instanceof SmbQuotaError) {
        rejectSmbFile(db, repository, entry, error);
        continue;
      }
      if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error;
    }
    mappings = mappingRows(db, repository.id);
    mappingByPath = new Map(mappings.map((row) => [row.relative_path.toLowerCase(), row]));
  }

  for (const mapping of mappingRows(db, repository.id).filter((row) => row.entry_type === 'FILE')) {
    if (seenFiles.has(mapping.object_id)) continue;
    deleteFileObject(db, config, repository, mapping.object_id);
  }

  for (const mapping of mappingRows(db, repository.id)
    .filter((row) => row.entry_type === 'FOLDER')
    .sort((left, right) => right.relative_path.split('/').length - left.relative_path.split('/').length)) {
    if (seenFolders.has(mapping.object_id)) continue;
    deleteFolderObject(db, config, repository, mapping);
  }
}

function ensureUnmappedDatabaseProjection(db, config, repository, root) {
  let mappings = mappingRows(db, repository.id);
  let mappingByObject = new Map(mappings.map((row) => [`${row.entry_type}:${row.object_id}`, row]));
  const folderPaths = new Map();

  for (const folder of folderRowsInDepthOrder(db, repository.id)) {
    let mapping = mappingByObject.get(`FOLDER:${folder.id}`);
    if (!mapping) {
      const parentPath = folder.parent_id ? folderPaths.get(folder.parent_id) : '';
      if (folder.parent_id && parentPath === undefined) continue;
      const relativePath = allocateRelativePath(
        db,
        repository.id,
        root,
        parentPath,
        folder.name
      );
      const absolutePath = relativeToAbsolute(root, relativePath);
      fs.mkdirSync(absolutePath, { mode: 0o700 });
      const stats = fs.lstatSync(absolutePath, { bigint: true });
      insertMapping(db, repository.id, 'FOLDER', folder.id, relativePath, stats);
      mappings = mappingRows(db, repository.id);
      mappingByObject = new Map(mappings.map((row) => [`${row.entry_type}:${row.object_id}`, row]));
      mapping = mappingByObject.get(`FOLDER:${folder.id}`);
    }
    folderPaths.set(folder.id, mapping.relative_path);
  }

  const files = db.prepare(`
    SELECT id, folder_id, original_name, stored_name
    FROM files
    WHERE repository_id = ?
  `).all(repository.id);
  mappingByObject = new Map(mappingRows(db, repository.id).map((row) => [`${row.entry_type}:${row.object_id}`, row]));
  for (const file of files) {
    if (mappingByObject.has(`FILE:${file.id}`)) continue;
    const parentPath = file.folder_id ? folderPaths.get(file.folder_id) : '';
    if (file.folder_id && parentPath === undefined) continue;
    const relativePath = allocateRelativePath(
      db,
      repository.id,
      root,
      parentPath,
      file.original_name
    );
    const projectionPath = relativeToAbsolute(root, relativePath);
    const storedPath = resolveStoredFilePath(config, repository.id, file.stored_name);
    fs.linkSync(storedPath, projectionPath);
    const stats = fs.lstatSync(projectionPath, { bigint: true });
    insertMapping(db, repository.id, 'FILE', file.id, relativePath, stats);
  }
}

export function reconcileSmbRepository(db, config, repository) {
  const root = ensureProjectionState(db, config, repository);
  removeWebDeletedProjectionEntries(db, config, repository, root);
  applyDatabaseChangesToMappedEntries(db, config, repository, root);
  syncProjectionToDatabase(db, config, repository, root);
  ensureUnmappedDatabaseProjection(db, config, repository, root);
}

function ensureSmbShareRoot(config) {
  const root = path.resolve(config.smbShareRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('SMB_SHARE_ROOT must be a real directory.');
  }
  fs.chmodSync(root, 0o700);
  return root;
}

function cleanupDisabledProjections(db, config) {
  const enabledIds = new Set(db.prepare(`
    SELECT id FROM repositories WHERE smb_enabled = 1
  `).all().map((row) => Number(row.id)));
  const root = ensureSmbShareRoot(config);
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const repositoryId = Number(directory.name);
    if (enabledIds.has(repositoryId)) continue;
    fs.rmSync(path.join(root, directory.name), { recursive: true, force: true });
    if (Number.isSafeInteger(repositoryId) && repositoryId > 0) {
      db.prepare('DELETE FROM repository_smb_entries WHERE repository_id = ?').run(repositoryId);
    }
  }
}

export function startSmbSyncService(db, config) {
  if (!config.smbEnabled) return null;
  let closed = false;
  let running = false;

  const run = () => {
    if (closed || running) return;
    running = true;
    try {
      cleanupDisabledProjections(db, config);
      const repositories = db.prepare(`
        SELECT * FROM repositories WHERE smb_enabled = 1 ORDER BY id ASC
      `).all();
      for (const repository of repositories) {
        try {
          reconcileSmbRepository(db, config, repository);
        } catch (error) {
          console.error(`SMB synchronization failed for repository ${repository.id}.`, error);
        }
      }
      writeSmbManifest(db, config);
    } finally {
      running = false;
    }
  };

  run();
  const intervalMs = Number.isSafeInteger(Number(config.smbSyncIntervalMs))
    ? Math.max(250, Number(config.smbSyncIntervalMs))
    : 1000;
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  return {
    reconcileNow: run,
    close() {
      closed = true;
      clearInterval(timer);
    }
  };
}
