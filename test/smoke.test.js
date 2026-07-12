import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApplication } from '../src/app.js';
import { createDatabase } from '../src/database.js';

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
    sessionSecret: 'test-session-secret-with-more-than-thirty-two-characters',
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
  const csrf = csrfFrom(page.text);
  await agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrf, username, password })
    .expect(302)
    .expect('Location', '/');
}

async function createUser(adminAgent, { displayName, username, password }) {
  const page = await adminAgent.get('/admin/users').expect(200);
  const csrf = csrfFrom(page.text);
  await adminAgent
    .post('/admin/users')
    .type('form')
    .send({ _csrf: csrf, displayName, username, password })
    .expect(302)
    .expect('Location', '/admin/users');
}

async function createRepository(agent, name, description = '') {
  const dashboard = await agent.get('/').expect(200);
  const csrf = csrfFrom(dashboard.text);
  const response = await agent
    .post('/repositories')
    .type('form')
    .send({ _csrf: csrf, name, description })
    .expect(302);
  return Number(response.headers.location.split('/').at(-1));
}

async function grantPermissions(ownerAgent, repositoryId, userId, permissions) {
  const page = await ownerAgent.get(`/repositories/${repositoryId}/permissions`).expect(200);
  const csrf = csrfFrom(page.text);
  const body = { _csrf: csrf, userId };
  if (permissions.view) body.canView = '1';
  if (permissions.upload) body.canUpload = '1';
  if (permissions.download) body.canDownload = '1';
  if (permissions.delete) body.canDelete = '1';

  await ownerAgent
    .post(`/repositories/${repositoryId}/permissions`)
    .type('form')
    .send(body)
    .expect(302)
    .expect('Location', `/repositories/${repositoryId}/permissions`);
}

async function updatePermissions(ownerAgent, repositoryId, userId, permissions) {
  const page = await ownerAgent.get(`/repositories/${repositoryId}/permissions`).expect(200);
  const csrf = csrfFrom(page.text);
  const body = { _csrf: csrf };
  if (permissions.view) body.canView = '1';
  if (permissions.upload) body.canUpload = '1';
  if (permissions.download) body.canDownload = '1';
  if (permissions.delete) body.canDelete = '1';

  await ownerAgent
    .post(`/repositories/${repositoryId}/permissions/${userId}`)
    .type('form')
    .send(body)
    .expect(302)
    .expect('Location', `/repositories/${repositoryId}/permissions`);
}

test('supports personal repositories and independent per-user permissions', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-test-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const adminAgent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const health = await adminAgent.get('/health').expect(200);
  assert.equal(health.body.status, 'ok');

  await login(adminAgent, 'admin', 'TestPassword123!');

  const tlsSettingsPage = await adminAgent.get('/admin/tls').expect(200);
  assert.match(tlsSettingsPage.text, /HTTPS and TLS settings/);
  assert.match(tlsSettingsPage.text, /Posh-ACME certificate directory/);
  const tlsCsrf = csrfFrom(tlsSettingsPage.text);

  const invalidTlsPage = await adminAgent
    .post('/admin/tls')
    .type('form')
    .send({
      _csrf: tlsCsrf,
      httpsEnabled: '1',
      redirectHttpToHttps: '1',
      httpHost: '127.0.0.1',
      httpPort: '3100',
      httpsHost: '127.0.0.1',
      httpsPort: '3443',
      publicHostname: 'drive.example.com',
      certificateMode: 'pem',
      certificateDirectory: path.join(tempRoot, 'missing-certificate'),
      autoReloadCertificate: '1',
      reloadIntervalMinutes: '5'
    })
    .expect(400);
  assert.match(invalidTlsPage.text, /Certificate chain file cannot be read/);

  const disabledTlsCsrf = csrfFrom(invalidTlsPage.text);
  await adminAgent
    .post('/admin/tls')
    .type('form')
    .send({
      _csrf: disabledTlsCsrf,
      httpHost: '127.0.0.1',
      httpPort: '3100',
      httpsHost: '127.0.0.1',
      httpsPort: '3443',
      publicHostname: '',
      certificateMode: 'pem',
      certificateDirectory: '',
      reloadIntervalMinutes: '5'
    })
    .expect(302)
    .expect('Location', '/admin/tls');
  const savedTlsSettings = JSON.parse(
    db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'network.tls'").get().setting_value
  );
  assert.equal(savedTlsSettings.httpsEnabled, false);
  assert.equal(savedTlsSettings.httpPort, 3100);

  const adminRepositoriesPage = await adminAgent.get('/admin/repositories').expect(200);
  assert.match(adminRepositoriesPage.text, /Repository creation is intentionally unavailable to administrators/);
  assert.doesNotMatch(adminRepositoriesPage.text, /action="\/admin\/repositories"/);

  const adminCsrf = csrfFrom(adminRepositoriesPage.text);
  await adminAgent
    .post('/repositories')
    .type('form')
    .send({ _csrf: adminCsrf, name: 'Administrator Repository' })
    .expect(403);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 0);

  const users = [
    { displayName: 'Repository Owner', username: 'owner.user', password: 'OwnerPassword123!' },
    { displayName: 'Shared Viewer', username: 'shared.viewer', password: 'ViewerPassword123!' },
    { displayName: 'Unrelated User', username: 'unrelated.user', password: 'UnrelatedPassword123!' },
    { displayName: 'Delete Delegate', username: 'delete.delegate', password: 'DeletePassword123!' }
  ];
  for (const user of users) await createUser(adminAgent, user);

  const owner = db.prepare('SELECT * FROM users WHERE username = ?').get('owner.user');
  const viewer = db.prepare('SELECT * FROM users WHERE username = ?').get('shared.viewer');
  const unrelated = db.prepare('SELECT * FROM users WHERE username = ?').get('unrelated.user');
  const deleteDelegate = db.prepare('SELECT * FROM users WHERE username = ?').get('delete.delegate');
  assert.ok(owner && viewer && unrelated && deleteDelegate);

  const ownerAgent = request.agent(app);
  await login(ownerAgent, owner.username, 'OwnerPassword123!');
  const repositoryId = await createRepository(ownerAgent, 'Owner Private Repository', 'Owner-managed files');
  const repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);
  assert.equal(repository.created_by, owner.id);

  const ownerRepositoryPage = await ownerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(ownerRepositoryPage.text, /Owner access/);
  assert.match(ownerRepositoryPage.text, /data-upload-open/);
  assert.match(ownerRepositoryPage.text, /Manage permissions/);
  const uploadCsrf = csrfFrom(ownerRepositoryPage.text);
  await ownerAgent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', uploadCsrf)
    .attach('files', Buffer.from('Owner file contents'), 'owner-record.txt')
    .expect(302);

  const ownerFile = db.prepare('SELECT * FROM files WHERE repository_id = ?').get(repositoryId);
  assert.equal(ownerFile.original_name, 'owner-record.txt');
  assert.ok(fs.existsSync(path.join(config.uploadRoot, String(repositoryId), ownerFile.stored_name)));

  const unrelatedAgent = request.agent(app);
  await login(unrelatedAgent, unrelated.username, 'UnrelatedPassword123!');
  const unrelatedDashboard = await unrelatedAgent.get('/').expect(200);
  assert.doesNotMatch(unrelatedDashboard.text, /Owner Private Repository/);
  const unrelatedCsrf = csrfFrom(unrelatedDashboard.text);
  await unrelatedAgent.get(`/repositories/${repositoryId}`).expect(404);
  await unrelatedAgent.get(`/repositories/${repositoryId}/files/${ownerFile.id}/download`).expect(404);
  await unrelatedAgent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', unrelatedCsrf)
    .attach('files', Buffer.from('Denied upload'), 'denied.txt')
    .expect(404);
  await unrelatedAgent
    .post(`/repositories/${repositoryId}/files/${ownerFile.id}/delete`)
    .type('form')
    .send({ _csrf: unrelatedCsrf })
    .expect(404);
  await unrelatedAgent
    .post(`/repositories/${repositoryId}/delete`)
    .type('form')
    .send({ _csrf: unrelatedCsrf })
    .expect(404);
  assert.ok(db.prepare('SELECT 1 FROM repositories WHERE id = ?').get(repositoryId));

  await grantPermissions(ownerAgent, repositoryId, viewer.id, { view: true });
  const viewOnlyGrant = db.prepare(`
    SELECT * FROM repository_permissions WHERE repository_id = ? AND user_id = ?
  `).get(repositoryId, viewer.id);
  assert.deepEqual(
    [viewOnlyGrant.can_view, viewOnlyGrant.can_upload, viewOnlyGrant.can_download, viewOnlyGrant.can_delete],
    [1, 0, 0, 0]
  );

  const viewerAgent = request.agent(app);
  await login(viewerAgent, viewer.username, 'ViewerPassword123!');
  const viewerDashboard = await viewerAgent.get('/').expect(200);
  assert.match(viewerDashboard.text, /Owner Private Repository/);
  const viewOnlyPage = await viewerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(viewOnlyPage.text, /Shared access/);
  assert.match(viewOnlyPage.text, /View-only access/);
  assert.doesNotMatch(viewOnlyPage.text, /data-upload-open/);
  assert.doesNotMatch(viewOnlyPage.text, /data-selected-download/);
  const viewerCsrf = csrfFrom(viewOnlyPage.text);
  await viewerAgent.get(`/repositories/${repositoryId}/files/${ownerFile.id}/download`).expect(404);
  await viewerAgent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', viewerCsrf)
    .attach('files', Buffer.from('Denied'), 'denied-viewer.txt')
    .expect(404);
  await viewerAgent
    .post(`/repositories/${repositoryId}/files/${ownerFile.id}/delete`)
    .type('form')
    .send({ _csrf: viewerCsrf })
    .expect(404);

  await updatePermissions(ownerAgent, repositoryId, viewer.id, {
    view: true,
    upload: true,
    download: true
  });
  const contributorPage = await viewerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(contributorPage.text, /data-upload-open/);
  assert.match(contributorPage.text, /data-selected-download/);
  assert.doesNotMatch(contributorPage.text, /data-selected-delete/);
  const contributorCsrf = csrfFrom(contributorPage.text);
  await viewerAgent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', contributorCsrf)
    .attach('files', Buffer.from('Shared upload contents'), 'shared-upload.txt')
    .expect(302);
  await viewerAgent
    .get(`/repositories/${repositoryId}/files/${ownerFile.id}/download`)
    .expect(200)
    .expect('Content-Disposition', /owner-record\.txt/);
  await viewerAgent
    .post(`/repositories/${repositoryId}/files/${ownerFile.id}/delete`)
    .type('form')
    .send({ _csrf: contributorCsrf })
    .expect(404);

  const delegatedRepositoryId = await createRepository(ownerAgent, 'Delegated Deletion Repository');
  const delegatedOwnerPage = await ownerAgent.get(`/repositories/${delegatedRepositoryId}`).expect(200);
  await ownerAgent
    .post(`/repositories/${delegatedRepositoryId}/upload`)
    .field('_csrf', csrfFrom(delegatedOwnerPage.text))
    .attach('files', Buffer.from('Delegated file deletion contents'), 'delegated-delete.txt')
    .expect(302);
  const delegatedFile = db.prepare(`
    SELECT * FROM files WHERE repository_id = ? AND original_name = ?
  `).get(delegatedRepositoryId, 'delegated-delete.txt');
  assert.ok(delegatedFile);

  await grantPermissions(ownerAgent, delegatedRepositoryId, deleteDelegate.id, {
    view: true,
    delete: true
  });
  const deleteAgent = request.agent(app);
  await login(deleteAgent, deleteDelegate.username, 'DeletePassword123!');
  const delegatedPage = await deleteAgent.get(`/repositories/${delegatedRepositoryId}`).expect(200);
  assert.match(delegatedPage.text, /data-selected-delete/);
  assert.doesNotMatch(delegatedPage.text, /aria-label="Delete repository"/);
  const deleteCsrf = csrfFrom(delegatedPage.text);
  await deleteAgent
    .post(`/repositories/${delegatedRepositoryId}/files/${delegatedFile.id}/delete`)
    .type('form')
    .send({ _csrf: deleteCsrf })
    .expect(302)
    .expect('Location', `/repositories/${delegatedRepositoryId}`);
  assert.equal(db.prepare('SELECT 1 FROM files WHERE id = ?').get(delegatedFile.id), undefined);

  await deleteAgent
    .post(`/repositories/${delegatedRepositoryId}/delete`)
    .type('form')
    .send({ _csrf: deleteCsrf })
    .expect(404);
  assert.ok(db.prepare('SELECT 1 FROM repositories WHERE id = ?').get(delegatedRepositoryId));

  const delegatedOwnerDeletePage = await ownerAgent.get(`/repositories/${delegatedRepositoryId}`).expect(200);
  await ownerAgent
    .post(`/repositories/${delegatedRepositoryId}/delete`)
    .type('form')
    .send({ _csrf: csrfFrom(delegatedOwnerDeletePage.text) })
    .expect(302)
    .expect('Location', '/');
  assert.equal(db.prepare('SELECT 1 FROM repositories WHERE id = ?').get(delegatedRepositoryId), undefined);

  await adminAgent.get(`/repositories/${repositoryId}`).expect(200);
  await adminAgent.get(`/repositories/${repositoryId}/permissions`).expect(200);
  await adminAgent
    .get(`/repositories/${repositoryId}/files/${ownerFile.id}/download`)
    .expect(200)
    .expect('Content-Disposition', /owner-record\.txt/);

  const finalAdminPage = await adminAgent.get('/admin/repositories').expect(200);
  assert.match(finalAdminPage.text, /Repository Owner/);
  const finalAdminCsrf = csrfFrom(finalAdminPage.text);
  await adminAgent
    .post(`/repositories/${repositoryId}/delete`)
    .type('form')
    .send({ _csrf: finalAdminCsrf })
    .expect(302)
    .expect('Location', '/admin/repositories');
  assert.equal(db.prepare('SELECT 1 FROM repositories WHERE id = ?').get(repositoryId), undefined);
});
