import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/database.js';
import {
  ensureSecureRepositoryDirectory,
  readInitialAccessTimeMs
} from '../src/file-access-time.js';
import { reconcileSmbRepository } from '../src/smb-sync-service.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-smb-rename-growth-poc-'));
const config = {
  nodeEnv: 'test',
  isProduction: false,
  sessionSecret: 'poc-session-secret-with-more-than-thirty-two-characters',
  adminUsername: 'admin',
  adminPassword: 'TestPassword123!',
  adminDisplayName: 'Admin',
  dbPath: path.join(tempRoot, 'recorddrive.db'),
  uploadRoot: path.join(tempRoot, 'uploads'),
  smbEnabled: true,
  smbShareRoot: path.join(tempRoot, 'smb-shares'),
  smbControlRoot: path.join(tempRoot, 'smb-control'),
  smbContainerShareRoot: '/data/smb-shares',
  smbServerName: 'fileserver',
  smbSyncIntervalMs: 1000,
  smbSyncMaxScannedEntries: 20_000,
  maxFoldersPerRepository: 1000,
  maxFileSizeMb: 0.0001,
  maxRepositoryStorageMb: 0,
  maxTotalStorageMb: 0,
  maxRepositoryFiles: 0,
  maxTotalFiles: 0,
  maxActivityLogEntries: 100_000,
  sessionAbsoluteHours: 168,
  adminAccessDisabled: false
};

const db = createDatabase(config);
try {
  const owner = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('poc.owner', 'PoC Owner', 'not-used', 'USER')
  `).run();
  const repositoryId = Number(db.prepare(`
    INSERT INTO repositories (
      name, description, created_by, smb_enabled, smb_credential_updated_at
    ) VALUES ('PoC', '', ?, 1, CURRENT_TIMESTAMP)
  `).run(owner.lastInsertRowid).lastInsertRowid);

  let repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
  const repositoryRoot = ensureSecureRepositoryDirectory(config, repositoryId);
  const storedName = crypto.randomUUID();
  const storedPath = path.join(repositoryRoot, storedName);
  const original = Buffer.alloc(64, 0x41);
  fs.writeFileSync(storedPath, original, { mode: 0o600 });
  db.prepare(`
    INSERT INTO files (
      id, repository_id, original_name, stored_name, mime_type, size, uploaded_by,
      initial_access_time_ms
    ) VALUES (
      'rename-growth-file', ?, 'quota-growth.bin', ?, 'application/octet-stream', ?, ?, ?
    )
  `).run(
    repositoryId,
    storedName,
    original.length,
    owner.lastInsertRowid,
    readInitialAccessTimeMs(storedPath)
  );

  reconcileSmbRepository(db, config, repository);
  const shareRoot = path.join(config.smbShareRoot, String(repositoryId));
  const projectedPath = path.join(shareRoot, 'quota-growth.bin');
  const renamedPath = path.join(shareRoot, 'renamed-growth.bin');

  fs.appendFileSync(projectedPath, Buffer.alloc(2048, 0x42));
  fs.renameSync(projectedPath, renamedPath);
  const projectedBytesBeforeReconcile = fs.statSync(renamedPath).size;

  repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
  reconcileSmbRepository(db, config, repository);

  const file = db.prepare(`
    SELECT original_name, size, stored_name
    FROM files WHERE id = 'rename-growth-file'
  `).get();
  const quotaRejectLogCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM activity_logs WHERE action = 'SMB_REJECT_FILE_QUOTA'
  `).get().count);
  const configuredMaxBytes = config.maxFileSizeMb * 1024 * 1024;
  const result = {
    configuredMaxBytes,
    originalBytes: original.length,
    projectedBytesBeforeReconcile,
    projectedBytesAfterReconcile: fs.statSync(renamedPath).size,
    canonicalBytesAfterReconcile: fs.statSync(path.join(repositoryRoot, file.stored_name)).size,
    databaseBytesAfterReconcile: Number(file.size),
    databaseNameAfterReconcile: file.original_name,
    quotaRejectLogCount,
    vulnerable: Number(file.size) > configuredMaxBytes && quotaRejectLogCount === 0
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
