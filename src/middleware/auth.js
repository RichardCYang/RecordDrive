export function requireAuth(req, res, next) {
  if (!req.currentUser) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.currentUser) return res.redirect('/login');
  if (req.currentUser.role !== 'ADMIN') {
    return res.status(403).render('error', {
      title: 'Access denied',
      statusCode: 403,
      message: 'Only administrators can access this page.'
    });
  }
  return next();
}

export function createRepositoryAccessMiddleware(db) {
  return function requireRepositoryAccess(req, res, next) {
    const repositoryId = Number.parseInt(req.params.repositoryId || req.params.id, 10);
    if (!Number.isInteger(repositoryId)) {
      return res.status(404).render('error', {
        title: 'Repository not found',
        statusCode: 404,
        message: 'The requested repository does not exist.'
      });
    }

    const repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
    if (!repository) {
      return res.status(404).render('error', {
        title: 'Repository not found',
        statusCode: 404,
        message: 'The requested repository does not exist.'
      });
    }

    const isAdmin = req.currentUser?.role === 'ADMIN';
    const membership = isAdmin ? true : db.prepare(`
      SELECT 1 FROM repository_members WHERE repository_id = ? AND user_id = ?
    `).get(repositoryId, req.currentUser?.id);

    if (!membership) {
      return res.status(403).render('error', {
        title: 'Repository access denied',
        statusCode: 403,
        message: 'Your account is not registered as a participant in this repository.'
      });
    }

    req.repository = repository;
    return next();
  };
}
