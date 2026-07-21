import express from 'express';
import { canUseAdministratorAccess } from '../admin-access.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import multer from 'multer';
import { requireAuth, requireRegularUser } from '../middleware/auth.js';
import { isValidCsrf } from '../middleware/csrf.js';
import { logActivity } from '../database.js';
import {
  createRepositoryManagerMiddleware,
  createRepositoryPermissionMiddleware,
  hasAnyPermission,
  permissionPayload
} from '../repository-access.js';
import { deleteRepository } from '../repository-service.js';
import {
  createFileAccessTracker,
  openStoredFile,
  readInitialAccessTimeMs,
  resolveStoredFilePath,
  restoreRepositoryInitialAccessTimes
} from '../file-access-time.js';
import { filePreviewKind, requestWantsJson, safeOriginalName, setFlash } from '../utils.js';
import {
  createQuotaAwareUploadStorage,
  UploadQuotaError,
  uploadQuotaErrorMessage
} from '../upload-storage.js';
import {
  createSevenZipPreview,
  createXlsxPreview,
  createZipPreview,
  FilePreviewError,
  previewFileSizeLimit
} from '../file-preview.js';
import {
  loadEffectiveQuotaSettings,
  loadRepositoryQuotaSettings,
  QuotaSettingsError,
  updateRepositoryQuotaSettings
} from '../quota-settings.js';
import {
  createRepositoryFolder,
  deleteRepositoryFolder,
  getRepositoryFolder,
  getRepositoryFolderBreadcrumbs,
  listRepositoryFolders,
  MAX_FOLDER_DEPTH,
  RepositoryFolderError,
  repositoryFolderUrl
} from '../repository-folders.js';

function contentDisposition(disposition, filename) {
  const originalName = String(filename || 'preview.pdf');
  const fallback = originalName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encodedName = encodeURIComponent(originalName).replace(/['()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
  });
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodedName}`;
}

function previewErrorMessage(req, error) {
  const messages = {
    XLSX_TOO_LARGE: req.t('This spreadsheet is too large to preview.'),
    INVALID_XLSX: req.t('The spreadsheet preview could not be generated.'),
    EMPTY_XLSX: req.t('The spreadsheet does not contain any worksheets.'),
    INVALID_ZIP: req.t('The ZIP archive preview could not be generated.'),
    ZIP_TOO_LARGE: req.t('The ZIP archive is too large to preview safely.'),
    INVALID_7Z: req.t('The 7z archive preview could not be generated.'),
    SEVEN_ZIP_DISABLED: req.t('7z preview is disabled by the server security policy.'),
    SEVEN_ZIP_TIMEOUT: req.t('The 7z archive took too long to inspect safely.'),
    SEVEN_ZIP_METADATA_LIMIT: req.t('The 7z archive contains too much metadata to preview safely.'),
    PREVIEW_BUSY: req.t('The preview service is busy. Try again shortly.')
  };
  return messages[error.code] || req.t('The file preview could not be generated.');
}

function folderErrorMessage(req, error) {
  const messages = {
    INVALID_NAME_LENGTH: req.t('The folder name must be between 1 and 100 characters.'),
    INVALID_NAME: req.t('Folder names cannot be "." or ".." and cannot contain slashes or control characters.'),
    DUPLICATE_NAME: req.t('A folder with that name already exists here.'),
    FOLDER_NOT_FOUND: req.t('The selected folder does not exist.'),
    FOLDER_LIMIT: req.t('The repository folder limit has been reached.'),
    DEPTH_LIMIT: req.t('Folders can be nested up to {{count}} levels.', { count: MAX_FOLDER_DEPTH })
  };
  return messages[error.code] || req.t('An error occurred while processing the request.');
}

function safeRepositoryFolderUrl(repositoryId, folderId = null) {
  try {
    return repositoryFolderUrl(repositoryId, folderId);
  } catch {
    return `/repositories/${repositoryId}`;
  }
}

function renderFolderNotFound(req, res) {
  return res.status(404).render('error', {
    title: req.t('Folder not found'),
    statusCode: 404,
    message: req.t('The selected folder does not exist.')
  });
}

function cleanupUploadedFiles(files = [], storage = null) {
  for (const file of files) {
    storage?.releaseReservation(file);
    try {
      if (file?.path) fs.rmSync(file.path, { force: true });
    } catch {
      // Ignore cleanup failures so the original error is preserved.
    }
  }
}

function isUploadConnectionAbort(req, error) {
  const transportError = ['Request aborted', 'Request closed'].includes(error?.message)
    || ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP_REQUEST_TIMEOUT'].includes(error?.code);
  return Boolean(transportError && (req.aborted || (req.destroyed && !req.complete)));
}

function logUploadConnectionAbort(req, error) {
  const expectedBytes = Number(req.headers['content-length']);
  const receivedFileBytes = Number(req.uploadReceivedBytes || 0);
  const elapsedMs = Math.max(0, Date.now() - Number(req.uploadStartedAt || Date.now()));
  const repositoryId = Number(req.repository?.id) || 'unknown';
  const expectedText = Number.isSafeInteger(expectedBytes) && expectedBytes >= 0
    ? String(expectedBytes)
    : 'unknown';
  console.warn(
    `Upload connection closed before completion (repository=${repositoryId}, `
    + `receivedFileBytes=${receivedFileBytes}, contentLength=${expectedText}, `
    + `elapsedMs=${elapsedMs}, reason=${error.message || error.code || 'connection closed'}).`
  );
}

async function withTrackedFileAccess(tracker, operation) {
  try {
    const result = await operation();
    tracker.complete();
    return result;
  } catch (error) {
    try {
      tracker.complete();
    } catch (completionError) {
      throw new AggregateError(
        [error, completionError],
        'The file operation and access time update both failed.'
      );
    }
    throw error;
  }
}

class RepositoryCreationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RepositoryCreationError';
    this.code = code;
  }
}

function configuredRepositoryLimit(value, fallback) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) return fallback;
  return count;
}

function createRepositoryRecord(db, config, { name, description, userId }) {
  const perUserLimit = configuredRepositoryLimit(config.maxRepositoriesPerUser, 1000);
  const totalLimit = configuredRepositoryLimit(config.maxTotalRepositories, 10000);

  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM repositories WHERE name = ?').get(name)) {
      throw new RepositoryCreationError('DUPLICATE_NAME');
    }

    const userCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM repositories WHERE created_by = ?
    `).get(userId).count);
    if (userCount >= perUserLimit) {
      throw new RepositoryCreationError('USER_LIMIT');
    }

    const totalCount = Number(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count);
    if (totalCount >= totalLimit) {
      throw new RepositoryCreationError('TOTAL_LIMIT');
    }

    const result = db.prepare(`
      INSERT INTO repositories (name, description, created_by) VALUES (?, ?, ?)
    `).run(name, description, userId);
    db.exec('COMMIT');
    return Number(result.lastInsertRowid);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function configuredQuotaBytes(value) {
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return Number.POSITIVE_INFINITY;
  return megabytes * 1024 * 1024;
}

function configuredQuotaCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) return Number.POSITIVE_INFINITY;
  return count;
}

function enforceUploadQuotas(db, settings, repositoryId, uploadedFiles) {
  const uploadedBytes = uploadedFiles.reduce((total, file) => total + Number(file.size || 0), 0);
  const uploadedCount = uploadedFiles.length;
  const repositoryUsage = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size
    FROM files WHERE repository_id = ?
  `).get(repositoryId);
  const totalUsage = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size
    FROM files
  `).get();
  const repositoryBytes = Number(repositoryUsage.size || 0);
  const totalBytes = Number(totalUsage.size || 0);
  const repositoryCount = Number(repositoryUsage.count || 0);
  const totalCount = Number(totalUsage.count || 0);

  if (repositoryBytes + uploadedBytes > configuredQuotaBytes(settings.maxRepositoryStorageMb)) {
    throw new UploadQuotaError(
      'The repository storage quota would be exceeded.',
      'REPOSITORY_STORAGE'
    );
  }
  if (totalBytes + uploadedBytes > configuredQuotaBytes(settings.maxTotalStorageMb)) {
    throw new UploadQuotaError('The server storage quota would be exceeded.', 'TOTAL_STORAGE');
  }
  if (repositoryCount + uploadedCount > configuredQuotaCount(settings.maxRepositoryFiles)) {
    throw new UploadQuotaError(
      'The repository file count quota would be exceeded.',
      'REPOSITORY_FILE_COUNT'
    );
  }
  if (totalCount + uploadedCount > configuredQuotaCount(settings.maxTotalFiles)) {
    throw new UploadQuotaError('The server file count quota would be exceeded.', 'TOTAL_FILE_COUNT');
  }
}

function streamOpenedFile(opened, tracker, res, next) {
  let finalized = false;
  const finalize = (streamError = null) => {
    if (finalized) return;
    finalized = true;
    let error = streamError;
    try {
      tracker.complete();
    } catch (completionError) {
      console.error(`File access time update failed: ${completionError.message}`);
      if (!error) error = completionError;
    }
    try {
      fs.closeSync(opened.fd);
    } catch (closeError) {
      if (closeError.code !== 'EBADF') {
        console.error(`Stored file close failed: ${closeError.message}`);
        if (!error) error = closeError;
      }
    }
    if (error && !res.headersSent) next(error);
  };

  const stream = fs.createReadStream(opened.filePath, { fd: opened.fd, autoClose: false });
  stream.on('error', finalize);
  res.on('finish', () => finalize());
  res.on('close', () => finalize());
  stream.pipe(res);
}

function readOpenedFile(opened) {
  return fs.readFileSync(opened.fd);
}

function permissionNames(permissions) {
  return Object.entries(permissions)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(', ');
}

function getPermissionPageData(db, repository) {
  const grants = db.prepare(`
    SELECT
      rp.user_id,
      rp.can_view,
      rp.can_upload,
      rp.can_download,
      rp.can_delete,
      rp.created_at,
      rp.updated_at,
      u.username,
      u.display_name
    FROM repository_permissions rp
    INNER JOIN users u ON u.id = rp.user_id
    WHERE rp.repository_id = ?
    ORDER BY u.display_name COLLATE NOCASE
  `).all(repository.id);

  const availableUsers = db.prepare(`
    SELECT id, username, display_name
    FROM users
    WHERE role = 'USER'
      AND id != ?
      AND id NOT IN (
        SELECT user_id FROM repository_permissions WHERE repository_id = ?
      )
    ORDER BY display_name COLLATE NOCASE
  `).all(repository.created_by ?? -1, repository.id);

  return { grants, availableUsers };
}

function validatePermissionTarget(db, repository, userId) {
  if (!Number.isInteger(userId)) return null;
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'USER'").get(userId);
  if (!user || Number(user.id) === Number(repository.created_by)) return null;
  return user;
}

function savePermissionGrant(db, repository, user, permissions, actorId) {
  const existing = db.prepare(`
    SELECT 1 FROM repository_permissions WHERE repository_id = ? AND user_id = ?
  `).get(repository.id, user.id);

  db.prepare(`
    INSERT INTO repository_permissions (
      repository_id,
      user_id,
      can_view,
      can_upload,
      can_download,
      can_delete,
      added_by,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(repository_id, user_id) DO UPDATE SET
      can_view = excluded.can_view,
      can_upload = excluded.can_upload,
      can_download = excluded.can_download,
      can_delete = excluded.can_delete,
      added_by = excluded.added_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    repository.id,
    user.id,
    Number(permissions.view),
    Number(permissions.upload),
    Number(permissions.download),
    Number(permissions.delete),
    actorId
  );

  logActivity(db, {
    actorId,
    action: existing ? 'UPDATE_REPOSITORY_PERMISSION' : 'GRANT_REPOSITORY_PERMISSION',
    targetType: 'USER',
    targetLabel: `${user.username} → ${repository.name} [${permissionNames(permissions)}]`,
    repositoryId: repository.id
  });
}

export function createRepositoriesRouter(db, config) {
  const router = express.Router();
  const requireView = createRepositoryPermissionMiddleware(db, 'view', config);
  const requireUpload = createRepositoryPermissionMiddleware(db, 'upload', config);
  const requireDownload = createRepositoryPermissionMiddleware(db, 'download', config);
  const requireDelete = createRepositoryPermissionMiddleware(db, 'delete', config);
  const requireManager = createRepositoryManagerMiddleware(db, config);

  const storage = createQuotaAwareUploadStorage(db, config);

  const uploadFiles = (req, res, next) => {
    req.uploadStartedAt = Date.now();
    req.uploadReceivedBytes = 0;
    const quotaSettings = loadEffectiveQuotaSettings(db, config, req.repository);
    req.uploadQuotaSettings = quotaSettings;
    const uploadLimits = {
      files: quotaSettings.maxFilesPerUpload,
      fieldNameSize: 64,
      fieldSize: 256,
      fields: 2,
      parts: quotaSettings.maxFilesPerUpload + 2,
      headerPairs: 100,
      fieldNestingDepth: 0
    };
    if (Number(quotaSettings.maxFileSizeMb) > 0) {
      uploadLimits.fileSize = quotaSettings.maxFileSizeMb * 1024 * 1024;
    }

    const parseUpload = multer({ storage, limits: uploadLimits })
      .array('files', quotaSettings.maxFilesPerUpload);
    parseUpload(req, res, (error) => {
      if (error) {
        cleanupUploadedFiles(req.files, storage);
        if (isUploadConnectionAbort(req, error)) {
          logUploadConnectionAbort(req, error);
          return;
        }
      }
      return next(error);
    });
  };

  router.use(requireAuth);

  router.post('/', requireRegularUser, (req, res) => {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();

    if (name.length < 2 || name.length > 60) {
      setFlash(req, 'error', req.t('The repository name must be between 2 and 60 characters.'));
      return res.redirect('/');
    }
    if (description.length > 300) {
      setFlash(req, 'error', req.t('The description must be 300 characters or fewer.'));
      return res.redirect('/');
    }
    let repositoryId;
    try {
      repositoryId = createRepositoryRecord(db, config, {
        name,
        description,
        userId: req.currentUser.id
      });
    } catch (error) {
      if (!(error instanceof RepositoryCreationError)) throw error;
      const messages = {
        DUPLICATE_NAME: req.t('A repository with that name already exists.'),
        USER_LIMIT: req.t('The maximum number of repositories for this account has been reached.'),
        TOTAL_LIMIT: req.t('The server repository limit has been reached.')
      };
      setFlash(req, 'error', messages[error.code] || req.t('An error occurred while processing the request.'));
      return res.redirect('/');
    }

    logActivity(db, {
      actorId: req.currentUser.id,
      action: 'CREATE_REPOSITORY',
      targetType: 'REPOSITORY',
      targetLabel: name,
      repositoryId
    });
    setFlash(req, 'success', req.t('Created your {{name}} repository.', { name }));
    return res.redirect(`/repositories/${repositoryId}`);
  });

  router.get('/:repositoryId/permissions', requireManager, (req, res) => {
    const { grants, availableUsers } = getPermissionPageData(db, req.repository);
    return res.render('repository-permissions', {
      title: req.t('REPOSITORY PERMISSIONS'),
      repository: req.repository,
      grants,
      availableUsers,
      isAdmin: canUseAdministratorAccess(config, req.currentUser)
    });
  });

  router.get('/:repositoryId/settings', requireManager, (req, res) => {
    const quotaSettings = loadRepositoryQuotaSettings(db, config, req.repository);
    const usage = db.prepare(`
      SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes
      FROM files
      WHERE repository_id = ?
    `).get(req.repository.id);
    return res.render('repository-settings', {
      title: req.t('Repository settings'),
      repository: req.repository,
      quotaSettings,
      usage
    });
  });

  router.post('/:repositoryId/settings', requireManager, (req, res, next) => {
    const policy = String(req.body.fileAccessTimePolicy || '');
    if (!['enabled', 'disabled'].includes(policy)) {
      setFlash(req, 'error', req.t('Select a valid file access time option.'));
      return res.redirect(`/repositories/${req.repository.id}/settings`);
    }

    const enabled = policy === 'enabled';
    const previous = {
      updateFileAccessTime: Number(req.repository.update_file_access_time),
      maxFileSizeMb: req.repository.max_file_size_mb,
      maxRepositoryStorageMb: req.repository.max_storage_mb
    };

    try {
      const savedQuotas = updateRepositoryQuotaSettings(db, req.repository.id, {
        maxFileSizeMb: req.body.maxFileSizeMb,
        maxRepositoryStorageMb: req.body.maxRepositoryStorageMb
      });
      db.prepare(`
        UPDATE repositories SET update_file_access_time = ? WHERE id = ?
      `).run(Number(enabled), req.repository.id);

      if (!enabled) {
        restoreRepositoryInitialAccessTimes(db, config, req.repository.id);
      }

      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'UPDATE_REPOSITORY_SETTINGS',
        targetType: 'REPOSITORY',
        targetLabel: `${req.repository.name} [file=${savedQuotas.maxFileSizeMb ?? 'default'} MB, storage=${savedQuotas.maxRepositoryStorageMb ?? 'default'} MB, access=${policy}]`,
        repositoryId: req.repository.id
      });
      setFlash(req, 'success', req.t('Repository settings were saved and are now active.'));
      return res.redirect(`/repositories/${req.repository.id}/settings`);
    } catch (error) {
      db.prepare(`
        UPDATE repositories
        SET update_file_access_time = ?, max_file_size_mb = ?, max_storage_mb = ?
        WHERE id = ?
      `).run(
        previous.updateFileAccessTime,
        previous.maxFileSizeMb,
        previous.maxRepositoryStorageMb,
        req.repository.id
      );
      if (error instanceof QuotaSettingsError) {
        setFlash(req, 'error', req.t(error.message));
        return res.redirect(`/repositories/${req.repository.id}/settings`);
      }
      return next(error);
    }
  });

  router.post('/:repositoryId/permissions', requireManager, (req, res) => {
    const userId = Number.parseInt(req.body.userId, 10);
    const user = validatePermissionTarget(db, req.repository, userId);
    const permissions = permissionPayload(req.body);

    if (!user) {
      setFlash(req, 'error', req.t('The selected user account could not be granted access.'));
    } else if (!hasAnyPermission(permissions)) {
      setFlash(req, 'error', req.t('Select at least one permission.'));
    } else {
      savePermissionGrant(db, req.repository, user, permissions, req.currentUser.id);
      setFlash(req, 'success', req.t('Saved repository permissions for {{name}}.', { name: user.display_name }));
    }
    return res.redirect(`/repositories/${req.repository.id}/permissions`);
  });

  router.post('/:repositoryId/permissions/:userId', requireManager, (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    const user = validatePermissionTarget(db, req.repository, userId);
    const permissions = permissionPayload(req.body);

    if (!user) {
      setFlash(req, 'error', req.t('The selected user account could not be found.'));
    } else if (!hasAnyPermission(permissions)) {
      setFlash(req, 'error', req.t('Select at least one permission or revoke access.'));
    } else {
      savePermissionGrant(db, req.repository, user, permissions, req.currentUser.id);
      setFlash(req, 'success', req.t('Updated repository permissions for {{name}}.', { name: user.display_name }));
    }
    return res.redirect(`/repositories/${req.repository.id}/permissions`);
  });

  router.post('/:repositoryId/permissions/:userId/delete', requireManager, (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const result = db.prepare(`
      DELETE FROM repository_permissions WHERE repository_id = ? AND user_id = ?
    `).run(req.repository.id, userId);

    if (result.changes > 0 && user) {
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'REVOKE_REPOSITORY_PERMISSION',
        targetType: 'USER',
        targetLabel: `${user.username} ← ${req.repository.name}`,
        repositoryId: req.repository.id
      });
      setFlash(req, 'success', req.t("Revoked {{name}}'s repository permissions.", { name: user.display_name }));
    } else {
      setFlash(req, 'info', req.t('No permission grant was found for that account.'));
    }
    return res.redirect(`/repositories/${req.repository.id}/permissions`);
  });

  router.post('/:repositoryId/folders', requireUpload, (req, res, next) => {
    const parentId = String(req.body.parentId || '').trim();
    try {
      const folder = createRepositoryFolder(db, config, req.repository, {
        parentId,
        name: req.body.name,
        userId: req.currentUser.id
      });
      setFlash(req, 'success', req.t('Created the {{name}} folder.', { name: folder.name }));
      return res.redirect(safeRepositoryFolderUrl(req.repository.id, parentId));
    } catch (error) {
      if (!(error instanceof RepositoryFolderError)) return next(error);
      setFlash(req, 'error', folderErrorMessage(req, error));
      return res.redirect(safeRepositoryFolderUrl(req.repository.id, parentId));
    }
  });

  router.post('/:repositoryId/folders/:folderId/delete', requireDelete, (req, res, next) => {
    let folder;
    try {
      folder = getRepositoryFolder(db, req.repository.id, req.params.folderId);
    } catch (error) {
      if (!(error instanceof RepositoryFolderError)) return next(error);
    }

    if (!folder) {
      setFlash(req, 'error', req.t('The folder to delete could not be found.'));
      return res.redirect(`/repositories/${req.repository.id}`);
    }

    try {
      const parentId = folder.parent_id;
      deleteRepositoryFolder(db, config, req.repository, folder, req.currentUser.id);
      setFlash(req, 'success', req.t('Deleted the {{name}} folder and its contents.', { name: folder.name }));
      return res.redirect(safeRepositoryFolderUrl(req.repository.id, parentId));
    } catch (error) {
      if (error instanceof RepositoryFolderError) {
        setFlash(req, 'error', folderErrorMessage(req, error));
        return res.redirect(safeRepositoryFolderUrl(req.repository.id, folder.parent_id));
      }
      return next(error);
    }
  });

  router.get('/:repositoryId', requireView, (req, res, next) => {
    const requestedFolderId = String(req.query.folder || '').trim();
    let currentFolder = null;
    try {
      currentFolder = requestedFolderId
        ? getRepositoryFolder(db, req.repository.id, requestedFolderId)
        : null;
    } catch (error) {
      if (!(error instanceof RepositoryFolderError)) return next(error);
    }
    if (requestedFolderId && !currentFolder) return renderFolderNotFound(req, res);

    const search = String(req.query.q || '').trim();
    const sort = String(req.query.sort || 'newest');
    const sortOptions = {
      newest: 'f.created_at DESC',
      oldest: 'f.created_at ASC',
      'name-asc': 'f.original_name COLLATE NOCASE ASC',
      'name-desc': 'f.original_name COLLATE NOCASE DESC',
      'size-desc': 'f.size DESC, f.created_at DESC',
      'size-asc': 'f.size ASC, f.created_at DESC'
    };
    const selectedSort = Object.hasOwn(sortOptions, sort) ? sort : 'newest';
    const params = [req.repository.id];
    let folderSql = 'f.folder_id IS NULL';
    if (currentFolder) {
      folderSql = 'f.folder_id = ?';
      params.push(currentFolder.id);
    }
    const searchSql = search ? 'AND f.original_name LIKE ?' : '';
    if (search) params.push(`%${search}%`);

    const files = db.prepare(`
      SELECT f.*, u.display_name AS uploader_name
      FROM files f
      LEFT JOIN users u ON u.id = f.uploaded_by
      WHERE f.repository_id = ? AND ${folderSql} ${searchSql}
      ORDER BY ${sortOptions[selectedSort]}
    `).all(...params);

    const folders = listRepositoryFolders(db, req.repository.id, currentFolder?.id, {
      search,
      sort: selectedSort
    });
    const breadcrumbs = getRepositoryFolderBreadcrumbs(
      db,
      req.repository.id,
      currentFolder?.id
    );

    const grants = req.repositoryPermissions.canManage
      ? db.prepare(`
          SELECT
            u.id,
            u.username,
            u.display_name,
            rp.can_view,
            rp.can_upload,
            rp.can_download,
            rp.can_delete
          FROM repository_permissions rp
          INNER JOIN users u ON u.id = rp.user_id
          WHERE rp.repository_id = ?
          ORDER BY u.display_name COLLATE NOCASE
        `).all(req.repository.id)
      : [];

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM files WHERE repository_id = ?) AS file_count,
        (SELECT COALESCE(SUM(size), 0) FROM files WHERE repository_id = ?) AS total_size,
        (SELECT COUNT(*) FROM folders WHERE repository_id = ?) AS folder_count,
        (SELECT COUNT(*) FROM repository_permissions WHERE repository_id = ?) AS shared_user_count
    `).get(req.repository.id, req.repository.id, req.repository.id, req.repository.id);

    const quotaSettings = loadEffectiveQuotaSettings(db, config, req.repository);
    return res.render('repository', {
      title: currentFolder ? `${currentFolder.name} · ${req.repository.name}` : req.repository.name,
      repository: req.repository,
      repositoryPermissions: req.repositoryPermissions,
      currentFolder,
      breadcrumbs,
      folders,
      files,
      grants,
      stats,
      search,
      sort: selectedSort,
      maxFileSizeMb: quotaSettings.maxFileSizeMb,
      maxFilesPerUpload: quotaSettings.maxFilesPerUpload,
      maxRepositoryStorageMb: quotaSettings.maxRepositoryStorageMb
    });
  });

  router.post(
    '/:repositoryId/upload',
    requireUpload,
    uploadFiles,
    (req, res, next) => {
      try {
        if (!isValidCsrf(req)) {
          cleanupUploadedFiles(req.files, storage);
          const message = req.t('The security token is invalid or has expired. Refresh the page and try again.');
          if (requestWantsJson(req)) return res.status(403).json({ error: message });
          return res.status(403).render('error', {
            title: req.t('Request could not be verified'),
            statusCode: 403,
            message
          });
        }

        const requestedFolderId = String(req.body.folderId || '').trim();
        let uploadFolder = null;
        try {
          uploadFolder = requestedFolderId
            ? getRepositoryFolder(db, req.repository.id, requestedFolderId)
            : null;
        } catch (error) {
          if (!(error instanceof RepositoryFolderError)) throw error;
        }
        if (requestedFolderId && !uploadFolder) {
          cleanupUploadedFiles(req.files, storage);
          const message = req.t('The selected folder does not exist.');
          if (requestWantsJson(req)) return res.status(400).json({ error: message });
          setFlash(req, 'error', message);
          return res.redirect(`/repositories/${req.repository.id}`);
        }

        if (!req.files?.length) {
          const message = req.t('Select at least one file to upload.');
          if (requestWantsJson(req)) return res.status(400).json({ error: message });
          setFlash(req, 'error', message);
          return res.redirect(safeRepositoryFolderUrl(req.repository.id, uploadFolder?.id));
        }

        const insertFile = db.prepare(`
          INSERT INTO files (
            id, repository_id, folder_id, original_name, stored_name, mime_type, size, uploaded_by,
            initial_access_time_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        try {
          db.exec('BEGIN IMMEDIATE');
          enforceUploadQuotas(db, req.uploadQuotaSettings, req.repository.id, req.files);
          for (const file of req.files) {
            fs.chmodSync(file.path, 0o600);
            insertFile.run(
              crypto.randomUUID(),
              req.repository.id,
              uploadFolder?.id || null,
              safeOriginalName(file.originalname),
              file.filename,
              file.mimetype || 'application/octet-stream',
              file.size,
              req.currentUser.id,
              readInitialAccessTimeMs(file.path)
            );
          }
          db.exec('COMMIT');
          storage.commitReservations(req.files);
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          cleanupUploadedFiles(req.files, storage);
          throw error;
        }

        logActivity(db, {
          actorId: req.currentUser.id,
          action: 'UPLOAD_FILE',
          targetType: 'FILE',
          targetLabel: req.files.length === 1
            ? safeOriginalName(req.files[0].originalname)
            : `${req.files.length} files`,
          repositoryId: req.repository.id
        });
        const message = req.t('{{count}} file(s) uploaded successfully.', { count: req.files.length });
        const redirectUrl = safeRepositoryFolderUrl(req.repository.id, uploadFolder?.id);
        setFlash(req, 'success', message);
        if (requestWantsJson(req)) return res.json({ ok: true, message, redirectUrl });
        return res.redirect(redirectUrl);
      } catch (error) {
        if (error instanceof UploadQuotaError) {
          const message = uploadQuotaErrorMessage(req, error, req.uploadQuotaSettings);
          if (requestWantsJson(req)) return res.status(413).json({ error: message });
          return res.status(413).render('error', {
            title: req.t('Upload failed'),
            statusCode: 413,
            message
          });
        }
        return next(error);
      }
    }
  );

  router.get('/:repositoryId/files/:fileId/preview', requireDownload, async (req, res, next) => {
    const file = db.prepare(`
      SELECT * FROM files WHERE id = ? AND repository_id = ?
    `).get(req.params.fileId, req.repository.id);

    if (!file) {
      return res.status(404).json({ error: req.t('The requested file does not exist.') });
    }

    const previewKind = filePreviewKind(file.mime_type, file.original_name);
    if (!['pdf', 'xlsx', 'zip', '7z'].includes(previewKind)) {
      return res.status(415).json({ error: req.t('Preview is not available for this file type.') });
    }

    let opened;
    try {
      opened = openStoredFile(config, req.repository.id, file.stored_name);
      const tracker = createFileAccessTracker(db, req.repository, file, opened.fd);
      res.set('Cache-Control', 'private, no-store');

      if (previewKind === 'pdf') {
        res.type('application/pdf');
        res.set('Content-Length', String(opened.stats.size));
        res.set('Content-Disposition', contentDisposition('inline', file.original_name));
        res.set('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        res.set('Referrer-Policy', 'no-referrer');
        res.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
        res.set('Cross-Origin-Resource-Policy', 'same-origin');
        streamOpenedFile(opened, tracker, res, next);
        opened = null;
        return;
      }

      const sizeLimit = previewFileSizeLimit(previewKind);
      if (opened.stats.size > sizeLimit) {
        const code = previewKind === 'xlsx' ? 'XLSX_TOO_LARGE' : 'ZIP_TOO_LARGE';
        throw new FilePreviewError(code, 'The file exceeds the compressed preview size limit.');
      }
      const preview = await withTrackedFileAccess(tracker, () => {
        if (previewKind === 'xlsx') {
          return createXlsxPreview(() => readOpenedFile(opened), opened.stats, req.query.sheet);
        }
        if (previewKind === 'zip') {
          return createZipPreview(() => readOpenedFile(opened), opened.stats);
        }
        return createSevenZipPreview(opened.filePath, opened.stats, {
          enabled: config.sevenZipPreviewEnabled === true,
          timeoutMs: config.sevenZipPreviewTimeoutMs
        });
      });
      return res.json(preview);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return res.status(410).json({
          error: req.t('The file record exists, but its data could not be found on disk.')
        });
      }
      if (error instanceof FilePreviewError) {
        const status = ['XLSX_TOO_LARGE', 'ZIP_TOO_LARGE', 'SEVEN_ZIP_METADATA_LIMIT'].includes(error.code)
          ? 413
          : (['PREVIEW_BUSY', 'SEVEN_ZIP_DISABLED', 'SEVEN_ZIP_TIMEOUT'].includes(error.code) ? 503 : 422);
        if (['PREVIEW_BUSY', 'SEVEN_ZIP_TIMEOUT'].includes(error.code)) res.set('Retry-After', '2');
        return res.status(status).json({ error: previewErrorMessage(req, error), code: error.code });
      }
      return next(error);
    } finally {
      if (opened) fs.closeSync(opened.fd);
    }
  });

  router.get('/:repositoryId/files/:fileId/download', requireDownload, (req, res, next) => {
    const file = db.prepare(`
      SELECT * FROM files WHERE id = ? AND repository_id = ?
    `).get(req.params.fileId, req.repository.id);

    if (!file) {
      const message = req.t('The requested file does not exist.');
      if (requestWantsJson(req)) return res.status(404).json({ error: message });
      return res.status(404).render('error', {
        title: req.t('File not found'),
        statusCode: 404,
        message
      });
    }

    let opened;
    try {
      opened = openStoredFile(config, req.repository.id, file.stored_name);
      const tracker = createFileAccessTracker(db, req.repository, file, opened.fd);
      res.type(file.mime_type || 'application/octet-stream');
      res.set('Content-Length', String(opened.stats.size));
      res.set('Content-Disposition', contentDisposition('attachment', file.original_name));
      streamOpenedFile(opened, tracker, res, next);
      opened = null;
      return;
    } catch (error) {
      if (opened) fs.closeSync(opened.fd);
      if (error?.code === 'ENOENT') {
        const message = req.t('The file record exists, but its data could not be found on disk.');
        if (requestWantsJson(req)) return res.status(410).json({ error: message });
        return res.status(410).render('error', {
          title: req.t('File data missing'),
          statusCode: 410,
          message
        });
      }
      return next(error);
    }
  });

  router.post('/:repositoryId/files/:fileId/delete', requireDelete, (req, res, next) => {
    try {
      const file = db.prepare(`
        SELECT * FROM files WHERE id = ? AND repository_id = ?
      `).get(req.params.fileId, req.repository.id);

      if (!file) {
        setFlash(req, 'error', req.t('The file to delete could not be found.'));
        return res.redirect(`/repositories/${req.repository.id}`);
      }

      const absolutePath = resolveStoredFilePath(config, req.repository.id, file.stored_name);
      fs.rmSync(absolutePath, { force: true });
      db.prepare('DELETE FROM files WHERE id = ?').run(file.id);

      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'DELETE_FILE',
        targetType: 'FILE',
        targetLabel: file.original_name,
        repositoryId: req.repository.id
      });
      setFlash(req, 'success', req.t('{{name}} was deleted.', { name: file.original_name }));
      return res.redirect(safeRepositoryFolderUrl(req.repository.id, file.folder_id));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:repositoryId/delete', requireManager, (req, res, next) => {
    try {
      deleteRepository(db, config, req.repository, req.currentUser.id);
      setFlash(req, 'success', req.t('Deleted the {{name}} repository and its files.', { name: req.repository.name }));
      return res.redirect(canUseAdministratorAccess(config, req.currentUser) ? '/admin/repositories' : '/');
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
