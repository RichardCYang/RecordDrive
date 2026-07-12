import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApplication } from '../src/app.js';
import { ensureSecureRepositoryDirectory } from '../src/file-access-time.js';

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should exist in rendered HTML');
  return match[1];
}

function testConfig(tempRoot) {
  return {
    port: 0,
    nodeEnv: 'test',
    isProduction: false,
    trustProxy: false,
    sessionSecret: 'storage-settings-test-secret-with-more-than-thirty-two-characters',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    maxFileSizeMb: 5,
    maxFilesPerUpload: 3,
    maxRepositoryFiles: 100,
    maxTotalFiles: 1000,
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads')
  };
}

async function loginAdministrator(agent) {
  const page = await agent.get('/login').expect(200);
  await agent
    .post('/login')
    .type('form')
    .send({
      _csrf: csrfFrom(page.text),
      username: 'admin',
      password: 'TestPassword123!'
    })
    .expect(302)
    .expect('Location', '/');
}

function createStoredFile(db, config, contents = 'Repository storage test data') {
  const passwordHash = bcrypt.hashSync('OwnerPassword123!', 4);
  const owner = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('storage.owner', 'Storage Owner', ?, 'USER')
  `).run(passwordHash);
  const repository = db.prepare(`
    INSERT INTO repositories (name, description, created_by)
    VALUES ('Storage Test Repository', 'Storage path coverage', ?)
  `).run(owner.lastInsertRowid);
  const repositoryId = Number(repository.lastInsertRowid);
  const storedName = 'stored-file-id';
  const repositoryDirectory = ensureSecureRepositoryDirectory(config, repositoryId);
  fs.writeFileSync(path.join(repositoryDirectory, storedName), contents, { mode: 0o600 });
  db.prepare(`
    INSERT INTO files (id, repository_id, original_name, stored_name, mime_type, size, uploaded_by)
    VALUES ('storage-file-id', ?, 'record.txt', ?, 'text/plain', ?, ?)
  `).run(repositoryId, storedName, Buffer.byteLength(contents), owner.lastInsertRowid);
  return { repositoryId, storedName, contents };
}

test('moves repository data to an administrator-selected external path and reloads it on restart', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-storage-settings-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const storedFile = createStoredFile(db, config);
  const originalRoot = config.uploadRoot;
  const externalRoot = path.join(tempRoot, 'external-repository-data');
  const agent = request.agent(app);

  t.after(() => {
    try {
      db.close();
    } catch {
      // The database may already be closed by the restart assertion.
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await loginAdministrator(agent);
  const storagePage = await agent.get('/admin/storage').expect(200);
  assert.match(storagePage.text, /Repository local filesystem path/);
  assert.match(storagePage.text, new RegExp(originalRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await agent
    .post('/admin/storage')
    .type('form')
    .send({
      _csrf: csrfFrom(storagePage.text),
      repositoryRoot: 'relative/storage/path',
      migrationMode: 'move'
    })
    .expect(400);
  assert.equal(config.uploadRoot, originalRoot);

  const validPage = await agent.get('/admin/storage').expect(200);
  await agent
    .post('/admin/storage')
    .type('form')
    .send({
      _csrf: csrfFrom(validPage.text),
      repositoryRoot: externalRoot,
      migrationMode: 'move'
    })
    .expect(302)
    .expect('Location', '/admin/storage');

  assert.equal(config.uploadRoot, fs.realpathSync(externalRoot));
  assert.equal(fs.existsSync(originalRoot), false);
  const movedPath = path.join(externalRoot, String(storedFile.repositoryId), storedFile.storedName);
  assert.equal(fs.readFileSync(movedPath, 'utf8'), storedFile.contents);

  const storedSetting = JSON.parse(db.prepare(`
    SELECT setting_value FROM app_settings WHERE setting_key = 'storage.repositoryRoot'
  `).get().setting_value);
  assert.equal(storedSetting.repositoryRoot, fs.realpathSync(externalRoot));

  db.close();
  const restartedConfig = testConfig(tempRoot);
  const restartedApp = createApplication({ config: restartedConfig });
  const restartedDb = restartedApp.locals.db;
  assert.equal(restartedConfig.uploadRoot, fs.realpathSync(externalRoot));
  assert.equal(fs.readFileSync(movedPath, 'utf8'), storedFile.contents);
  restartedDb.close();
});

test('verifies pre-positioned repository data before using an existing external path', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-storage-existing-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const storedFile = createStoredFile(db, config, 'Pre-positioned data');
  const existingRoot = path.join(tempRoot, 'mounted-repository-data');
  const agent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await loginAdministrator(agent);
  const missingDataPage = await agent.get('/admin/storage').expect(200);
  await agent
    .post('/admin/storage')
    .type('form')
    .send({
      _csrf: csrfFrom(missingDataPage.text),
      repositoryRoot: existingRoot,
      migrationMode: 'use-existing'
    })
    .expect(400);
  assert.notEqual(config.uploadRoot, existingRoot);

  fs.writeFileSync(path.join(existingRoot, 'unmanaged.txt'), 'Unmanaged data');
  const unmanagedDataPage = await agent.get('/admin/storage').expect(200);
  const unmanagedResponse = await agent
    .post('/admin/storage')
    .type('form')
    .send({
      _csrf: csrfFrom(unmanagedDataPage.text),
      repositoryRoot: existingRoot,
      migrationMode: 'use-existing'
    })
    .expect(400);
  assert.match(unmanagedResponse.text, /not managed by this database/);
  fs.rmSync(existingRoot, { recursive: true, force: true });

  fs.cpSync(config.uploadRoot, existingRoot, { recursive: true });
  const readyPage = await agent.get('/admin/storage').expect(200);
  await agent
    .post('/admin/storage')
    .type('form')
    .send({
      _csrf: csrfFrom(readyPage.text),
      repositoryRoot: existingRoot,
      migrationMode: 'use-existing'
    })
    .expect(302)
    .expect('Location', '/admin/storage');

  assert.equal(config.uploadRoot, fs.realpathSync(existingRoot));
  assert.equal(
    fs.readFileSync(path.join(existingRoot, String(storedFile.repositoryId), storedFile.storedName), 'utf8'),
    storedFile.contents
  );
});
