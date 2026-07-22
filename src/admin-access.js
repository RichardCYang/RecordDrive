import { createSessionPayloadProtector, revokeStoredSession } from './session-store.js';

export const ADMIN_ROLE = 'ADMIN';

export function isAdministrator(user) {
  return user?.role === ADMIN_ROLE;
}

export function isAdministratorAccessDisabled(config) {
  return config?.adminAccessDisabled === true;
}

export function canUseAdministratorAccess(config, user) {
  return isAdministrator(user) && !isAdministratorAccessDisabled(config);
}

export function isBlockedAdministrator(config, user) {
  return isAdministrator(user) && isAdministratorAccessDisabled(config);
}

export function purgeAdministratorSessions(db, sessionSecret) {
  const administratorIds = new Set(
    db.prepare('SELECT id FROM users WHERE role = ?').all(ADMIN_ROLE).map(({ id }) => Number(id))
  );
  if (administratorIds.size === 0) return 0;

  const payloadProtector = createSessionPayloadProtector(sessionSecret);
  let purgedCount = 0;

  for (const row of db.prepare('SELECT sid, sess, expires FROM sessions').all()) {
    let storedSession;
    try {
      storedSession = payloadProtector.decrypt(row.sess, row.sid).session;
    } catch {
      continue;
    }

    const referencedUserIds = [
      storedSession?.userId,
      storedSession?.pendingMfa?.userId,
      storedSession?.webAuthnAuthentication?.userId,
      storedSession?.authenticationFlow?.userId
    ].map(Number);

    if (referencedUserIds.some((userId) => administratorIds.has(userId))) {
      purgedCount += revokeStoredSession(db, row.sid, {
        expires: row.expires,
        storedSession
      });
    }
  }

  return purgedCount;
}
