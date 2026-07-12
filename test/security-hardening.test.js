import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import JSZip from 'jszip';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { resolveStoredFilePath } from '../src/file-access-time.js';
import { createXlsxPreview, createZipPreview, FilePreviewError } from '../src/file-preview.js';
import { resetAuthenticationRateLimits } from '../src/middleware/login-rate-limit.js';
import { encryptTotpSecret } from '../src/security-service.js';
import { safeInternalPath } from '../src/utils.js';

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
    sessionSecret: 'hardening-test-session-secret-with-more-than-thirty-two-characters',
    mfaEncryptionKey: 'hardening-test-mfa-key-with-more-than-thirty-two-characters',
    mfaIssuer: 'RecordDrive Hardening Test',
    webAuthnRpName: 'RecordDrive Hardening Test',
    webAuthnRpId: 'localhost',
    webAuthnOrigin: 'http://localhost',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    maxFileSizeMb: 5,
    maxFilesPerUpload: 3,
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads')
  };
}

async function passwordLogin(agent, expectedLocation = '/') {
  const page = await agent.get('/login').expect(200);
  return agent
    .post('/login')
    .type('form')
    .send({
      _csrf: csrfFrom(page.text),
      username: 'admin',
      password: 'TestPassword123!'
    })
    .expect(302)
    .expect('Location', expectedLocation);
}

test('rejects multipart CSRF bypasses outside the upload route', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-csrf-hardening-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const agent = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await passwordLogin(agent);
  await agent
    .post('/logout')
    .field('_csrf', 'attacker-controlled-token')
    .expect(403);
  await agent.get('/settings').expect(200);
});

test('preserves MFA failure limits across newly created sessions', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-mfa-hardening-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  db.prepare(`
    UPDATE users
    SET totp_enabled = 1, totp_secret_encrypted = ?, totp_last_used_step = NULL
    WHERE id = ?
  `).run(encryptTotpSecret(secret, config), admin.id);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const agent = request.agent(app);
    await passwordLogin(agent, '/login/mfa');
    const page = await agent.get('/login/mfa').expect(200);
    await agent
      .post('/login/mfa/totp')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), token: '000000' })
      .expect(401);
  }

  const blockedAgent = request.agent(app);
  await passwordLogin(blockedAgent, '/login/mfa');
  const blockedPage = await blockedAgent.get('/login/mfa').expect(200);
  const response = await blockedAgent
    .post('/login/mfa/totp')
    .type('form')
    .send({ _csrf: csrfFrom(blockedPage.text), token: '000000' })
    .expect(429);
  assert.ok(Number(response.headers['retry-after']) > 0);
});

test('sanitizes internal redirects and parses proxy trust explicitly', () => {
  assert.equal(safeInternalPath('/repositories/1?sort=name-asc'), '/repositories/1?sort=name-asc');
  assert.equal(safeInternalPath('//attacker.example/path'), '/');
  assert.equal(safeInternalPath('/\\attacker.example/path'), '/');
  assert.equal(safeInternalPath('https://attacker.example/path'), '/');

  const disabled = loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'production-session-secret-with-more-than-thirty-two-characters',
    ADMIN_ACCESS_DISABLED: 'true',
    TRUST_PROXY: 'false'
  });
  assert.equal(disabled.trustProxy, false);

  const trusted = loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'production-session-secret-with-more-than-thirty-two-characters',
    ADMIN_ACCESS_DISABLED: 'true',
    TRUST_PROXY: 'loopback, 10.0.0.0/8'
  });
  assert.deepEqual(trusted.trustProxy, ['loopback', '10.0.0.0/8']);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'production-session-secret-with-more-than-thirty-two-characters',
    ADMIN_ACCESS_DISABLED: 'true',
    TRUST_PROXY: 'true'
  }), /cannot trust every source/);

  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'production-session-secret-with-more-than-thirty-two-characters',
    ADMIN_ACCESS_DISABLED: 'false',
    ADMIN_PASSWORD: '😀'.repeat(20)
  }), /72-byte input limit/);
});

test('rejects traversal and symbolic links in stored file paths', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-path-hardening-'));
  const config = testConfig(tempRoot);
  const repositoryRoot = path.join(config.uploadRoot, '1');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, 'safe-file'), 'safe');

  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  assert.equal(
    resolveStoredFilePath(config, 1, 'safe-file'),
    path.join(repositoryRoot, 'safe-file')
  );
  assert.throws(() => resolveStoredFilePath(config, 1, '../outside'));
  assert.throws(() => resolveStoredFilePath(config, 1, '..\\outside'));
  assert.throws(() => resolveStoredFilePath(config, 1, 'folder/file'));

  const outside = path.join(tempRoot, 'outside-file');
  fs.writeFileSync(outside, 'outside');
  const symlink = path.join(repositoryRoot, 'linked-file');
  try {
    fs.symlinkSync(outside, symlink);
    assert.throws(() => resolveStoredFilePath(config, 1, 'linked-file'));
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
  }
});

test('applies owner-only database and upload permissions on POSIX systems', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-permission-hardening-'));
  const config = testConfig(tempRoot);
  const db = createDatabase(config);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(config.dbPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(config.uploadRoot).mode & 0o777, 0o700);
  }
});

test('rejects oversized archive metadata before preview parsing', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-preview-hardening-'));
  const filePath = path.join(tempRoot, 'oversized-metadata.zip');
  const archive = new JSZip();
  archive.file(`${'a'.repeat(1100)}.txt`, 'content');
  fs.writeFileSync(filePath, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const stats = fs.statSync(filePath);

  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    createZipPreview(filePath),
    (error) => error instanceof FilePreviewError && error.code === 'ZIP_TOO_LARGE'
  );
  await assert.rejects(
    createXlsxPreview(filePath, stats),
    (error) => error instanceof FilePreviewError && error.code === 'XLSX_TOO_LARGE'
  );
});
