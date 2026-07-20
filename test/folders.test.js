import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    sessionSecret: 'folder-test-session-secret-with-more-than-thirty-two-characters',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    maxFileSizeMb: 5,
    maxFilesPerUpload: 3,
    maxFoldersPerRepository: 100,
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

async function createUser(adminAgent, user) {
  const page = await adminAgent.get('/admin/users').expect(200);
  await adminAgent
    .post('/admin/users')
    .type('form')
    .send({
      _csrf: csrfFrom(page.text),
      displayName: user.displayName,
      username: user.username,
      password: user.password
    })
    .expect(302)
    .expect('Location', '/admin/users');
}

async function createRepository(agent, name) {
  const page = await agent.get('/').expect(200);
  const response = await agent
    .post('/repositories')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), name, description: 'Folder feature test' })
    .expect(302);
  return Number(response.headers.location.split('/').at(-1));
}

async function createFolder(agent, repositoryId, { name, parentId = '' }, expectedLocation) {
  const location = parentId
    ? `/repositories/${repositoryId}?folder=${encodeURIComponent(parentId)}`
    : `/repositories/${repositoryId}`;
  const page = await agent.get(location).expect(200);
  return agent
    .post(`/repositories/${repositoryId}/folders`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), parentId, name })
    .expect(302)
    .expect('Location', expectedLocation ?? location);
}

test('creates, browses, uploads into, and recursively deletes repository folders', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-folders-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const adminAgent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await login(adminAgent, 'admin', 'TestPassword123!');
  await createUser(adminAgent, {
    displayName: 'Folder Owner',
    username: 'folder.owner',
    password: 'FolderPassword123!'
  });

  const ownerAgent = request.agent(app);
  await login(ownerAgent, 'folder.owner', 'FolderPassword123!');
  const repositoryId = await createRepository(ownerAgent, 'Folder Repository');

  const rootPage = await ownerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(rootPage.text, /data-folder-open/);
  assert.match(rootPage.text, /data-folder-drawer/);
  assert.match(rootPage.text, /name="folderId" value=""/);

  await createFolder(ownerAgent, repositoryId, { name: 'Projects' });
  const projects = db.prepare(`
    SELECT * FROM folders WHERE repository_id = ? AND parent_id IS NULL
  `).get(repositoryId);
  assert.ok(projects);
  assert.equal(projects.name, 'Projects');

  await createFolder(ownerAgent, repositoryId, { name: 'projects' });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM folders WHERE repository_id = ?').get(repositoryId).count,
    1,
    'folder names should be unique within the same parent, ignoring case'
  );
  const duplicatePage = await ownerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(duplicatePage.text, /A folder with that name already exists here/);

  await createFolder(ownerAgent, repositoryId, { name: '../invalid' });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM folders WHERE repository_id = ?').get(repositoryId).count,
    1,
    'invalid folder names should not be inserted'
  );

  await createFolder(
    ownerAgent,
    repositoryId,
    { name: '2026', parentId: projects.id },
    `/repositories/${repositoryId}?folder=${encodeURIComponent(projects.id)}`
  );
  const child = db.prepare('SELECT * FROM folders WHERE parent_id = ?').get(projects.id);
  assert.ok(child);
  assert.equal(child.name, '2026');

  const rootListing = await ownerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(rootListing.text, />Projects</);
  assert.doesNotMatch(rootListing.text, />2026</);

  const projectsPage = await ownerAgent
    .get(`/repositories/${repositoryId}?folder=${encodeURIComponent(projects.id)}`)
    .expect(200);
  assert.match(projectsPage.text, />Projects</);
  assert.match(projectsPage.text, />2026</);
  assert.match(projectsPage.text, new RegExp(`name=\"folderId\" value=\"${projects.id}\"`));

  const childPage = await ownerAgent
    .get(`/repositories/${repositoryId}?folder=${encodeURIComponent(child.id)}`)
    .expect(200);
  assert.match(childPage.text, />Projects</);
  assert.match(childPage.text, />2026</);
  assert.match(childPage.text, new RegExp(`name="folderId" value="${child.id}"`));

  const uploadResponse = await ownerAgent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', csrfFrom(childPage.text))
    .field('folderId', child.id)
    .attach('files', Buffer.from('Nested folder contents'), 'nested-record.txt')
    .expect(302)
    .expect('Location', `/repositories/${repositoryId}?folder=${encodeURIComponent(child.id)}`);
  assert.ok(uploadResponse);

  const storedFile = db.prepare(`
    SELECT * FROM files WHERE repository_id = ? AND original_name = ?
  `).get(repositoryId, 'nested-record.txt');
  assert.ok(storedFile);
  assert.equal(storedFile.folder_id, child.id);
  const storedPath = path.join(config.uploadRoot, String(repositoryId), storedFile.stored_name);
  assert.ok(fs.existsSync(storedPath));

  const refreshedChildPage = await ownerAgent
    .get(`/repositories/${repositoryId}?folder=${encodeURIComponent(child.id)}`)
    .expect(200);
  assert.match(refreshedChildPage.text, /nested-record\.txt/);
  const refreshedRootPage = await ownerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.doesNotMatch(refreshedRootPage.text, /nested-record\.txt/);

  await ownerAgent
    .get(`/repositories/${repositoryId}?folder=missing-folder`)
    .expect(404);

  const deleteCsrf = csrfFrom(refreshedRootPage.text);
  await ownerAgent
    .post(`/repositories/${repositoryId}/folders/${encodeURIComponent(projects.id)}/delete`)
    .type('form')
    .send({ _csrf: deleteCsrf })
    .expect(302)
    .expect('Location', `/repositories/${repositoryId}`);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM folders WHERE repository_id = ?').get(repositoryId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM files WHERE repository_id = ?').get(repositoryId).count, 0);
  assert.equal(fs.existsSync(storedPath), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE action = 'CREATE_FOLDER'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE action = 'DELETE_FOLDER'").get().count, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('upgrades an existing flat files table without losing root files', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-folder-migration-'));
  const config = testConfig(tempRoot);
  fs.mkdirSync(config.uploadRoot, { recursive: true });

  const legacy = new DatabaseSync(config.dbPath, { enableForeignKeyConstraints: true });
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      uploaded_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (id, username, display_name, password_hash, role)
    VALUES (1, 'legacy.user', 'Legacy User', 'not-used', 'USER');
    INSERT INTO repositories (id, name, description, created_by)
    VALUES (1, 'Legacy Repository', '', 1);
    INSERT INTO files (id, repository_id, original_name, stored_name, mime_type, size, uploaded_by)
    VALUES ('legacy-file', 1, 'legacy.txt', 'legacy-stored-name', 'text/plain', 7, 1);
  `);
  legacy.close();

  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const fileColumns = new Set(db.prepare('PRAGMA table_info(files)').all().map((column) => column.name));
  assert.ok(fileColumns.has('folder_id'));
  assert.ok(fileColumns.has('initial_access_time_ms'));
  const legacyFile = db.prepare('SELECT * FROM files WHERE id = ?').get('legacy-file');
  assert.ok(legacyFile);
  assert.equal(legacyFile.folder_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM folders').get().count, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
