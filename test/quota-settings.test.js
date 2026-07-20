import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApplication } from '../src/app.js';
import { resetAuthenticationRateLimits } from '../src/middleware/login-rate-limit.js';

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
    sessionSecret: 'database-quota-test-secret-with-more-than-thirty-two-characters',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    maxFileSizeMb: 5,
    maxFilesPerUpload: 3,
    maxRepositoryStorageMb: 10,
    maxTotalStorageMb: 20,
    maxRepositoryFiles: 100,
    maxTotalFiles: 1000,
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads')
  };
}

async function login(agent, username, password) {
  const page = await agent.get('/login').expect(200);
  await agent.post('/login').type('form').send({
    _csrf: csrfFrom(page.text),
    username,
    password
  }).expect(302);
}

test('stores global quotas in SQLite and applies administrator changes without a restart', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-db-quota-admin-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const ownerPassword = 'OwnerQuotaPassword123!';
  const ownerId = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'USER')
  `).run('quota.owner', 'Quota Owner', bcrypt.hashSync(ownerPassword, 12)).lastInsertRowid);
  const repositoryId = Number(db.prepare(`
    INSERT INTO repositories (name, description, created_by)
    VALUES (?, '', ?)
  `).run('Database Quota Repository', ownerId).lastInsertRowid);
  const admin = request.agent(app);
  const owner = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(
    db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'quota.max_file_size_mb'").get().setting_value,
    '5'
  );

  await login(admin, 'admin', 'TestPassword123!');
  const storagePage = await admin.get('/admin/storage').expect(200);
  assert.match(storagePage.text, /Database backed/);
  await admin.post('/admin/storage/limits').type('form').send({
    _csrf: csrfFrom(storagePage.text),
    maxFileSizeMb: '0.003',
    maxFilesPerUpload: '2',
    maxRepositoryStorageMb: '0.0035',
    maxTotalStorageMb: '0.010',
    maxRepositoryFiles: '12',
    maxTotalFiles: '120'
  }).expect(302).expect('Location', '/admin/storage');

  assert.equal(
    db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'quota.max_file_size_mb'").get().setting_value,
    '0.003'
  );

  await login(owner, 'quota.owner', ownerPassword);
  const repositoryPage = await owner.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(repositoryPage.text, /Up to 0\.003 MB per file/);

  const accepted = await owner
    .post(`/repositories/${repositoryId}/upload`)
    .set('Accept', 'application/json')
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('_csrf', csrfFrom(repositoryPage.text))
    .attach('files', Buffer.alloc(2 * 1024, 0x61), 'accepted.bin')
    .expect(200);
  assert.equal(accepted.body.ok, true);

  const nextPage = await owner.get(`/repositories/${repositoryId}`).expect(200);
  const rejected = await owner
    .post(`/repositories/${repositoryId}/upload`)
    .set('Accept', 'application/json')
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('_csrf', csrfFrom(nextPage.text))
    .attach('files', Buffer.alloc(2 * 1024, 0x62), 'quota-exceeded.bin')
    .expect(413);
  assert.match(rejected.body.error, /repository storage quota/i);
});

test('allows owners and administrators to change repository overrides while blocking shared users', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-db-quota-owner-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const password = 'RepositorySettingsPassword123!';
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'USER')
  `);
  const ownerId = Number(insertUser.run(
    'settings.owner',
    'Settings Owner',
    bcrypt.hashSync(password, 12)
  ).lastInsertRowid);
  const sharedId = Number(insertUser.run(
    'settings.shared',
    'Settings Shared',
    bcrypt.hashSync(password, 12)
  ).lastInsertRowid);
  const repositoryId = Number(db.prepare(`
    INSERT INTO repositories (name, description, created_by)
    VALUES (?, '', ?)
  `).run('Owner Override Repository', ownerId).lastInsertRowid);
  db.prepare(`
    INSERT INTO repository_permissions (repository_id, user_id, can_view, can_upload, added_by)
    VALUES (?, ?, 1, 1, ?)
  `).run(repositoryId, sharedId, ownerId);

  const owner = request.agent(app);
  const shared = request.agent(app);
  const admin = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await login(owner, 'settings.owner', password);
  const settingsPage = await owner.get(`/repositories/${repositoryId}/settings`).expect(200);
  assert.match(settingsPage.text, /Repository-specific limits/);
  await owner.post(`/repositories/${repositoryId}/settings`).type('form').send({
    _csrf: csrfFrom(settingsPage.text),
    fileAccessTimePolicy: 'enabled',
    maxFileSizeMb: '1.5',
    maxRepositoryStorageMb: '25.5'
  }).expect(302);

  const savedRepository = db.prepare(`
    SELECT max_file_size_mb, max_storage_mb FROM repositories WHERE id = ?
  `).get(repositoryId);
  assert.equal(savedRepository.max_file_size_mb, 1.5);
  assert.equal(savedRepository.max_storage_mb, 25.5);

  await login(shared, 'settings.shared', password);
  await shared.get(`/repositories/${repositoryId}/settings`).expect(404);

  await login(admin, 'admin', 'TestPassword123!');
  const adminSettingsPage = await admin.get(`/repositories/${repositoryId}/settings`).expect(200);
  await admin.post(`/repositories/${repositoryId}/settings`).type('form').send({
    _csrf: csrfFrom(adminSettingsPage.text),
    fileAccessTimePolicy: 'enabled',
    maxFileSizeMb: '',
    maxRepositoryStorageMb: '0'
  }).expect(302);

  const administratorUpdate = db.prepare(`
    SELECT max_file_size_mb, max_storage_mb FROM repositories WHERE id = ?
  `).get(repositoryId);
  assert.equal(administratorUpdate.max_file_size_mb, null);
  assert.equal(administratorUpdate.max_storage_mb, 0);
});
