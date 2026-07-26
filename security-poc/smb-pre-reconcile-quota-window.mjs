import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/database.js';
import { ensureSecureRepositoryDirectory } from '../src/file-access-time.js';
import { reconcileSmbRepository } from '../src/smb-sync-service.js';
import { updateRepositorySmbSettings } from '../src/smb-settings.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-smb-window-poc-'));
const config = {
  nodeEnv: 'test',
  isProduction: false,
  sessionSecret: 'smb-window-poc-secret-with-more-than-thirty-two-characters',
  adminUsername: 'admin',
  adminPassword: 'TestPassword123!',
  adminDisplayName: 'Test Administrator',
  dbPath: path.join(tempRoot, 'recorddrive.db'),
  uploadRoot: path.join(tempRoot, 'uploads'),
  smbEnabled: true,
  smbAllowWrites: true,
  smbShareRoot: path.join(tempRoot, 'smb-shares'),
  smbControlRoot: path.join(tempRoot, 'smb-control'),
  smbContainerShareRoot: '/data/smb-shares',
  smbServerName: 'fileserver',
  smbSyncIntervalMs: 1000,
  smbSyncMaxScannedEntries: 20_000,
  maxFoldersPerRepository: 1000,
  maxFileSizeMb: 1,
  maxRepositoryStorageMb: 1,
  maxTotalStorageMb: 1,
  maxRepositoryFiles: 100,
  maxTotalFiles: 100
};

const db = createDatabase(config);
try {
  const ownerId = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('poc.owner', 'PoC Owner', 'not-used', 'USER')
  `).run().lastInsertRowid;
  const repositoryId = db.prepare(`
    INSERT INTO repositories (name, description, created_by, smb_enabled, smb_credential_updated_at)
    VALUES ('PoC Repository', '', ?, 1, CURRENT_TIMESTAMP)
  `).run(ownerId).lastInsertRowid;
  let repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
  const repositoryRoot = ensureSecureRepositoryDirectory(config, repositoryId);
  const storedName = crypto.randomUUID();
  const storedPath = path.join(repositoryRoot, storedName);
  fs.writeFileSync(storedPath, Buffer.alloc(1024), { mode: 0o600 });
  db.prepare(`
    INSERT INTO files (id, repository_id, original_name, stored_name, mime_type, size, uploaded_by)
    VALUES ('quota-window-file', ?, 'window.bin', ?, 'application/octet-stream', 1024, ?)
  `).run(repositoryId, storedName, ownerId);

  reconcileSmbRepository(db, config, repository);
  const projectedPath = path.join(config.smbShareRoot, String(repositoryId), 'window.bin');
  fs.writeFileSync(projectedPath, Buffer.alloc(8 * 1024 * 1024, 0x41));

  const physicalSizeBeforeReconcile = fs.statSync(storedPath).size;
  const committedSizeBeforeReconcile = db.prepare("SELECT size FROM files WHERE id = 'quota-window-file'").get().size;
  assert.equal(physicalSizeBeforeReconcile, 8 * 1024 * 1024);
  assert.equal(committedSizeBeforeReconcile, 1024);

  repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
  reconcileSmbRepository(db, config, repository);
  const physicalSizeAfterReconcile = fs.statSync(storedPath).size;
  assert.equal(physicalSizeAfterReconcile, 1024);

  let patchedDefaultGate = '';
  try {
    updateRepositorySmbSettings(db, { ...config, smbAllowWrites: false }, repository, {
      enabled: true,
      readOnly: false,
      password: ''
    }, ownerId);
  } catch (error) {
    patchedDefaultGate = String(error?.code || error?.message || error);
  }
  assert.equal(patchedDefaultGate, 'SMB_WRITES_DISABLED');

  console.log(JSON.stringify({
    status: 'PASS',
    committedQuotaBytes: 1024,
    physicalBytesBeforeReconcile: physicalSizeBeforeReconcile,
    physicalBytesAfterReconcile: physicalSizeAfterReconcile,
    patchedDefaultGate,
    finding: 'Writable SMB can consume filesystem capacity before periodic quota reconciliation.'
  }, null, 2));
} finally {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
