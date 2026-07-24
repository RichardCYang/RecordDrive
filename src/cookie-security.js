export const LEGACY_SESSION_COOKIE_NAME = 'recorddrive.sid';
export const HOST_SESSION_COOKIE_NAME = '__Host-recorddrive.sid';
export const LEGACY_ANONYMOUS_CSRF_COOKIE_NAME = 'recorddrive.csrf';
export const HOST_ANONYMOUS_CSRF_COOKIE_NAME = '__Host-recorddrive.csrf';

export function usesHostPrefixedCookies(config = {}) {
  return config.requireHttps === true;
}

export function sessionCookieName(config = {}) {
  return usesHostPrefixedCookies(config)
    ? HOST_SESSION_COOKIE_NAME
    : LEGACY_SESSION_COOKIE_NAME;
}

export function anonymousCsrfCookieName(config = {}) {
  return usesHostPrefixedCookies(config)
    ? HOST_ANONYMOUS_CSRF_COOKIE_NAME
    : LEGACY_ANONYMOUS_CSRF_COOKIE_NAME;
}

export function sessionCookieOptions(config = {}, maxAge) {
  const options = {
    httpOnly: true,
    sameSite: 'strict',
    secure: usesHostPrefixedCookies(config) ? true : 'auto',
    priority: 'high',
    path: '/'
  };
  if (maxAge !== undefined) options.maxAge = maxAge;
  return options;
}

function clearCookieOptions(config = {}) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: usesHostPrefixedCookies(config),
    priority: 'high',
    path: '/'
  };
}

export function clearSessionCookies(res, config = {}) {
  const options = clearCookieOptions(config);
  const activeName = sessionCookieName(config);
  res.clearCookie(activeName, options);

  // External deployments changed from the legacy name to a __Host- cookie.
  // Expire a legacy host-only cookie as a migration courtesy; a sibling-domain
  // cookie cannot be removed here, but it is no longer read by the application.
  if (activeName !== LEGACY_SESSION_COOKIE_NAME) {
    res.clearCookie(LEGACY_SESSION_COOKIE_NAME, options);
  }
}
