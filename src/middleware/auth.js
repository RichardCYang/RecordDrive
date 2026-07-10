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

export function requireRegularUser(req, res, next) {
  if (!req.currentUser) return res.redirect('/login');
  if (req.currentUser.role !== 'USER') {
    return res.status(403).render('error', {
      title: 'Access denied',
      statusCode: 403,
      message: 'Only regular users can create personal repositories.'
    });
  }
  return next();
}
