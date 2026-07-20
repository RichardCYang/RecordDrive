import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { createApplication } from '../src/app.js';
import { fileURLToPath } from 'node:url';
import { createTranslator } from '../src/i18n.js';
import { requestWantsJson } from '../src/utils.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeRequest({ requestedWith = '', accept = 'text/html', contentType = '' } = {}) {
  return {
    get(name) {
      if (String(name).toLowerCase() === 'x-requested-with') return requestedWith;
      return '';
    },
    is(type) {
      return type === 'application/json' && contentType === 'application/json';
    },
    accepts(types) {
      if (accept.includes('application/json')) return 'json';
      return types[0];
    }
  };
}

test('async transfer requests negotiate JSON responses', () => {
  assert.equal(requestWantsJson(fakeRequest({ requestedWith: 'XMLHttpRequest' })), true);
  assert.equal(requestWantsJson(fakeRequest({ accept: 'application/json' })), true);
  assert.equal(requestWantsJson(fakeRequest()), false);
});

test('repository page exposes upload and download progress hooks', () => {
  const script = fs.readFileSync(path.join(projectRoot, 'public/js/app.js'), 'utf8');
  const view = fs.readFileSync(path.join(projectRoot, 'views/repository.ejs'), 'utf8');
  assert.match(script, /xhr\.upload\.addEventListener\('progress'/);
  assert.match(script, /setAction\(detailText, null, true\)/);
  assert.match(script, /action\.disabled = disabled/);
  assert.match(script, /response\.body\.getReader\(\)/);
  assert.match(script, /new Blob\(chunks/);
  assert.match(view, /data-transfer-progress/);
  assert.match(view, /data-download-link/);
});

test('Korean transfer progress labels are available', () => {
  const t = createTranslator('ko');
  assert.equal(t('Upload complete'), '업로드 완료');
  assert.equal(t('Downloading {{name}}', { name: '기록.pdf' }), '기록.pdf 다운로드 중');
});


function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should exist in rendered HTML');
  return match[1];
}

function transferTestConfig(tempRoot) {
  return {
    port: 0,
    nodeEnv: 'test',
    isProduction: false,
    sessionSecret: 'transfer-progress-test-secret-with-more-than-thirty-two-characters',
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
    .expect(302);
}

test('XHR upload and streamed download endpoints return progress-friendly responses', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-transfer-progress-'));
  const app = createApplication({ config: transferTestConfig(tempRoot) });
  const db = app.locals.db;
  const adminAgent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await login(adminAgent, 'admin', 'TestPassword123!');
  const usersPage = await adminAgent.get('/admin/users').expect(200);
  await adminAgent
    .post('/admin/users')
    .type('form')
    .send({
      _csrf: csrfFrom(usersPage.text),
      displayName: 'Transfer Owner',
      username: 'transfer.owner',
      password: 'TransferPassword123!'
    })
    .expect(302);

  const ownerAgent = request.agent(app);
  await login(ownerAgent, 'transfer.owner', 'TransferPassword123!');
  const dashboard = await ownerAgent.get('/').expect(200);
  const repositoryResponse = await ownerAgent
    .post('/repositories')
    .type('form')
    .send({ _csrf: csrfFrom(dashboard.text), name: 'Transfer Repository' })
    .expect(302);
  const repositoryId = Number(repositoryResponse.headers.location.split('/').at(-1));
  const repositoryPage = await ownerAgent.get(`/repositories/${repositoryId}`).expect(200);
  const contents = Buffer.from('progress-aware transfer contents');

  const uploadResponse = await ownerAgent
    .post(`/repositories/${repositoryId}/upload`)
    .set('Accept', 'application/json')
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('_csrf', csrfFrom(repositoryPage.text))
    .attach('files', contents, 'progress-record.txt')
    .expect(200)
    .expect('Content-Type', /application\/json/);
  assert.equal(uploadResponse.body.ok, true);
  assert.equal(uploadResponse.body.redirectUrl, `/repositories/${repositoryId}`);

  const storedFile = db.prepare(`
    SELECT * FROM files WHERE repository_id = ? AND original_name = ?
  `).get(repositoryId, 'progress-record.txt');
  assert.ok(storedFile);

  const downloadResponse = await ownerAgent
    .get(`/repositories/${repositoryId}/files/${storedFile.id}/download`)
    .set('Accept', 'application/octet-stream, application/json;q=0.9')
    .set('X-Requested-With', 'XMLHttpRequest')
    .buffer(true)
    .parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.equal(downloadResponse.headers['content-length'], String(contents.length));
  assert.match(downloadResponse.headers['content-disposition'], /filename\*=UTF-8''progress-record\.txt/);
  assert.deepEqual(downloadResponse.body, contents);

  const missingResponse = await ownerAgent
    .get(`/repositories/${repositoryId}/files/missing/download`)
    .set('Accept', 'application/json')
    .set('X-Requested-With', 'XMLHttpRequest')
    .expect(404)
    .expect('Content-Type', /application\/json/);
  assert.match(missingResponse.body.error, /does not exist/i);
});
