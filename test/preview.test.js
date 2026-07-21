import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { createApplication } from '../src/app.js';

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should exist in rendered HTML');
  return match[1];
}

function testConfig(tempRoot, overrides = {}) {
  return {
    port: 0,
    nodeEnv: 'test',
    isProduction: false,
    sessionSecret: 'preview-test-session-secret-with-more-than-thirty-two-characters',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    maxFileSizeMb: 30,
    maxFilesPerUpload: 6,
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads'),
    ...overrides
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
    .send({ _csrf: csrfFrom(page.text), name, description: 'Preview integration tests' })
    .expect(302);
  return Number(response.headers.location.split('/').at(-1));
}

async function grantViewPermission(ownerAgent, repositoryId, username) {
  const page = await ownerAgent.get(`/repositories/${repositoryId}/permissions`).expect(200);
  await ownerAgent
    .post(`/repositories/${repositoryId}/permissions`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), username, canView: '1' })
    .expect(302)
    .expect('Location', `/repositories/${repositoryId}/permissions`);
}

async function spreadsheetBuffer() {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet('Summary');
  summary.getColumn(1).width = 18;
  summary.getColumn(2).width = 14;
  summary.getCell('A1').value = 'Name';
  summary.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summary.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  summary.getCell('B1').value = 'Value';
  summary.getCell('A2').value = 'Alpha';
  summary.getCell('B2').value = 42;
  summary.mergeCells('A4:B4');
  summary.getCell('A4').value = 'Merged heading';
  const details = workbook.addWorksheet('Details');
  details.getCell('A1').value = 'Second sheet';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}


const minimalPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
  'trailer\n<< /Root 1 0 R >>\n%%EOF\n'
);

test('previews PDF, XLSX, ZIP, and 7z files in the repository details pane', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-preview-test-'));
  const config = testConfig(tempRoot, {
    sevenZipPreviewEnabled: true,
    sevenZipPreviewTimeoutMs: 5000
  });
  const app = createApplication({ config });
  const db = app.recorddrive.db;

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const adminAgent = request.agent(app);
  await login(adminAgent, 'admin', 'TestPassword123!');
  await createUser(adminAgent, 'Preview Owner', 'preview.owner', 'OwnerPassword123!');
  await createUser(adminAgent, 'View Only User', 'preview.viewer', 'ViewerPassword123!');
  await createUser(adminAgent, 'Hidden Collaborator', 'preview.hidden', 'HiddenPassword123!');

  const owner = db.prepare('SELECT * FROM users WHERE username = ?').get('preview.owner');
  const viewer = db.prepare('SELECT * FROM users WHERE username = ?').get('preview.viewer');
  const hiddenCollaborator = db.prepare('SELECT * FROM users WHERE username = ?').get('preview.hidden');
  const ownerAgent = request.agent(app);
  await login(ownerAgent, owner.username, 'OwnerPassword123!');
  const repositoryId = await createRepository(ownerAgent, 'Preview Repository');

  const repositoryPage = await ownerAgent.get(`/repositories/${repositoryId}`).expect(200);
  await ownerAgent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', csrfFrom(repositoryPage.text))
    .attach('files', minimalPdf, 'document.pdf')
    .attach('files', await spreadsheetBuffer(), 'workbook.xlsx')
    .attach('files', fs.readFileSync(new URL('./fixtures/sample.zip', import.meta.url)), 'archive.zip')
    .attach('files', fs.readFileSync(new URL('./fixtures/encrypted.zip', import.meta.url)), 'protected.zip')
    .attach('files', fs.readFileSync(new URL('./fixtures/sample.7z', import.meta.url)), 'archive.7z')
    .expect(302)
    .expect('Location', `/repositories/${repositoryId}`);

  const files = db.prepare('SELECT * FROM files WHERE repository_id = ? ORDER BY id').all(repositoryId);
  assert.equal(files.length, 5);
  const byName = Object.fromEntries(files.map((file) => [file.original_name, file]));

  const populatedPage = await ownerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(populatedPage.text, /data-details-tab="preview"/);
  assert.match(populatedPage.text, /data-details-panel="preview"/);
  assert.match(populatedPage.text, /data-preview-kind="pdf"/);
  assert.match(populatedPage.text, /data-preview-kind="xlsx"/);
  assert.match(populatedPage.text, /data-preview-kind="zip"/);
  assert.match(populatedPage.text, /data-preview-kind="7z"/);

  const pdfResponse = await ownerAgent
    .get(`/repositories/${repositoryId}/files/${byName['document.pdf'].id}/preview`)
    .expect(200)
    .expect('Content-Type', /application\/pdf/);
  assert.match(pdfResponse.headers['content-disposition'], /^inline;/);
  assert.match(pdfResponse.headers['content-security-policy'], /(?:^|;)\s*sandbox(?:;|$)/);
  assert.match(pdfResponse.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(pdfResponse.headers['referrer-policy'], 'no-referrer');
  assert.equal(pdfResponse.headers['cross-origin-resource-policy'], 'same-origin');
  assert.ok(pdfResponse.body.length > 0);
  const browserScript = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(browserScript, /frame\.setAttribute\('sandbox', ''\)/);
  assert.match(browserScript, /frame\.referrerPolicy = 'no-referrer'/);

  const workbookResponse = await ownerAgent
    .get(`/repositories/${repositoryId}/files/${byName['workbook.xlsx'].id}/preview`)
    .expect(200)
    .expect('Content-Type', /application\/json/);
  assert.equal(workbookResponse.body.kind, 'xlsx');
  assert.deepEqual(workbookResponse.body.sheets.map((sheet) => sheet.name), ['Summary', 'Details']);
  assert.equal(workbookResponse.body.sheet.rows[0][0].value, 'Name');
  assert.equal(workbookResponse.body.sheet.rows[1][1].value, '42');
  assert.equal(workbookResponse.body.sheet.rows[0][0].style.bold, true);
  assert.deepEqual(workbookResponse.body.sheet.merges[0], {
    startRow: 4,
    startColumn: 1,
    endRow: 4,
    endColumn: 2
  });

  const secondSheetResponse = await ownerAgent
    .get(`/repositories/${repositoryId}/files/${byName['workbook.xlsx'].id}/preview?sheet=1`)
    .expect(200);
  assert.equal(secondSheetResponse.body.sheet.name, 'Details');
  assert.equal(secondSheetResponse.body.sheet.rows[0][0].value, 'Second sheet');

  const archiveResponse = await ownerAgent
    .get(`/repositories/${repositoryId}/files/${byName['archive.zip'].id}/preview`)
    .expect(200);
  assert.equal(archiveResponse.body.kind, 'zip');
  assert.equal(archiveResponse.body.encrypted, false);
  assert.ok(archiveResponse.body.entries.some((entry) => entry.name === 'folder/nested.txt'));
  assert.ok(archiveResponse.body.entries.some((entry) => entry.name === 'root.txt'));

  const protectedResponse = await ownerAgent
    .get(`/repositories/${repositoryId}/files/${byName['protected.zip'].id}/preview`)
    .expect(200);
  assert.equal(protectedResponse.body.kind, 'zip');
  assert.equal(protectedResponse.body.encrypted, true);
  assert.deepEqual(protectedResponse.body.entries, []);

  const sevenZipResponse = await ownerAgent
    .get(`/repositories/${repositoryId}/files/${byName['archive.7z'].id}/preview`)
    .expect(200);
  assert.equal(sevenZipResponse.body.kind, '7z');
  assert.equal(sevenZipResponse.body.metadataOnly, true);
  assert.equal(sevenZipResponse.body.encrypted, false);
  assert.equal(sevenZipResponse.body.parserEngine, 'javascript');
  assert.equal(sevenZipResponse.body.totalEntries, 4);
  assert.ok(sevenZipResponse.body.entries.some((entry) => entry.name === 'folder/nested.txt'));
  assert.ok(sevenZipResponse.body.entries.some((entry) => entry.name === 'root.txt'));

  await grantViewPermission(ownerAgent, repositoryId, viewer.username);
  await grantViewPermission(ownerAgent, repositoryId, hiddenCollaborator.username);
  const viewerAgent = request.agent(app);
  await login(viewerAgent, viewer.username, 'ViewerPassword123!');
  const viewerPage = await viewerAgent.get(`/repositories/${repositoryId}`).expect(200);
  assert.match(viewerPage.text, /data-preview-kind="pdf"/);
  assert.match(viewerPage.text, /data-preview-url=""/);
  assert.match(viewerPage.text, />2 shared users</);
  assert.doesNotMatch(viewerPage.text, /@preview\.hidden/);
  await viewerAgent
    .get(`/repositories/${repositoryId}/files/${byName['document.pdf'].id}/preview`)
    .expect(404);
});
