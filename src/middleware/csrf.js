import crypto from 'node:crypto';

const MULTIPART_UPLOAD_PATH = /^\/repositories\/[1-9]\d*\/upload\/?$/;

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function renderCsrfFailure(req, res) {
  return res.status(403).render('error', {
    title: req.t('Request could not be verified'),
    statusCode: 403,
    message: req.t('The security token is invalid or has expired. Refresh the page and try again.')
  });
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

  if (req.is('multipart/form-data')) {
    // The upload route validates the token after Multer parses its multipart fields.
    if (req.method === 'POST' && MULTIPART_UPLOAD_PATH.test(req.path)) return next();
    return renderCsrfFailure(req, res);
  }

  if (!isValidCsrf(req)) return renderCsrfFailure(req, res);
  return next();
}
