import express from 'express';
import { requireAuth } from '../middleware/auth.js';

export function createDashboardRouter(db) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const params = [];
    let accessJoin = '';
    let accessWhere = '';

    if (req.currentUser.role !== 'ADMIN') {
      accessJoin = 'INNER JOIN repository_members access_rm ON access_rm.repository_id = r.id';
      accessWhere = 'WHERE access_rm.user_id = ?';
      params.push(req.currentUser.id);
    }

    const repositories = db.prepare(`
      SELECT
        r.*,
        COALESCE(member_stats.participant_count, 0) AS participant_count,
        COALESCE(file_stats.file_count, 0) AS file_count,
        COALESCE(file_stats.total_size, 0) AS total_size,
        file_stats.last_file_at
      FROM repositories r
      ${accessJoin}
      LEFT JOIN (
        SELECT repository_id, COUNT(*) AS participant_count
        FROM repository_members
        GROUP BY repository_id
      ) member_stats ON member_stats.repository_id = r.id
      LEFT JOIN (
        SELECT repository_id, COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS total_size, MAX(created_at) AS last_file_at
        FROM files
        GROUP BY repository_id
      ) file_stats ON file_stats.repository_id = r.id
      ${accessWhere}
      ORDER BY COALESCE(file_stats.last_file_at, r.created_at) DESC
    `).all(...params);

    const totals = repositories.reduce((acc, repository) => {
      acc.files += Number(repository.file_count || 0);
      acc.bytes += Number(repository.total_size || 0);
      return acc;
    }, { files: 0, bytes: 0 });

    return res.render('dashboard', {
      title: 'My Drive',
      repositories,
      totals
    });
  });

  return router;
}
