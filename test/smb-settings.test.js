import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/database.js';
import {
  repositorySmbView,
  updateRepositorySmbSettings
} from '../src/smb-settings.js';
import { normalizeAndValidateStorageConfiguration } from '../src/storage-path-security.js';

function testConfig(tempRoot) {
  return {
    nodeEnv: 'test',
    isProduction: false,
    sessionSecret: 'smb-settings-test-secret-with-more-than-thirty-two-characters',
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
    smbSyncIntervalMs: 1000
  };
}

function createRepository(db) {
  const owner = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('smb.owner', 'SMB Owner', 'not-used', 'USER')
  `).run();
  const repository = db.prepare(`
    INSERT INTO repositories (name, description, created_by)
    VALUES ('SMB Repository', 'SMB settings test', ?)
  `).run(owner.lastInsertRowid);
  return db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.lastInsertRowid);
}

function writeReadyStatus(config, xattrSupported = true) {
  fs.mkdirSync(config.smbControlRoot, { recursive: true });
  fs.writeFileSync(path.join(config.smbControlRoot, 'status.json'), JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    xattrSupported,
    protocolMin: 'SMB2_10',
    protocolMax: 'SMB3'
  }), { mode: 0o600 });
}

test('enables and disables a repository SMB share with one-time credential commands', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-smb-settings-'));
  const config = testConfig(tempRoot);
  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const repository = createRepository(db);
  writeReadyStatus(config);
  const enabled = updateRepositorySmbSettings(db, config, repository, {
    enabled: true,
    readOnly: false,
    password: 'RepositorySmbPassword123!'
  }, repository.created_by);

  assert.equal(enabled.enabled, true);
  const saved = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id);
  assert.equal(saved.smb_enabled, 1);
  assert.equal(saved.update_file_access_time, 0);
  assert.ok(saved.smb_credential_updated_at);

  const view = repositorySmbView(saved, config, 'ignored.example');
  assert.equal(view.uncPath, '\\\\fileserver\\recorddrive-1');
  assert.equal(view.username, 'rd_repo_1');
  assert.equal(view.runtimeReady, true);
  assert.equal(view.xattrSupported, true);

  const manifest = JSON.parse(fs.readFileSync(path.join(config.smbControlRoot, 'shares.json'), 'utf8'));
  assert.deepEqual(manifest.shares.map(({ shareName, username, path: sharePath }) => ({
    shareName,
    username,
    sharePath
  })), [{
    shareName: 'recorddrive-1',
    username: 'rd_repo_1',
    sharePath: '/data/smb-shares/1'
  }]);

  const commandDirectory = path.join(config.smbControlRoot, 'credentials');
  const setCommandPath = fs.readdirSync(commandDirectory).map((name) => path.join(commandDirectory, name))[0];
  const setCommand = JSON.parse(fs.readFileSync(setCommandPath, 'utf8'));
  assert.equal(setCommand.action, 'set');
  assert.equal(setCommand.password, 'RepositorySmbPassword123!');
  assert.equal(fs.statSync(setCommandPath).mode & 0o777, 0o600);

  updateRepositorySmbSettings(db, config, saved, {
    enabled: false,
    readOnly: false,
    password: ''
  }, repository.created_by);

  const disabled = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id);
  assert.equal(disabled.smb_enabled, 0);
  assert.equal(disabled.smb_credential_updated_at, null);
  const disabledManifest = JSON.parse(fs.readFileSync(path.join(config.smbControlRoot, 'shares.json'), 'utf8'));
  assert.deepEqual(disabledManifest.shares, []);
  const actions = fs.readdirSync(commandDirectory)
    .map((name) => JSON.parse(fs.readFileSync(path.join(commandDirectory, name), 'utf8')).action)
    .sort();
  assert.deepEqual(actions, ['delete', 'set']);
});

test('requires a ready sidecar and extended-attribute support before enabling SMB', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-smb-readiness-'));
  const config = testConfig(tempRoot);
  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const repository = createRepository(db);

  assert.throws(() => updateRepositorySmbSettings(db, config, repository, {
    enabled: true,
    readOnly: false,
    password: 'RepositorySmbPassword123!'
  }, repository.created_by), /sidecar is not ready/);

  fs.mkdirSync(config.smbControlRoot, { recursive: true });
  fs.writeFileSync(path.join(config.smbControlRoot, 'status.json'), JSON.stringify({
    version: 1,
    generatedAt: new Date(Date.now() - 60_000).toISOString(),
    xattrSupported: true
  }));
  assert.throws(() => updateRepositorySmbSettings(db, config, repository, {
    enabled: true,
    readOnly: false,
    password: 'RepositorySmbPassword123!'
  }, repository.created_by), /sidecar is not ready/);

  writeReadyStatus(config, false);
  assert.throws(() => updateRepositorySmbSettings(db, config, repository, {
    enabled: true,
    readOnly: false,
    password: 'RepositorySmbPassword123!'
  }, repository.created_by), /does not support the extended attributes/);
});

test('rejects SMB roots that overlap protected or canonical storage paths', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-smb-paths-'));
  try {
    assert.throws(() => normalizeAndValidateStorageConfiguration({
      ...testConfig(tempRoot),
      smbShareRoot: path.join(tempRoot, 'uploads', 'shares')
    }), /SMB_SHARE_ROOT and UPLOAD_ROOT cannot contain one another/);

    assert.throws(() => normalizeAndValidateStorageConfiguration({
      ...testConfig(tempRoot),
      smbShareRoot: path.resolve('.git', 'smb-shares')
    }), /Git metadata directory/);

    assert.throws(() => normalizeAndValidateStorageConfiguration({
      ...testConfig(tempRoot),
      smbContainerShareRoot: '/data/smb-shares/../injected'
    }), /normalized absolute POSIX path/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
