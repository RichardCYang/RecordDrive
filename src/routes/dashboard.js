import express from 'express';
import { canUseAdministratorAccess } from '../admin-access.js';
import { requireAuth } from '../middleware/auth.js';

const REPOSITORY_LIST_SQL = `
  SELECT
    r.*,
    owner.username AS owner_username,
    owner.display_name AS owner_display_name,
    COALESCE(permission_stats.shared_user_count, 0) AS participant_count,
    COALESCE(file_stats.file_count, 0) AS file_count,
    COALESCE(file_stats.total_size, 0) AS total_size,
    file_stats.last_file_at,
    access.can_view AS access_can_view,
    access.can_upload AS access_can_upload,
    access.can_download AS access_can_download,
    access.can_delete AS access_can_delete
  FROM repositories r
  LEFT JOIN users owner ON owner.id = r.created_by
  LEFT JOIN repository_permissions access
    ON access.repository_id = r.id AND access.user_id = ?
  LEFT JOIN (
    SELECT repository_id, COUNT(*) AS shared_user_count
    FROM repository_permissions
    GROUP BY repository_id
  ) permission_stats ON permission_stats.repository_id = r.id
  LEFT JOIN (
    SELECT
      repository_id,
      COUNT(*) AS file_count,
      COALESCE(SUM(size), 0) AS total_size,
      MAX(created_at) AS last_file_at
    FROM files
    GROUP BY repository_id
  ) file_stats ON file_stats.repository_id = r.id
`;

export function createDashboardRouter(db, config = {}) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const isAdmin = canUseAdministratorAccess(config, req.currentUser);
    const rows = isAdmin
      ? db.prepare(`${REPOSITORY_LIST_SQL} ORDER BY COALESCE(file_stats.last_file_at, r.created_at) DESC`)
        .all(-1)
      : db.prepare(`
          ${REPOSITORY_LIST_SQL}
          WHERE r.created_by = ? OR COALESCE(access.can_view, 0) = 1
          ORDER BY COALESCE(file_stats.last_file_at, r.created_at) DESC
        `).all(req.currentUser.id, req.currentUser.id);

    const repositories = rows.map((repository) => {
      const isOwner = Number(repository.created_by) === Number(req.currentUser.id);
      return {
        ...repository,
        is_owner: isOwner,
        can_view: isAdmin || isOwner || Boolean(repository.access_can_view),
        can_upload: isAdmin || isOwner || Boolean(repository.access_can_upload),
        can_download: isAdmin || isOwner || Boolean(repository.access_can_download),
        can_delete: isAdmin || isOwner || Boolean(repository.access_can_delete)
      };
    });

    const totals = repositories.reduce((accumulator, repository) => {
      accumulator.files += Number(repository.file_count || 0);
      accumulator.bytes += Number(repository.total_size || 0);
      return accumulator;
    }, { files: 0, bytes: 0 });

    return res.render('dashboard', {
      title: req.t('My Drive'),
      isAdmin,
      repositories,
      totals
    });
  });

  return router;
}
