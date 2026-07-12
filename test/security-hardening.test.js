import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { ensureSecureRepositoryDirectory, resolveStoredFilePath } from '../src/file-access-time.js';
import { createXlsxPreview, createZipPreview, FilePreviewError } from '../src/file-preview.js';
import { resetAuthenticationRateLimits } from '../src/middleware/login-rate-limit.js';
import {
  decryptRecoveryCodeBundle,
  encryptRecoveryCodeBundle,
  encryptTotpSecret
} from '../src/security-service.js';
import { loadTlsSettings, saveTlsSettings } from '../src/tls-settings.js';
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

test('treats non-development environments as production and validates secret strength', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'staging',
    SESSION_SECRET: 'short',
    ADMIN_ACCESS_DISABLED: 'true'
  }), /32 UTF-8 bytes/);

  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'production-session-secret-with-more-than-thirty-two-characters',
    ADMIN_ACCESS_DISABLED: 'false',
    ADMIN_PASSWORD: 'ShortPass1!'
  }), /12 to 128 characters/);

  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'production-session-secret-with-more-than-thirty-two-characters',
    ADMIN_ACCESS_DISABLED: 'true',
    MFA_ENCRYPTION_KEY: 'short-key'
  }), /32 UTF-8 bytes/);
});

test('rejects symbolic-link database and repository paths', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-symlink-root-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const databaseTarget = path.join(tempRoot, 'database-target');
  fs.writeFileSync(databaseTarget, 'not-a-database');
  const databaseLink = path.join(tempRoot, 'database-link');
  try {
    fs.symlinkSync(databaseTarget, databaseLink);
    assert.throws(() => createDatabase({
      ...testConfig(tempRoot),
      dbPath: databaseLink,
      uploadRoot: path.join(tempRoot, 'uploads-for-database-test')
    }), /cannot be a symbolic link/);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
  }

  const config = testConfig(path.join(tempRoot, 'repository-test'));
  fs.mkdirSync(config.uploadRoot, { recursive: true });
  const outside = path.join(tempRoot, 'outside-directory');
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, path.join(config.uploadRoot, '1'), 'dir');
    assert.throws(() => ensureSecureRepositoryDirectory(config, 1), /cannot be a symbolic link/);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
  }
});

test('encrypts saved TLS passphrases and temporary recovery-code bundles', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-protected-secrets-'));
  const config = testConfig(tempRoot);
  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  saveTlsSettings(db, { passphrase: 'HighlySensitiveTlsPassphrase!' }, config);
  const stored = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'network.tls'").get().setting_value;
  assert.doesNotMatch(stored, /HighlySensitiveTlsPassphrase/);
  assert.equal(JSON.parse(stored).passphrase, undefined);
  assert.equal(loadTlsSettings(db, config).passphrase, 'HighlySensitiveTlsPassphrase!');

  const codes = ['ABCD-EFGH-IJKL', 'MNOP-QRST-UVWX'];
  const protectedBundle = encryptRecoveryCodeBundle(codes, config);
  assert.doesNotMatch(protectedBundle, /ABCD|MNOP/);
  assert.deepEqual(decryptRecoveryCodeBundle(protectedBundle, config), codes);
});

test('caps spreadsheet preview text output', async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Large text');
  for (let row = 1; row <= 30; row += 1) {
    for (let column = 1; column <= 20; column += 1) {
      worksheet.getCell(row, column).value = `${row}-${column}-${'x'.repeat(2200)}`;
    }
  }
  const source = Buffer.from(await workbook.xlsx.writeBuffer());
  const preview = await createXlsxPreview(source, { size: source.length });
  const values = preview.sheet.rows.flat().map((cell) => cell.value);
  const totalBytes = values.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);

  assert.equal(preview.sheet.truncatedContent, true);
  assert.ok(totalBytes <= 1024 * 1024);
  assert.ok(values.every((value) => Buffer.byteLength(value, 'utf8') <= 4096));
});

test('rejects nested upload fields and cleans files that exceed storage quotas', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-upload-limits-'));
  const config = {
    ...testConfig(tempRoot),
    maxRepositoryStorageMb: 0.0001,
    maxTotalStorageMb: 0.0002
  };
  const app = createApplication({ config });
  const db = app.locals.db;
  const passwordHash = bcrypt.hashSync('OwnerPassword123!', 12);
  const userId = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'USER')
  `).run('quota.owner', 'Quota Owner', passwordHash).lastInsertRowid);
  const repositoryId = Number(db.prepare(`
    INSERT INTO repositories (name, description, created_by)
    VALUES (?, '', ?)
  `).run('Quota Repository', userId).lastInsertRowid);
  const agent = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const loginPage = await agent.get('/login').expect(200);
  await agent.post('/login').type('form').send({
    _csrf: csrfFrom(loginPage.text),
    username: 'quota.owner',
    password: 'OwnerPassword123!'
  }).expect(302);

  await agent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf[nested]', 'invalid')
    .attach('files', Buffer.from('nested field payload'), 'nested.txt')
    .expect(400);

  const repositoryPage = await agent.get(`/repositories/${repositoryId}`).expect(200);
  await agent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', csrfFrom(repositoryPage.text))
    .attach('files', Buffer.alloc(512, 0x61), 'over-quota.txt')
    .expect(413);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM files WHERE repository_id = ?').get(repositoryId).count, 0);
  const repositoryRoot = path.join(config.uploadRoot, String(repositoryId));
  assert.deepEqual(fs.existsSync(repositoryRoot) ? fs.readdirSync(repositoryRoot) : [], []);
});
