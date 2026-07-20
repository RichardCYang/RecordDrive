import {
  canUseAdministratorAccess,
  isBlockedAdministrator
} from './admin-access.js';
import { requestWantsJson } from './utils.js';

const PERMISSION_COLUMNS = {
  view: 'can_view',
  upload: 'can_upload',
  download: 'can_download',
  delete: 'can_delete'
};

export const REPOSITORY_PERMISSION_NAMES = Object.freeze(Object.keys(PERMISSION_COLUMNS));

function fullPermissions(source) {
  return {
    view: true,
    upload: true,
    download: true,
    delete: true,
    source,
    canManage: true
  };
}

function emptyPermissions() {
  return {
    view: false,
    upload: false,
    download: false,
    delete: false,
    source: 'NONE',
    canManage: false
  };
}

export function getRepositoryAccess(db, repository, user, config = {}) {
  if (!repository || !user) return emptyPermissions();
  if (isBlockedAdministrator(config, user)) return emptyPermissions();
  if (canUseAdministratorAccess(config, user)) return fullPermissions('ADMIN');
  if (Number(repository.created_by) === Number(user.id)) return fullPermissions('OWNER');

  const grant = db.prepare(`
    SELECT can_view, can_upload, can_download, can_delete
    FROM repository_permissions
    WHERE repository_id = ? AND user_id = ?
  `).get(repository.id, user.id);

  if (!grant) return emptyPermissions();
  return {
    view: Boolean(grant.can_view),
    upload: Boolean(grant.can_upload),
    download: Boolean(grant.can_download),
    delete: Boolean(grant.can_delete),
    source: 'GRANT',
    canManage: false
  };
}

function renderRepositoryNotFound(req, res) {
  const message = req.t('The requested repository does not exist or is not available to your account.');
  if (requestWantsJson(req)) {
    return res.status(404).json({ error: message });
  }
  return res.status(404).render('error', {
    title: req.t('Repository not found'),
    statusCode: 404,
    message
  });
}

export function createRepositoryPermissionMiddleware(db, permissionName, config = {}) {
  if (!REPOSITORY_PERMISSION_NAMES.includes(permissionName)) {
    throw new Error(`Unsupported repository permission: ${permissionName}`);
  }

  return function requireRepositoryPermission(req, res, next) {
    const repositoryId = Number.parseInt(req.params.repositoryId || req.params.id, 10);
    if (!Number.isInteger(repositoryId)) return renderRepositoryNotFound(req, res);

    const repository = db.prepare(`
      SELECT r.*, owner.username AS owner_username, owner.display_name AS owner_display_name
      FROM repositories r
      LEFT JOIN users owner ON owner.id = r.created_by
      WHERE r.id = ?
    `).get(repositoryId);
    if (!repository) return renderRepositoryNotFound(req, res);

    const access = getRepositoryAccess(db, repository, req.currentUser, config);
    if (!access[permissionName]) return renderRepositoryNotFound(req, res);

    req.repository = repository;
    req.repositoryPermissions = access;
    return next();
  };
}

export function createRepositoryManagerMiddleware(db, config = {}) {
  return function requireRepositoryManager(req, res, next) {
    const repositoryId = Number.parseInt(req.params.repositoryId || req.params.id, 10);
    if (!Number.isInteger(repositoryId)) return renderRepositoryNotFound(req, res);

    const repository = db.prepare(`
      SELECT r.*, owner.username AS owner_username, owner.display_name AS owner_display_name
      FROM repositories r
      LEFT JOIN users owner ON owner.id = r.created_by
      WHERE r.id = ?
    `).get(repositoryId);
    if (!repository) return renderRepositoryNotFound(req, res);

    const access = getRepositoryAccess(db, repository, req.currentUser, config);
    if (!access.canManage) return renderRepositoryNotFound(req, res);

    req.repository = repository;
    req.repositoryPermissions = access;
    return next();
  };
}

export function permissionPayload(body = {}) {
  return {
    view: body.canView === '1' || body.canView === 'on',
    upload: body.canUpload === '1' || body.canUpload === 'on',
    download: body.canDownload === '1' || body.canDownload === 'on',
    delete: body.canDelete === '1' || body.canDelete === 'on'
  };
}

export function hasAnyPermission(permissions) {
  return REPOSITORY_PERMISSION_NAMES.some((name) => Boolean(permissions[name]));
}
