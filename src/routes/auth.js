import express from 'express';
import bcrypt from 'bcryptjs';
import { logActivity } from '../database.js';
import { clearLoginAttempts, loginRateLimit } from '../middleware/login-rate-limit.js';

export function createAuthRouter(db) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.currentUser) return res.redirect('/');
    return res.render('login', {
      title: req.t('Sign in'),
      error: null,
      username: ''
    });
  });

  router.post('/login', loginRateLimit, async (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false;

      if (!user || !passwordMatches) {
        return res.status(401).render('login', {
          title: req.t('Sign in'),
          error: req.t('The username or password is incorrect.'),
          username
        });
      }

      clearLoginAttempts(req);
      const returnTo = req.session.returnTo && req.session.returnTo.startsWith('/')
        ? req.session.returnTo
        : '/';

      return req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.userId = user.id;
        logActivity(db, {
          actorId: user.id,
          action: 'LOGIN',
          targetType: 'USER',
          targetLabel: user.username
        });
        return res.redirect(returnTo);
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('recorddrive.sid');
      return res.redirect('/login');
    });
  });

  return router;
}
