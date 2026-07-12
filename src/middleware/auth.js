import {
  canUseAdministratorAccess,
  isBlockedAdministrator
} from '../admin-access.js';
import { safeInternalPath } from '../utils.js';

function administratorAccessDisabledMessage(req) {
  return req.t('Administrator access is disabled by server configuration.');
}

export function renderAdministratorAccessDisabled(req, res, statusCode = 403) {
  res.set('Cache-Control', 'no-store');
  const message = administratorAccessDisabledMessage(req);

  if (req.is('application/json') || req.path.includes('/passkeys/')) {
    return res.status(statusCode).json({ error: message });
  }

  return res.status(statusCode).render('error', {
    title: req.t('Access denied'),
    statusCode,
    message
  });
}

export function blockDisabledAdministratorSession(req, res, next) {
  if (!isBlockedAdministrator(req.app.locals.config, req.currentUser)) return next();

  req.currentUser = null;
  res.locals.currentUser = null;
  return req.session.destroy((error) => {
    res.clearCookie('recorddrive.sid');
    if (error) return next(error);
    return renderAdministratorAccessDisabled(req, res);
  });
}

export function requireAuth(req, res, next) {
  if (isBlockedAdministrator(req.app.locals.config, req.currentUser)) {
    return renderAdministratorAccessDisabled(req, res);
  }
  if (!req.currentUser) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const returnTo = safeInternalPath(req.originalUrl, '/');
      return res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    return res.redirect('/login');
  }
  return next();
}

export function requireAdmin(req, res, next) {
  if (req.app.locals.config?.adminAccessDisabled) {
    return renderAdministratorAccessDisabled(req, res, 404);
  }
  if (!req.currentUser) return res.redirect('/login');
  if (!canUseAdministratorAccess(req.app.locals.config, req.currentUser)) {
    return res.status(403).render('error', {
      title: req.t('Access denied'),
      statusCode: 403,
      message: req.t('Only administrators can access this page.')
    });
  }
  return next();
}

export function requireRegularUser(req, res, next) {
  if (isBlockedAdministrator(req.app.locals.config, req.currentUser)) {
    return renderAdministratorAccessDisabled(req, res);
  }
  if (!req.currentUser) return res.redirect('/login');
  if (req.currentUser.role !== 'USER') {
    return res.status(403).render('error', {
      title: req.t('Access denied'),
      statusCode: 403,
      message: req.t('Only regular users can create personal repositories.')
    });
  }
  return next();
}
