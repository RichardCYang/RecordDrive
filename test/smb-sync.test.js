import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/database.js';
import {
  ensureSecureRepositoryDirectory,
  readInitialAccessTimeMs,
  restoreRepositoryInitialAccessTimes
} from '../src/file-access-time.js';
import { reconcileSmbRepository } from '../src/smb-sync-service.js';

function testConfig(tempRoot) {
  return {
    nodeEnv: 'test',
    isProduction: false,
    sessionSecret: 'smb-sync-test-secret-with-more-than-thirty-two-characters',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads'),
    smbEnabled: true,
    smbShareRoot: path.join(tempRoot, 'smb-shares'),
    smbControlRoot: path.join(tempRoot, 'smb-control'),
    smbContainerShareRoot: '/data/smb-shares',
    smbServerName: 'fileserver',
    smbSyncIntervalMs: 1000,
    maxFoldersPerRepository: 1000,
    maxFileSizeMb: 0,
    maxRepositoryStorageMb: 0,
    maxTotalStorageMb: 0,
    maxRepositoryFiles: 0,
    maxTotalFiles: 0
  };
}

function createRepository(db) {
  const owner = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('sync.owner', 'Sync Owner', 'not-used', 'USER')
  `).run();
  const result = db.prepare(`
    INSERT INTO repositories (name, description, created_by, smb_enabled, smb_credential_updated_at)
    VALUES ('Sync Repository', 'SMB synchronization test', ?, 1, CURRENT_TIMESTAMP)
  `).run(owner.lastInsertRowid);
  return db.prepare('SELECT * FROM repositories WHERE id = ?').get(result.lastInsertRowid);
}

function sameInode(leftPath, rightPath) {
  const left = fs.statSync(leftPath, { bigint: true });
  const right = fs.statSync(rightPath, { bigint: true });
  return left.dev === right.dev && left.ino === right.ino;
}

test('reconciles web and SMB files through hard links without changing supplied times', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-smb-sync-'));
  const config = testConfig(tempRoot);
  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const repository = createRepository(db);
  const repositoryRoot = ensureSecureRepositoryDirectory(config, repository.id);
  const storedName = crypto.randomUUID();
  const storedPath = path.join(repositoryRoot, storedName);
  fs.writeFileSync(storedPath, 'web-created file', { mode: 0o600 });
  const webAtimeMs = Date.now() - 7_200_000;
  const webMtimeMs = Date.now() - 3_600_000;
  fs.utimesSync(storedPath, webAtimeMs / 1000, webMtimeMs / 1000);
  db.prepare(`
    INSERT INTO files (
      id, repository_id, original_name, stored_name, mime_type, size, uploaded_by,
      initial_access_time_ms
    ) VALUES ('web-file', ?, 'report.txt', ?, 'text/plain', ?, ?, ?)
  `).run(
    repository.id,
    storedName,
    fs.statSync(storedPath).size,
    repository.created_by,
    readInitialAccessTimeMs(storedPath)
  );

  reconcileSmbRepository(db, config, repository);
  const shareRoot = path.join(config.smbShareRoot, String(repository.id));
  const projectedWebFile = path.join(shareRoot, 'report.txt');
  assert.equal(sameInode(storedPath, projectedWebFile), true);
  assert.ok(Math.abs(fs.statSync(projectedWebFile).atimeMs - webAtimeMs) < 2);
  assert.ok(Math.abs(fs.statSync(projectedWebFile).mtimeMs - webMtimeMs) < 2);

  db.prepare("UPDATE files SET original_name = 'renamed-report.txt' WHERE id = 'web-file'").run();
  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));
  const renamedProjectedWebFile = path.join(shareRoot, 'renamed-report.txt');
  assert.equal(fs.existsSync(projectedWebFile), false);
  assert.equal(sameInode(storedPath, renamedProjectedWebFile), true);

  const incomingFolder = path.join(shareRoot, 'Incoming');
  fs.mkdirSync(incomingFolder);
  const incomingPath = path.join(incomingFolder, 'new.bin');
  fs.writeFileSync(incomingPath, Buffer.from('SMB payload'));
  const smbAtimeMs = Date.now() - 12_000_000;
  const smbMtimeMs = Date.now() - 6_000_000;
  fs.utimesSync(incomingPath, smbAtimeMs / 1000, smbMtimeMs / 1000);

  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));
  const imported = db.prepare(`
    SELECT files.*, folders.name AS folder_name
    FROM files LEFT JOIN folders ON folders.id = files.folder_id
    WHERE files.repository_id = ? AND files.original_name = 'new.bin'
  `).get(repository.id);
  assert.ok(imported);
  assert.equal(imported.folder_name, 'Incoming');
  const importedStoredPath = path.join(repositoryRoot, imported.stored_name);
  assert.equal(sameInode(incomingPath, importedStoredPath), true);
  assert.ok(Math.abs(fs.statSync(importedStoredPath).atimeMs - smbAtimeMs) < 2);
  assert.ok(Math.abs(fs.statSync(importedStoredPath).mtimeMs - smbMtimeMs) < 2);

  const importedFolder = db.prepare(`
    SELECT * FROM folders WHERE repository_id = ? AND name = 'Incoming'
  `).get(repository.id);
  let renamedFolderPath = path.join(shareRoot, 'Renamed Incoming');
  fs.renameSync(incomingFolder, renamedFolderPath);
  fs.mkdirSync(incomingFolder);
  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));
  assert.equal(db.prepare('SELECT name FROM folders WHERE id = ?').get(importedFolder.id).name, 'Renamed Incoming');
  assert.ok(db.prepare(`
    SELECT 1 FROM folders WHERE repository_id = ? AND name = 'Incoming' AND id <> ?
  `).get(repository.id, importedFolder.id));

  const caseRenamedFolderPath = path.join(shareRoot, 'renamed incoming');
  fs.renameSync(renamedFolderPath, caseRenamedFolderPath);
  renamedFolderPath = caseRenamedFolderPath;
  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));
  assert.equal(db.prepare('SELECT name FROM folders WHERE id = ?').get(importedFolder.id).name, 'renamed incoming');

  const movedPath = path.join(renamedFolderPath, 'moved.bin');
  fs.renameSync(path.join(renamedFolderPath, 'new.bin'), movedPath);
  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));
  const moved = db.prepare('SELECT * FROM files WHERE id = ?').get(imported.id);
  assert.equal(moved.original_name, 'moved.bin');
  assert.equal(sameInode(movedPath, importedStoredPath), true);

  const movedAtimeMs = Date.now() - 25_000_000;
  fs.utimesSync(movedPath, movedAtimeMs / 1000, fs.statSync(movedPath).mtimeMs / 1000);
  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));
  const movedAfterTimeChange = db.prepare('SELECT * FROM files WHERE id = ?').get(imported.id);
  assert.ok(Math.abs(Number(movedAfterTimeChange.initial_access_time_ms) - movedAtimeMs) < 2);
  restoreRepositoryInitialAccessTimes(db, config, repository.id);
  assert.ok(Math.abs(fs.statSync(movedPath).atimeMs - movedAtimeMs) < 2);

  const replacementPath = path.join(renamedFolderPath, 'replacement.tmp');
  fs.writeFileSync(replacementPath, Buffer.from('replacement payload with a different inode'));
  const replacementAtimeMs = Date.now() - 20_000_000;
  const replacementMtimeMs = Date.now() - 10_000_000;
  fs.utimesSync(replacementPath, replacementAtimeMs / 1000, replacementMtimeMs / 1000);
  fs.renameSync(replacementPath, movedPath);
  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));
  const replaced = db.prepare('SELECT * FROM files WHERE id = ?').get(imported.id);
  assert.notEqual(replaced.stored_name, imported.stored_name);
  const replacedStoredPath = path.join(repositoryRoot, replaced.stored_name);
  assert.equal(sameInode(movedPath, replacedStoredPath), true);
  assert.ok(Math.abs(fs.statSync(replacedStoredPath).atimeMs - replacementAtimeMs) < 2);
  assert.ok(Math.abs(fs.statSync(replacedStoredPath).mtimeMs - replacementMtimeMs) < 2);
  assert.equal(fs.existsSync(importedStoredPath), false);

  fs.rmSync(movedPath);
  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));
  assert.equal(db.prepare('SELECT 1 FROM files WHERE id = ?').get(imported.id), undefined);
  assert.equal(fs.existsSync(replacedStoredPath), false);

  // Losing a projection volume must rebuild from canonical storage rather than
  // interpreting every missing projection entry as an SMB delete.
  fs.rmSync(shareRoot, { recursive: true, force: true });
  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));
  assert.ok(db.prepare("SELECT 1 FROM files WHERE id = 'web-file'").get());
  assert.equal(sameInode(storedPath, path.join(shareRoot, 'renamed-report.txt')), true);
  assert.equal(fs.existsSync(path.join(shareRoot, '.recorddrive-projection')), true);
});

test('rejects over-quota SMB files and removes symbolic links from the projection', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-smb-quota-'));
  const config = {
    ...testConfig(tempRoot),
    maxFileSizeMb: 0.000001
  };
  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const repository = createRepository(db);
  reconcileSmbRepository(db, config, repository);
  const shareRoot = path.join(config.smbShareRoot, String(repository.id));
  const oversized = path.join(shareRoot, 'too-large.bin');
  fs.writeFileSync(oversized, Buffer.alloc(64));
  const symlinkPath = path.join(shareRoot, 'outside-link');
  fs.symlinkSync(os.tmpdir(), symlinkPath, 'dir');

  reconcileSmbRepository(db, config, db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id));

  assert.equal(fs.existsSync(oversized), false);
  assert.equal(fs.existsSync(symlinkPath), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM files WHERE repository_id = ?').get(repository.id).count, 0);
  assert.ok(db.prepare(`
    SELECT 1 FROM activity_logs
    WHERE repository_id = ? AND action = 'SMB_REJECT_FILE_QUOTA'
  `).get(repository.id));
});
