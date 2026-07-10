import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '../middleware/auth.js';
import { logActivity } from '../database.js';
import { setFlash } from '../utils.js';

const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;

export function createAdminRouter(db, config) {
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
      title: 'Admin Dashboard',
      activeAdminTab: 'overview',
      metrics,
      recentActivity
    });
  });

  router.get('/users', (req, res) => {
    const users = db.prepare(`
      SELECT
        u.*,
        COUNT(DISTINCT rm.repository_id) AS repository_count,
        COUNT(DISTINCT f.id) AS uploaded_file_count
      FROM users u
      LEFT JOIN repository_members rm ON rm.user_id = u.id
      LEFT JOIN files f ON f.uploaded_by = u.id
      GROUP BY u.id
      ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END, u.created_at DESC
    `).all();

    return res.render('admin-users', {
      title: 'Account Management',
      activeAdminTab: 'users',
      users,
      formError: null,
      form: { username: '', displayName: '' }
    });
  });

  router.post('/users', async (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim().toLowerCase();
      const displayName = String(req.body.displayName || '').trim();
      const password = String(req.body.password || '');
      const users = db.prepare(`
        SELECT u.*, COUNT(DISTINCT rm.repository_id) AS repository_count,
        COUNT(DISTINCT f.id) AS uploaded_file_count
        FROM users u
        LEFT JOIN repository_members rm ON rm.user_id = u.id
        LEFT JOIN files f ON f.uploaded_by = u.id
        GROUP BY u.id
        ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END, u.created_at DESC
      `).all();

      let formError = null;
      if (!USERNAME_PATTERN.test(username)) {
        formError = 'Use 3-32 lowercase letters, numbers, periods, underscores, or hyphens for the username.';
      } else if (displayName.length < 2 || displayName.length > 50) {
        formError = 'The display name must be between 2 and 50 characters.';
      } else if (password.length < 8 || password.length > 128) {
        formError = 'The password must be between 8 and 128 characters.';
      } else if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        formError = 'That username is already in use.';
      }

      if (formError) {
        return res.status(400).render('admin-users', {
          title: 'Account Management',
          activeAdminTab: 'users',
          users,
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
      setFlash(req, 'success', `Created the account for ${displayName}.`);
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
        setFlash(req, 'error', 'The account to delete could not be found.');
      } else if (user.role === 'ADMIN') {
        setFlash(req, 'error', 'Administrator accounts cannot be deleted.');
      } else {
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        logActivity(db, {
          actorId: req.currentUser.id,
          action: 'DELETE_USER',
          targetType: 'USER',
          targetLabel: user.username
        });
        setFlash(req, 'success', `Deleted the account for ${user.display_name}.`);
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
        COALESCE(member_stats.participant_count, 0) AS participant_count,
        COALESCE(file_stats.file_count, 0) AS file_count,
        COALESCE(file_stats.total_size, 0) AS total_size
      FROM repositories r
      LEFT JOIN (
        SELECT repository_id, COUNT(*) AS participant_count
        FROM repository_members
        GROUP BY repository_id
      ) member_stats ON member_stats.repository_id = r.id
      LEFT JOIN (
        SELECT repository_id, COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_size
        FROM files
        GROUP BY repository_id
      ) file_stats ON file_stats.repository_id = r.id
      ORDER BY r.created_at DESC
    `).all();

    return res.render('admin-repositories', {
      title: 'Repository Management',
      activeAdminTab: 'repositories',
      repositories,
      formError: null,
      form: { name: '', description: '' }
    });
  });

  router.post('/repositories', (req, res) => {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    const repositories = db.prepare(`
      SELECT
        r.*,
        COALESCE(member_stats.participant_count, 0) AS participant_count,
        COALESCE(file_stats.file_count, 0) AS file_count,
        COALESCE(file_stats.total_size, 0) AS total_size
      FROM repositories r
      LEFT JOIN (
        SELECT repository_id, COUNT(*) AS participant_count
        FROM repository_members
        GROUP BY repository_id
      ) member_stats ON member_stats.repository_id = r.id
      LEFT JOIN (
        SELECT repository_id, COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_size
        FROM files
        GROUP BY repository_id
      ) file_stats ON file_stats.repository_id = r.id
      ORDER BY r.created_at DESC
    `).all();

    let formError = null;
    if (name.length < 2 || name.length > 60) {
      formError = 'The repository name must be between 2 and 60 characters.';
    } else if (description.length > 300) {
      formError = 'The description must be 300 characters or fewer.';
    } else if (db.prepare('SELECT 1 FROM repositories WHERE name = ?').get(name)) {
      formError = 'A repository with that name already exists.';
    }

    if (formError) {
      return res.status(400).render('admin-repositories', {
        title: 'Repository Management',
        activeAdminTab: 'repositories',
        repositories,
        formError,
        form: { name, description }
      });
    }

    const result = db.prepare(`
      INSERT INTO repositories (name, description, created_by) VALUES (?, ?, ?)
    `).run(name, description, req.currentUser.id);

    logActivity(db, {
      actorId: req.currentUser.id,
      action: 'CREATE_REPOSITORY',
      targetType: 'REPOSITORY',
      targetLabel: name,
      repositoryId: Number(result.lastInsertRowid)
    });
    setFlash(req, 'success', `Created the ${name} repository.`);
    return res.redirect('/admin/repositories');
  });

  router.post('/repositories/:repositoryId/delete', (req, res, next) => {
    try {
      const repositoryId = Number.parseInt(req.params.repositoryId, 10);
      const repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
      if (!repository) {
        setFlash(req, 'error', 'The repository to delete could not be found.');
        return res.redirect('/admin/repositories');
      }

      const repositoryPath = path.join(config.uploadRoot, String(repositoryId));
      fs.rmSync(repositoryPath, { recursive: true, force: true });
      db.prepare('DELETE FROM repositories WHERE id = ?').run(repositoryId);
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'DELETE_REPOSITORY',
        targetType: 'REPOSITORY',
        targetLabel: repository.name
      });
      setFlash(req, 'success', `Deleted the ${repository.name} repository and its files.`);
      return res.redirect('/admin/repositories');
    } catch (error) {
      return next(error);
    }
  });

  router.get('/repositories/:repositoryId/participants', (req, res) => {
    const repositoryId = Number.parseInt(req.params.repositoryId, 10);
    const repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
    if (!repository) {
      return res.status(404).render('error', {
        title: 'Repository not found',
        statusCode: 404,
        message: 'The requested repository does not exist.'
      });
    }

    const members = db.prepare(`
      SELECT u.id, u.username, u.display_name, rm.created_at
      FROM repository_members rm
      INNER JOIN users u ON u.id = rm.user_id
      WHERE rm.repository_id = ?
      ORDER BY u.display_name
    `).all(repositoryId);

    const availableUsers = db.prepare(`
      SELECT id, username, display_name
      FROM users
      WHERE role = 'USER'
        AND id NOT IN (SELECT user_id FROM repository_members WHERE repository_id = ?)
      ORDER BY display_name
    `).all(repositoryId);

    return res.render('admin-participants', {
      title: 'Participant Management',
      activeAdminTab: 'repositories',
      repository,
      members,
      availableUsers
    });
  });

  router.post('/repositories/:repositoryId/participants', (req, res) => {
    const repositoryId = Number.parseInt(req.params.repositoryId, 10);
    const userId = Number.parseInt(req.body.userId, 10);
    const repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'USER'").get(userId);

    if (!repository || !user) {
      setFlash(req, 'error', 'The repository or account could not be found.');
      return res.redirect('/admin/repositories');
    }

    const result = db.prepare(`
      INSERT OR IGNORE INTO repository_members (repository_id, user_id, added_by)
      VALUES (?, ?, ?)
    `).run(repositoryId, userId, req.currentUser.id);

    if (result.changes > 0) {
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'ADD_MEMBER',
        targetType: 'USER',
        targetLabel: `${user.username} → ${repository.name}`,
        repositoryId
      });
      setFlash(req, 'success', `Added ${user.display_name} as a participant.`);
    } else {
      setFlash(req, 'info', 'This account is already a participant.');
    }
    return res.redirect(`/admin/repositories/${repositoryId}/participants`);
  });

  router.post('/repositories/:repositoryId/participants/:userId/delete', (req, res) => {
    const repositoryId = Number.parseInt(req.params.repositoryId, 10);
    const userId = Number.parseInt(req.params.userId, 10);
    const repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    db.prepare('DELETE FROM repository_members WHERE repository_id = ? AND user_id = ?')
      .run(repositoryId, userId);

    if (repository && user) {
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'REMOVE_MEMBER',
        targetType: 'USER',
        targetLabel: `${user.username} ← ${repository.name}`,
        repositoryId
      });
      setFlash(req, 'success', `Removed ${user.display_name}'s repository access.`);
    }
    return res.redirect(`/admin/repositories/${repositoryId}/participants`);
  });

  return router;
}
