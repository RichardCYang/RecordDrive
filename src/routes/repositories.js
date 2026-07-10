import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import { safeOriginalName, setFlash } from '../utils.js';

function safeStoredPath(config, repositoryId, storedName) {
  const repositoryRoot = path.resolve(config.uploadRoot, String(repositoryId));
  const candidate = path.resolve(repositoryRoot, storedName);
  if (!candidate.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error('The requested file path is not allowed.');
  }
  return candidate;
}

function cleanupUploadedFiles(files = []) {
  for (const file of files) {
    try {
      if (file?.path) fs.rmSync(file.path, { force: true });
    } catch {
      // Ignore cleanup failures so the original error is preserved.
    }
  }
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
  const requireView = createRepositoryPermissionMiddleware(db, 'view');
  const requireUpload = createRepositoryPermissionMiddleware(db, 'upload');
  const requireDownload = createRepositoryPermissionMiddleware(db, 'download');
  const requireDelete = createRepositoryPermissionMiddleware(db, 'delete');
  const requireManager = createRepositoryManagerMiddleware(db);

  const storage = multer.diskStorage({
    destination(req, file, callback) {
      const directory = path.join(config.uploadRoot, String(req.repository.id));
      fs.mkdir(directory, { recursive: true }, (error) => callback(error, directory));
    },
    filename(req, file, callback) {
      callback(null, crypto.randomUUID());
    }
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: config.maxFileSizeMb * 1024 * 1024,
      files: config.maxFilesPerUpload,
      fields: 10,
      parts: config.maxFilesPerUpload + 10
    }
  });

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
    if (db.prepare('SELECT 1 FROM repositories WHERE name = ?').get(name)) {
      setFlash(req, 'error', req.t('A repository with that name already exists.'));
      return res.redirect('/');
    }

    const result = db.prepare(`
      INSERT INTO repositories (name, description, created_by) VALUES (?, ?, ?)
    `).run(name, description, req.currentUser.id);
    const repositoryId = Number(result.lastInsertRowid);

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
      availableUsers
    });
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

  router.get('/:repositoryId', requireView, (req, res) => {
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
    const searchSql = search ? 'AND f.original_name LIKE ?' : '';
    const params = [req.repository.id];
    if (search) params.push(`%${search}%`);

    const files = db.prepare(`
      SELECT f.*, u.display_name AS uploader_name, u.username AS uploader_username
      FROM files f
      LEFT JOIN users u ON u.id = f.uploaded_by
      WHERE f.repository_id = ? ${searchSql}
      ORDER BY ${sortOptions[selectedSort]}
    `).all(...params);

    const grants = db.prepare(`
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
    `).all(req.repository.id);

    const stats = db.prepare(`
      SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_size
      FROM files WHERE repository_id = ?
    `).get(req.repository.id);

    return res.render('repository', {
      title: req.repository.name,
      repository: req.repository,
      repositoryPermissions: req.repositoryPermissions,
      files,
      grants,
      stats,
      search,
      sort: selectedSort,
      maxFileSizeMb: config.maxFileSizeMb,
      maxFilesPerUpload: config.maxFilesPerUpload
    });
  });

  router.post(
    '/:repositoryId/upload',
    requireUpload,
    upload.array('files', config.maxFilesPerUpload),
    (req, res, next) => {
      try {
        if (!isValidCsrf(req)) {
          cleanupUploadedFiles(req.files);
          return res.status(403).render('error', {
            title: req.t('Request could not be verified'),
            statusCode: 403,
            message: req.t('The security token is invalid or has expired. Refresh the page and try again.')
          });
        }

        if (!req.files?.length) {
          setFlash(req, 'error', req.t('Select at least one file to upload.'));
          return res.redirect(`/repositories/${req.repository.id}`);
        }

        const insertFile = db.prepare(`
          INSERT INTO files (
            id, repository_id, original_name, stored_name, mime_type, size, uploaded_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        try {
          db.exec('BEGIN IMMEDIATE');
          for (const file of req.files) {
            insertFile.run(
              crypto.randomUUID(),
              req.repository.id,
              safeOriginalName(file.originalname),
              file.filename,
              file.mimetype || 'application/octet-stream',
              file.size,
              req.currentUser.id
            );
          }
          db.exec('COMMIT');
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          cleanupUploadedFiles(req.files);
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
        setFlash(req, 'success', req.t('{{count}} file(s) uploaded successfully.', { count: req.files.length }));
        return res.redirect(`/repositories/${req.repository.id}`);
      } catch (error) {
        return next(error);
      }
    }
  );

  router.get('/:repositoryId/files/:fileId/download', requireDownload, (req, res, next) => {
    const file = db.prepare(`
      SELECT * FROM files WHERE id = ? AND repository_id = ?
    `).get(req.params.fileId, req.repository.id);

    if (!file) {
      return res.status(404).render('error', {
        title: req.t('File not found'),
        statusCode: 404,
        message: req.t('The requested file does not exist.')
      });
    }

    try {
      const absolutePath = safeStoredPath(config, req.repository.id, file.stored_name);
      if (!fs.existsSync(absolutePath)) {
        return res.status(410).render('error', {
          title: req.t('File data missing'),
          statusCode: 410,
          message: req.t('The file record exists, but its data could not be found on disk.')
        });
      }
      return res.download(absolutePath, file.original_name, (error) => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
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

      const absolutePath = safeStoredPath(config, req.repository.id, file.stored_name);
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
      return res.redirect(`/repositories/${req.repository.id}`);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:repositoryId/delete', requireDelete, (req, res, next) => {
    try {
      deleteRepository(db, config, req.repository, req.currentUser.id);
      setFlash(req, 'success', req.t('Deleted the {{name}} repository and its files.', { name: req.repository.name }));
      return res.redirect(req.currentUser.role === 'ADMIN' ? '/admin/repositories' : '/');
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
