import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(process.env.PROJECT_ROOT || '.');
const attempts = Number.parseInt(process.env.ATTEMPTS || '25000', 10);
const configuredLimit = process.env.MAX_ACTIVITY_LOG_ENTRIES || '';
const { loadConfig } = await import(pathToFileURL(path.join(projectRoot, 'src/config.js')));
const { createDatabase, logActivity } = await import(pathToFileURL(path.join(projectRoot, 'src/database.js')));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-activity-log-poc-'));
const overrides = {
  NODE_ENV: 'test',
  ADMIN_ACCESS_DISABLED: 'true',
  DB_PATH: path.join(root, 'data', 'recorddrive.db'),
  UPLOAD_ROOT: path.join(root, 'uploads')
};
if (configuredLimit) overrides.MAX_ACTIVITY_LOG_ENTRIES = configuredLimit;

const config = loadConfig(overrides);
const db = createDatabase(config);
const beforePages = db.prepare('PRAGMA page_count').get().page_count;

for (let index = 0; index < attempts; index += 1) {
  logActivity(db, {
    action: 'POC_ACTIVITY',
    targetType: 'security-poc',
    targetLabel: `entry-${index}`
  });
}

const retained = db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get().count;
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const afterPages = db.prepare('PRAGMA page_count').get().page_count;
const pageSize = db.prepare('PRAGMA page_size').get().page_size;
console.log(JSON.stringify({
  projectRoot,
  attempts,
  configuredLimit: configuredLimit || null,
  retained,
  databaseGrowthBytes: (afterPages - beforePages) * pageSize
}));

db.close();
fs.rmSync(root, { recursive: true, force: true });
