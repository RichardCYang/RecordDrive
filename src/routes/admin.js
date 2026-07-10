import express from 'express';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '../middleware/auth.js';
import { logActivity } from '../database.js';
import {
  inspectTlsSettings,
  loadTlsSettings,
  saveTlsSettings,
  tlsSettingsFromForm,
  validateTlsSettings
} from '../tls-settings.js';
import { setFlash } from '../utils.js';

const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;

function listUsers(db) {
  return db.prepare(`
    SELECT
      u.*,
      CASE
        WHEN u.role = 'ADMIN' THEN (SELECT COUNT(*) FROM repositories)
        ELSE (
          SELECT COUNT(*)
          FROM repositories r
          WHERE r.created_by = u.id
            OR EXISTS (
              SELECT 1
              FROM repository_permissions rp
              WHERE rp.repository_id = r.id
                AND rp.user_id = u.id
                AND rp.can_view = 1
            )
        )
      END AS repository_count,
      (
        SELECT COUNT(*) FROM files f WHERE f.uploaded_by = u.id
      ) AS uploaded_file_count
    FROM users u
    ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END, u.created_at DESC
  `).all();
}

function renderTlsPage(req, res, { settings, runtimeControl, formError = null, statusCode = 200, storedPassphrasePresent = null }) {
  const certificateStatus = inspectTlsSettings(settings);
  const hasStoredPassphrase = storedPassphrasePresent ?? Boolean(settings.passphrase);
  const formSettings = { ...settings, passphrase: '' };
  const runtimeState = typeof runtimeControl.getNetworkState === 'function'
    ? runtimeControl.getNetworkState()
    : null;
  return res.status(statusCode).render('admin-tls', {
    title: req.t('HTTPS and TLS Settings'),
    activeAdminTab: 'tls',
    settings: formSettings,
    certificateStatus,
    runtimeState,
    hasStoredPassphrase,
    canReloadCertificate: typeof runtimeControl.reloadTlsCertificate === 'function',
    formError
  });
}

export function createAdminRouter(db, { config = {}, runtimeControl = {} } = {}) {
  const router = express.Router();
  router.use(requireAdmin);

  router.get('/', (req, res) => {
    const metrics = {
      users: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'USER'").get().count,
      repositories: db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count,
      files: db.prepare('SELECT COUNT(*) AS count FROM files').get().count,
      bytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files').get().total
    };
    const recentActivity = db.prepare(`
      SELECT al.*, u.display_name AS actor_name, u.username AS actor_username
      FROM activity_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      ORDER BY al.id DESC
      LIMIT 12
    `).all();

    return res.render('admin', {
      title: req.t('Admin dashboard'),
      activeAdminTab: 'overview',
      metrics,
      recentActivity
    });
  });

  router.get('/users', (req, res) => {
    return res.render('admin-users', {
      title: req.t('Account management'),
      activeAdminTab: 'users',
      users: listUsers(db),
      formError: null,
      form: { username: '', displayName: '' }
    });
  });

  router.post('/users', async (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim().toLowerCase();
      const displayName = String(req.body.displayName || '').trim();
      const password = String(req.body.password || '');

      let formError = null;
      if (!USERNAME_PATTERN.test(username)) {
        formError = req.t('Use 3-32 lowercase letters, numbers, periods, underscores, or hyphens for the username.');
      } else if (displayName.length < 2 || displayName.length > 50) {
        formError = req.t('The display name must be between 2 and 50 characters.');
      } else if (password.length < 8 || password.length > 128) {
        formError = req.t('The password must be between 8 and 128 characters.');
      } else if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        formError = req.t('That username is already in use.');
      }

      if (formError) {
        return res.status(400).render('admin-users', {
          title: req.t('Account management'),
          activeAdminTab: 'users',
          users: listUsers(db),
          formError,
          form: { username, displayName }
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      db.prepare(`
        INSERT INTO users (username, display_name, password_hash, role)
        VALUES (?, ?, ?, 'USER')
      `).run(username, displayName, passwordHash);

      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'CREATE_USER',
        targetType: 'USER',
        targetLabel: username
      });
      setFlash(req, 'success', req.t('Created the account for {{name}}.', { name: displayName }));
      return res.redirect('/admin/users');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/users/:userId/delete', (req, res, next) => {
    try {
      const userId = Number.parseInt(req.params.userId, 10);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!user) {
        setFlash(req, 'error', req.t('The account to delete could not be found.'));
      } else if (user.role === 'ADMIN') {
        setFlash(req, 'error', req.t('Administrator accounts cannot be deleted.'));
      } else {
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        logActivity(db, {
          actorId: req.currentUser.id,
          action: 'DELETE_USER',
          targetType: 'USER',
          targetLabel: user.username
        });
        setFlash(req, 'success', req.t('Deleted the account for {{name}}.', { name: user.display_name }));
      }
      return res.redirect('/admin/users');
    } catch (error) {
      return next(error);
    }
  });

  router.get('/repositories', (req, res) => {
    const repositories = db.prepare(`
      SELECT
        r.*,
        owner.username AS owner_username,
        owner.display_name AS owner_display_name,
        COALESCE(permission_stats.shared_user_count, 0) AS participant_count,
        COALESCE(file_stats.file_count, 0) AS file_count,
        COALESCE(file_stats.total_size, 0) AS total_size
      FROM repositories r
      LEFT JOIN users owner ON owner.id = r.created_by
      LEFT JOIN (
        SELECT repository_id, COUNT(*) AS shared_user_count
        FROM repository_permissions
        GROUP BY repository_id
      ) permission_stats ON permission_stats.repository_id = r.id
      LEFT JOIN (
        SELECT repository_id, COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_size
        FROM files
        GROUP BY repository_id
      ) file_stats ON file_stats.repository_id = r.id
      ORDER BY r.created_at DESC
    `).all();

    return res.render('admin-repositories', {
      title: req.t('Repository management'),
      activeAdminTab: 'repositories',
      repositories
    });
  });

  router.get('/tls', (req, res) => {
    const settings = loadTlsSettings(db, config);
    return renderTlsPage(req, res, { settings, runtimeControl });
  });

  router.post('/tls', (req, res, next) => {
    try {
      const currentSettings = loadTlsSettings(db, config);
      const settings = tlsSettingsFromForm(req.body, currentSettings, config);
      const validation = validateTlsSettings(settings, {
        checkCertificateFiles: settings.httpsEnabled
      });

      if (!validation.valid) {
        return renderTlsPage(req, res, {
          settings,
          runtimeControl,
          formError: validation.errors.join(' '),
          statusCode: 400,
          storedPassphrasePresent: Boolean(currentSettings.passphrase)
        });
      }

      saveTlsSettings(db, settings);
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'UPDATE_TLS_SETTINGS',
        targetType: 'SYSTEM',
        targetLabel: settings.httpsEnabled
          ? `HTTPS enabled on port ${settings.httpsPort}`
          : `HTTP enabled on port ${settings.httpPort}`
      });
      setFlash(
        req,
        'success',
        req.t('HTTPS and TLS settings were saved. Restart RecordDrive to apply listener, port, redirect, or certificate mode changes.')
      );
      return res.redirect('/admin/tls');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/tls/reload', async (req, res) => {
    if (typeof runtimeControl.reloadTlsCertificate !== 'function') {
      setFlash(req, 'error', req.t('Live certificate reload is unavailable until RecordDrive is started through the network server entry point.'));
      return res.redirect('/admin/tls');
    }

    try {
      await runtimeControl.reloadTlsCertificate();
      setFlash(req, 'success', req.t('The TLS certificate was reloaded without restarting RecordDrive.'));
    } catch (error) {
      setFlash(req, 'error', req.t('The TLS certificate could not be reloaded: {{message}}', { message: error.message }));
    }
    return res.redirect('/admin/tls');
  });

  return router;
}
