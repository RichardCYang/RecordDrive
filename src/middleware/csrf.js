import crypto from 'node:crypto';

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function csrfTokenMiddleware(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = newToken();
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

export function isValidCsrf(req) {
  const sent = String(req.body?._csrf || req.get('x-csrf-token') || '');
  const expected = String(req.session?.csrfToken || '');
  const sentBuffer = Buffer.from(sent);
  const expectedBuffer = Buffer.from(expected);

  return Boolean(
    sent &&
    expected &&
    sentBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(sentBuffer, expectedBuffer)
  );
}

export function verifyCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // Multipart requests are verified in each upload route after Multer parses the body.
  if (req.is('multipart/form-data')) return next();

  if (!isValidCsrf(req)) {
    return res.status(403).render('error', {
      title: req.t('Request could not be verified'),
      statusCode: 403,
      message: req.t('The security token is invalid or has expired. Refresh the page and try again.')
    });
  }

  return next();
}
