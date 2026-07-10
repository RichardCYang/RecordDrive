import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApplication } from '../src/app.js';

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should exist in rendered HTML');
  return match[1];
}

test('supports the administrator, repository, account, participant, and file upload workflow', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-test-'));
  const config = {
    port: 0,
    nodeEnv: 'test',
    isProduction: false,
    sessionSecret: 'test-session-secret-with-more-than-thirty-two-characters',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    maxFileSizeMb: 5,
    maxFilesPerUpload: 3,
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads')
  };

  const app = createApplication({ config });
  const db = app.locals.db;
  const agent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const health = await agent.get('/health').expect(200);
  assert.equal(health.body.status, 'ok');

  const loginPage = await agent.get('/login').expect(200);
  assert.match(loginPage.text, /<html lang="en">/);
  assert.match(loginPage.text, /Sign in to RecordDrive/);
  const loginCsrf = csrfFrom(loginPage.text);
  await agent
    .post('/login')
    .type('form')
    .send({ _csrf: loginCsrf, username: 'admin', password: 'TestPassword123!' })
    .expect(302)
    .expect('Location', '/');

  const repositoriesPage = await agent.get('/admin/repositories').expect(200);
  const repositoriesCsrf = csrfFrom(repositoriesPage.text);
  await agent
    .post('/admin/repositories')
    .type('form')
    .send({ _csrf: repositoriesCsrf, name: 'Test Repository', description: 'Automated test workspace' })
    .expect(302);

  const repository = db.prepare('SELECT * FROM repositories WHERE name = ?').get('Test Repository');
  assert.ok(repository);

  const usersPage = await agent.get('/admin/users').expect(200);
  const usersCsrf = csrfFrom(usersPage.text);
  await agent
    .post('/admin/users')
    .type('form')
    .send({
      _csrf: usersCsrf,
      displayName: 'Test User',
      username: 'test.user',
      password: 'UserPassword123!'
    })
    .expect(302);

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get('test.user');
  assert.ok(user);

  const participantPage = await agent
    .get(`/admin/repositories/${repository.id}/participants`)
    .expect(200);
  const participantCsrf = csrfFrom(participantPage.text);
  await agent
    .post(`/admin/repositories/${repository.id}/participants`)
    .type('form')
    .send({ _csrf: participantCsrf, userId: user.id })
    .expect(302);

  const membership = db.prepare(`
    SELECT 1 AS found FROM repository_members WHERE repository_id = ? AND user_id = ?
  `).get(repository.id, user.id);
  assert.equal(membership.found, 1);

  const repositoryPage = await agent.get(`/repositories/${repository.id}`).expect(200);
  const uploadCsrf = csrfFrom(repositoryPage.text);
  await agent
    .post(`/repositories/${repository.id}/upload`)
    .field('_csrf', uploadCsrf)
    .attach('files', Buffer.from('RecordDrive smoke test'), 'record.txt')
    .expect(302);

  const uploadedFile = db.prepare('SELECT * FROM files WHERE repository_id = ?').get(repository.id);
  assert.equal(uploadedFile.original_name, 'record.txt');
  assert.ok(fs.existsSync(path.join(config.uploadRoot, String(repository.id), uploadedFile.stored_name)));

  const explorerPage = await agent
    .get(`/repositories/${repository.id}?sort=name-asc&q=record`)
    .expect(200);
  assert.match(explorerPage.text, /data-file-explorer/);
  assert.match(explorerPage.text, /Search repository files/);
  assert.match(explorerPage.text, /Upload files/);
  assert.match(explorerPage.text, /data-view-mode="grid"/);
  assert.match(explorerPage.text, /data-file-filter="document,pdf,sheet,slide"/);
  assert.match(explorerPage.text, /record\.txt/);
  assert.match(explorerPage.text, /option value="name-asc" selected/);

  await agent
    .get(`/repositories/${repository.id}/files/${uploadedFile.id}/download`)
    .expect(200)
    .expect('Content-Disposition', /record\.txt/);
});
