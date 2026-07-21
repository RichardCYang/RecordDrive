import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
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
    sessionSecret: 'upload-limit-test-secret-with-more-than-thirty-two-characters',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    maxFileSizeMb: 0,
    maxFilesPerUpload: 3,
    maxRepositoryStorageMb: 5,
    maxTotalStorageMb: 10,
    maxRepositoryFiles: 10,
    maxTotalFiles: 20,
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads')
  };
}

test('MAX_FILE_SIZE_MB=0 disables the separate per-file limit', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-config-upload-limit-'));
  try {
    const config = loadConfig({
      NODE_ENV: 'test',
      MAX_FILE_SIZE_MB: '0',
      DB_PATH: path.join(tempRoot, 'recorddrive.db'),
      UPLOAD_ROOT: path.join(tempRoot, 'uploads')
    });
    assert.equal(config.maxFileSizeMb, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('unlimited per-file uploads still stream through repository storage quotas', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-unlimited-file-upload-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  const passwordHash = bcrypt.hashSync('LargeUploadPassword123!', 12);
  const userId = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'USER')
  `).run('large.upload.owner', 'Large Upload Owner', passwordHash).lastInsertRowid);
  const repositoryId = Number(db.prepare(`
    INSERT INTO repositories (name, description, created_by)
    VALUES (?, '', ?)
  `).run('Large Upload Repository', userId).lastInsertRowid);
  const agent = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const loginPage = await agent.get('/login').expect(200);
  await agent.post('/login').type('form').send({
    _csrf: csrfFrom(loginPage.text),
    username: 'large.upload.owner',
    password: 'LargeUploadPassword123!'
  }).expect(302);

  const repositoryPage = await agent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(repositoryPage.text, /No per-file size limit/);

  const accepted = await agent
    .post(`/repositories/${repositoryId}/upload`)
    .set('Accept', 'application/json')
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('_csrf', csrfFrom(repositoryPage.text))
    .attach('files', Buffer.alloc(2 * 1024 * 1024, 0x61), 'large-accepted.bin')
    .expect(200);
  assert.equal(accepted.body.ok, true);

  const quotaPage = await agent.get(`/repositories/${repositoryId}`).expect(200);
  const rejected = await agent
    .post(`/repositories/${repositoryId}/upload`)
    .set('Accept', 'application/json')
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('_csrf', csrfFrom(quotaPage.text))
    .attach('files', Buffer.alloc(4 * 1024 * 1024, 0x62), 'repository-quota.bin')
    .expect(413);
  assert.match(rejected.body.error, /repository storage quota/i);

  const stored = db.prepare(`
    SELECT original_name, size FROM files WHERE repository_id = ? ORDER BY created_at
  `).all(repositoryId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].original_name, 'large-accepted.bin');
  assert.equal(stored[0].size, 2 * 1024 * 1024);
  const repositoryFiles = fs.readdirSync(path.join(config.uploadRoot, String(repositoryId)))
    .map((name) => ({
      name,
      size: fs.statSync(path.join(config.uploadRoot, String(repositoryId), name)).size
    }));
  assert.equal(repositoryFiles.length, 1, JSON.stringify(repositoryFiles));
});
