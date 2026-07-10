import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { requireAuth, createRepositoryAccessMiddleware } from '../middleware/auth.js';
import { isValidCsrf } from '../middleware/csrf.js';
import { logActivity } from '../database.js';
import { safeOriginalName, setFlash } from '../utils.js';

function safeStoredPath(config, repositoryId, storedName) {
  const root = path.resolve(config.uploadRoot);
  const candidate = path.resolve(root, String(repositoryId), storedName);
  if (!candidate.startsWith(`${root}${path.sep}`)) {
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

export function createRepositoriesRouter(db, config) {
  const router = express.Router();
  const requireRepositoryAccess = createRepositoryAccessMiddleware(db);

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

  router.get('/:repositoryId', requireRepositoryAccess, (req, res) => {
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

    const members = db.prepare(`
      SELECT u.id, u.username, u.display_name
      FROM repository_members rm
      INNER JOIN users u ON u.id = rm.user_id
      WHERE rm.repository_id = ?
      ORDER BY u.display_name
    `).all(req.repository.id);

    const stats = db.prepare(`
      SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_size
      FROM files WHERE repository_id = ?
    `).get(req.repository.id);

    return res.render('repository', {
      title: req.repository.name,
      repository: req.repository,
      files,
      members,
      stats,
      search,
      sort: selectedSort,
      maxFileSizeMb: config.maxFileSizeMb,
      maxFilesPerUpload: config.maxFilesPerUpload
    });
  });

  router.post(
    '/:repositoryId/upload',
    requireRepositoryAccess,
    upload.array('files', config.maxFilesPerUpload),
    (req, res, next) => {
      try {
        if (!isValidCsrf(req)) {
          cleanupUploadedFiles(req.files);
          return res.status(403).render('error', {
            title: 'Request could not be verified',
            statusCode: 403,
            message: 'The security token is invalid or has expired. Refresh the page and try again.'
          });
        }

        if (!req.files?.length) {
          setFlash(req, 'error', 'Select at least one file to upload.');
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
        setFlash(req, 'success', `${req.files.length} file(s) uploaded successfully.`);
        return res.redirect(`/repositories/${req.repository.id}`);
      } catch (error) {
        return next(error);
      }
    }
  );

  router.get('/:repositoryId/files/:fileId/download', requireRepositoryAccess, (req, res, next) => {
    const file = db.prepare(`
      SELECT * FROM files WHERE id = ? AND repository_id = ?
    `).get(req.params.fileId, req.repository.id);

    if (!file) {
      return res.status(404).render('error', {
        title: 'File not found',
        statusCode: 404,
        message: 'The requested file does not exist.'
      });
    }

    try {
      const absolutePath = safeStoredPath(config, req.repository.id, file.stored_name);
      if (!fs.existsSync(absolutePath)) {
        return res.status(410).render('error', {
          title: 'File data missing',
          statusCode: 410,
          message: 'The file record exists, but its data could not be found on disk.'
        });
      }
      return res.download(absolutePath, file.original_name, (error) => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:repositoryId/files/:fileId/delete', requireRepositoryAccess, (req, res, next) => {
    try {
      const file = db.prepare(`
        SELECT * FROM files WHERE id = ? AND repository_id = ?
      `).get(req.params.fileId, req.repository.id);

      if (!file) {
        setFlash(req, 'error', 'The file to delete could not be found.');
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
      setFlash(req, 'success', `${file.original_name} was deleted.`);
      return res.redirect(`/repositories/${req.repository.id}`);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
