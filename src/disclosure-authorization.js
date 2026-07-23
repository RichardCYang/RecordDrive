import { getRepositoryAccess } from './repository-access.js';
import { createStoredSessionActivityChecker } from './session-store.js';

const DEFAULT_SESSION_ABSOLUTE_HOURS = 168;

function requiredPositiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return normalized;
}

function requiredIdentifier(value, label) {
  const normalized = String(value || '');
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export function createFileDisclosureAuthorizer(db, config, context = {}) {
  const sessionId = requiredIdentifier(context.sessionId, 'A session identifier');
  const userId = requiredPositiveInteger(context.userId, 'The user identifier');
  const repositoryId = requiredPositiveInteger(context.repositoryId, 'The repository identifier');
  const fileId = requiredIdentifier(context.fileId, 'The file identifier');
  const configuredAbsoluteHours = Number(config?.sessionAbsoluteHours);
  const absoluteHours = Number.isFinite(configuredAbsoluteHours) && configuredAbsoluteHours > 0
    ? configuredAbsoluteHours
    : DEFAULT_SESSION_ABSOLUTE_HOURS;
  const absoluteTtlMs = absoluteHours * 60 * 60 * 1000;
  const sessionIsActive = createStoredSessionActivityChecker(
    db,
    sessionId,
    config?.sessionSecret,
    { userId, absoluteTtlMs }
  );
  const getUser = db.prepare(`
    SELECT id, role, must_change_password
    FROM users
    WHERE id = ?
  `);
  const getRepository = db.prepare(`
    SELECT id, created_by
    FROM repositories
    WHERE id = ?
  `);
  const getFile = db.prepare(`
    SELECT 1
    FROM files
    WHERE id = ? AND repository_id = ?
  `);

  return (now = Date.now()) => {
    if (!sessionIsActive(now)) return false;

    const user = getUser.get(userId);
    if (!user || Boolean(user.must_change_password)) return false;

    const repository = getRepository.get(repositoryId);
    if (!repository) return false;

    const access = getRepositoryAccess(db, repository, user, config);
    if (!access.download) return false;

    return Boolean(getFile.get(fileId, repositoryId));
  };
}
