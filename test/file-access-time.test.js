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

function testConfig(tempRoot) {
  return {
    port: 0,
    nodeEnv: 'test',
    isProduction: false,
    sessionSecret: 'access-time-test-session-secret-with-more-than-thirty-two-characters',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    maxFileSizeMb: 5,
    maxFilesPerUpload: 3,
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads')
  };
}

async function login(agent, username, password) {
  const page = await agent.get('/login').expect(200);
  await agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), username, password })
    .expect(302)
    .expect('Location', '/');
}

async function createUser(adminAgent, displayName, username, password) {
  const page = await adminAgent.get('/admin/users').expect(200);
  await adminAgent
    .post('/admin/users')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), displayName, username, password })
    .expect(302)
    .expect('Location', '/admin/users');
}

async function createRepository(agent, name) {
  const page = await agent.get('/').expect(200);
  const response = await agent
    .post('/repositories')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), name, description: 'Access time integration tests' })
    .expect(302);
  return Number(response.headers.location.split('/').at(-1));
}

async function saveAccessTimePolicy(agent, repositoryId, policy) {
  const page = await agent.get(`/repositories/${repositoryId}/settings`).expect(200);
  await agent
    .post(`/repositories/${repositoryId}/settings`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), fileAccessTimePolicy: policy })
    .expect(302)
    .expect('Location', `/repositories/${repositoryId}/settings`);
}

function assertTimeClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 2, `${message}: expected ${expected}, received ${actual}`);
}

const minimalPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
  'trailer\n<< /Root 1 0 R >>\n%%EOF\n'
);

test('repository owners and administrators control file access time updates', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-atime-test-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const adminAgent = request.agent(app);
  await login(adminAgent, 'admin', 'TestPassword123!');
  await createUser(adminAgent, 'Repository Owner', 'atime.owner', 'OwnerPassword123!');
  await createUser(adminAgent, 'Shared User', 'atime.shared', 'SharedPassword123!');

  const owner = db.prepare('SELECT * FROM users WHERE username = ?').get('atime.owner');
  const shared = db.prepare('SELECT * FROM users WHERE username = ?').get('atime.shared');
  const ownerAgent = request.agent(app);
  await login(ownerAgent, owner.username, 'OwnerPassword123!');
  const repositoryId = await createRepository(ownerAgent, 'Access Time Repository');

  const repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
  assert.equal(repository.update_file_access_time, 1);

  const settingsPage = await ownerAgent
    .get(`/repositories/${repositoryId}/settings`)
    .expect(200);
  assert.match(settingsPage.text, /name="fileAccessTimePolicy"/);
  assert.match(settingsPage.text, /value="enabled" selected/);
  assert.match(settingsPage.text, /value="disabled"/);

  const koreanSettingsPage = await ownerAgent
    .get(`/repositories/${repositoryId}/settings`)
    .set('Accept-Language', 'ko-KR,ko;q=0.9')
    .expect(200)
    .expect('Content-Language', 'ko');
  assert.match(koreanSettingsPage.text, />사용함</);
  assert.match(koreanSettingsPage.text, />사용 안 함</);

  const repositoryPage = await ownerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(repositoryPage.text, /data-repository-settings/);
  await ownerAgent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', csrfFrom(repositoryPage.text))
    .attach('files', minimalPdf, 'access-time.pdf')
    .expect(302)
    .expect('Location', `/repositories/${repositoryId}`);

  const file = db.prepare('SELECT * FROM files WHERE repository_id = ?').get(repositoryId);
  assert.ok(Number.isFinite(file.initial_access_time_ms));
  const filePath = path.join(config.uploadRoot, String(repositoryId), file.stored_name);
  const originalMtimeMs = fs.statSync(filePath).mtimeMs;
  const oldAccessTime = new Date('2001-02-03T04:05:06.000Z');
  fs.utimesSync(filePath, oldAccessTime, new Date(originalMtimeMs));
  const storedInitialAccessTimeMs = fs.statSync(filePath).atimeMs;
  db.prepare('UPDATE files SET initial_access_time_ms = ? WHERE id = ?')
    .run(storedInitialAccessTimeMs, file.id);

  await ownerAgent
    .get(`/repositories/${repositoryId}/files/${file.id}/download`)
    .expect(200)
    .expect('Content-Disposition', /attachment/);
  const enabledDownloadStats = fs.statSync(filePath);
  assert.ok(enabledDownloadStats.atimeMs > storedInitialAccessTimeMs + 1000);
  assertTimeClose(enabledDownloadStats.mtimeMs, originalMtimeMs, 'Download should preserve modification time');

  await saveAccessTimePolicy(ownerAgent, repositoryId, 'disabled');
  assert.equal(
    db.prepare('SELECT update_file_access_time FROM repositories WHERE id = ?').get(repositoryId).update_file_access_time,
    0
  );
  assertTimeClose(
    fs.statSync(filePath).atimeMs,
    storedInitialAccessTimeMs,
    'Disabling updates should restore the initial access time'
  );

  await ownerAgent
    .get(`/repositories/${repositoryId}/files/${file.id}/download`)
    .expect(200);
  assertTimeClose(
    fs.statSync(filePath).atimeMs,
    storedInitialAccessTimeMs,
    'Disabled downloads should preserve the initial access time'
  );

  await ownerAgent
    .get(`/repositories/${repositoryId}/files/${file.id}/preview`)
    .expect(200)
    .expect('Content-Type', /application\/pdf/);
  assertTimeClose(
    fs.statSync(filePath).atimeMs,
    storedInitialAccessTimeMs,
    'Disabled previews should preserve the initial access time'
  );

  const permissionPage = await ownerAgent.get(`/repositories/${repositoryId}/permissions`).expect(200);
  await ownerAgent
    .post(`/repositories/${repositoryId}/permissions`)
    .type('form')
    .send({
      _csrf: csrfFrom(permissionPage.text),
      userId: shared.id,
      canView: '1',
      canDownload: '1'
    })
    .expect(302);

  const sharedAgent = request.agent(app);
  await login(sharedAgent, shared.username, 'SharedPassword123!');
  await sharedAgent.get(`/repositories/${repositoryId}`).expect(200);
  await sharedAgent.get(`/repositories/${repositoryId}/settings`).expect(404);
  const sharedDashboard = await sharedAgent.get('/').expect(200);
  await sharedAgent
    .post(`/repositories/${repositoryId}/settings`)
    .type('form')
    .send({ _csrf: csrfFrom(sharedDashboard.text), fileAccessTimePolicy: 'enabled' })
    .expect(404);

  await adminAgent.get(`/repositories/${repositoryId}/settings`).expect(200);
  await saveAccessTimePolicy(adminAgent, repositoryId, 'enabled');
  assert.equal(
    db.prepare('SELECT update_file_access_time FROM repositories WHERE id = ?').get(repositoryId).update_file_access_time,
    1
  );

  await adminAgent
    .get(`/repositories/${repositoryId}/files/${file.id}/preview`)
    .expect(200);
  assert.ok(fs.statSync(filePath).atimeMs > storedInitialAccessTimeMs + 1000);
});
