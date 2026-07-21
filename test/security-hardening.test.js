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
import { sessionStorageKey } from '../src/session-store.js';

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
    maxRepositoryFiles: 100,
    maxTotalFiles: 1000,
    maxSessionsPerUser: 10,
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

test('does not persist anonymous sessions and preserves safe post-login redirects', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-anonymous-session-hardening-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.recorddrive.db;

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const loginPage = await request(app).get('/login').expect(200);
    assert.ok(loginPage.headers['set-cookie'].some((value) => value.startsWith('recorddrive.csrf=')));
    assert.equal(loginPage.headers['set-cookie'].some((value) => value.startsWith('recorddrive.sid=')), false);
    await request(app).get('/health').expect(200);
    await request(app).get('/missing-page').expect(404);
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);

  const agent = request.agent(app);
  const protectedResponse = await agent
    .get('/repositories/123?sort=name-asc')
    .expect(302)
    .expect('Location', '/login?returnTo=%2Frepositories%2F123%3Fsort%3Dname-asc');
  const loginPage = await agent.get(protectedResponse.headers.location).expect(200);
  assert.match(loginPage.text, /name="returnTo" value="\/repositories\/123\?sort=name-asc"/);

  await agent
    .post('/login')
    .type('form')
    .send({
      _csrf: csrfFrom(loginPage.text),
      returnTo: '/repositories/123?sort=name-asc',
      username: 'admin',
      password: 'TestPassword123!'
    })
    .expect(302)
    .expect('Location', '/repositories/123?sort=name-asc');

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
});

test('stores a keyed session identifier instead of the reusable browser session ID', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-session-storage-key-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  const agent = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const response = await passwordLogin(agent);
  const sessionCookie = response.headers['set-cookie']
    .find((value) => value.startsWith('recorddrive.sid='));
  assert.ok(sessionCookie);
  const encodedValue = sessionCookie.split(';', 1)[0].split('=', 2)[1];
  const signedValue = decodeURIComponent(encodedValue);
  assert.match(signedValue, /^s:/);
  const browserSessionId = signedValue.slice(2).split('.', 1)[0];
  const storedSession = db.prepare('SELECT sid FROM sessions').get();

  assert.notEqual(storedSession.sid, browserSessionId);
  assert.equal(storedSession.sid, sessionStorageKey(browserSessionId, config.sessionSecret));
  assert.match(storedSession.sid, /^[a-f0-9]{64}$/);
  await agent.get('/').expect(200);
});

test('rotates the session after password reauthentication and revokes other sessions after MFA changes', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-security-session-rotation-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  const primaryAgent = request.agent(app);
  const secondaryAgent = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await passwordLogin(primaryAgent);
  await passwordLogin(secondaryAgent);
  const administrator = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  const userSessionIds = () => db.prepare('SELECT sid, sess FROM sessions').all()
    .filter(({ sess }) => Number(JSON.parse(sess).userId) === Number(administrator.id))
    .map(({ sid }) => sid)
    .sort();

  const beforeReauthentication = userSessionIds();
  assert.equal(beforeReauthentication.length, 2);
  const settings = await primaryAgent.get('/settings').expect(200);
  await primaryAgent
    .post('/settings/security/verify-password')
    .type('form')
    .send({ _csrf: csrfFrom(settings.text), password: 'TestPassword123!' })
    .expect(302)
    .expect('Location', '/settings#security');

  const afterReauthentication = userSessionIds();
  assert.equal(afterReauthentication.length, 2);
  assert.equal(beforeReauthentication.filter((sid) => afterReauthentication.includes(sid)).length, 1);
  await primaryAgent.get('/settings').expect(200);

  let refreshedSettings = await primaryAgent.get('/settings').expect(200);
  await primaryAgent
    .post('/settings/security/totp/start')
    .type('form')
    .send({ _csrf: csrfFrom(refreshedSettings.text) })
    .expect(302)
    .expect('Location', '/settings#totp');
  refreshedSettings = await primaryAgent.get('/settings').expect(200);
  const secretMatch = refreshedSettings.text.match(/data-totp-secret>([^<]+)</);
  assert.ok(secretMatch);
  const { generate } = await import('otplib');
  await primaryAgent
    .post('/settings/security/totp/confirm')
    .type('form')
    .send({ _csrf: csrfFrom(refreshedSettings.text), token: await generate({ secret: secretMatch[1].trim() }) })
    .expect(302)
    .expect('Location', '/settings#security');

  assert.equal(userSessionIds().length, 1);
  await primaryAgent.get('/settings').expect(200);
  await secondaryAgent.get('/settings').expect(302).expect('Location', '/login?returnTo=%2Fsettings');
});

test('limits active authentication sessions per user', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-session-limit-hardening-'));
  const config = { ...testConfig(tempRoot), maxSessionsPerUser: 2 };
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  const agents = [];

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  for (let index = 0; index < 4; index += 1) {
    const agent = request.agent(app);
    agents.push(agent);
    await passwordLogin(agent);
  }

  const administrator = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  const activeAdministratorSessions = db.prepare('SELECT sess FROM sessions').all()
    .map(({ sess }) => JSON.parse(sess))
    .filter((storedSession) => Number(storedSession.userId) === Number(administrator.id));
  assert.equal(activeAdministratorSessions.length, 2);

  await agents[0].get('/').expect(302).expect('Location', '/login?returnTo=%2F');
  await agents.at(-1).get('/').expect(200);
});

test('limits failed authentication flows that originated from pending MFA sessions', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-mfa-session-limit-hardening-'));
  const config = { ...testConfig(tempRoot), maxSessionsPerUser: 2 };
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const administrator = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  db.prepare(`
    UPDATE users
    SET totp_enabled = 1, totp_secret_encrypted = ?, totp_last_used_step = NULL
    WHERE id = ?
  `).run(encryptTotpSecret(secret, config), administrator.id);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  for (let index = 0; index < 4; index += 1) {
    const agent = request.agent(app);
    await passwordLogin(agent, '/login/mfa');
    const mfaPage = await agent.get('/login/mfa').expect(200);
    await agent
      .post('/login')
      .type('form')
      .send({
        _csrf: csrfFrom(mfaPage.text),
        username: 'admin',
        password: 'IncorrectPassword123!'
      })
      .expect(401);
  }

  const referencedSessions = db.prepare('SELECT sess FROM sessions').all()
    .map(({ sess }) => JSON.parse(sess))
    .filter((storedSession) => {
      return Number(storedSession.authenticationFlow?.userId) === Number(administrator.id);
    });
  assert.equal(referencedSessions.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
});

test('rejects multipart CSRF bypasses outside the upload route', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-csrf-hardening-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.recorddrive.db;
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
  const db = app.recorddrive.db;
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

  const resourceLimits = loadConfig({
    NODE_ENV: 'test',
    MAX_REPOSITORY_FILES: '17',
    MAX_TOTAL_FILES: '53',
    MAX_SESSIONS_PER_USER: '3'
  });
  assert.equal(resourceLimits.maxRepositoryFiles, 17);
  assert.equal(resourceLimits.maxTotalFiles, 53);
  assert.equal(resourceLimits.maxSessionsPerUser, 3);
  assert.equal(resourceLimits.sevenZipPreviewEnabled, true);
  assert.equal(loadConfig({ NODE_ENV: 'test', SEVEN_ZIP_PREVIEW_ENABLED: 'false' }).sevenZipPreviewEnabled, false);
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

test('defaults development listeners to loopback and fails closed for external HTTP exposure', async (t) => {
  const defaults = loadConfig({ NODE_ENV: 'test' });
  assert.equal(defaults.httpHost, '127.0.0.1');
  assert.equal(defaults.httpsHost, '127.0.0.1');

  const weakTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-weak-external-listener-'));
  t.after(() => fs.rmSync(weakTempRoot, { recursive: true, force: true }));
  assert.throws(() => createApplication({
    config: {
      ...testConfig(weakTempRoot),
      httpHost: '0.0.0.0',
      sessionSecret: 'recorddrive-change-this-session-secret-at-least-32-chars',
      adminPassword: 'ChangeMe123!'
    }
  }), /non-loopback listener requires a unique SESSION_SECRET/);
  assert.equal(fs.existsSync(path.join(weakTempRoot, 'recorddrive.db')), false);

  const strongTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-strong-external-listener-'));
  const config = {
    ...testConfig(strongTempRoot),
    httpHost: '0.0.0.0',
    trustProxy: 1
  };
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  t.after(() => {
    db.close();
    fs.rmSync(strongTempRoot, { recursive: true, force: true });
  });

  assert.equal(config.externallyReachable, true);
  assert.equal(config.requireHttps, true);
  assert.equal(config.exposeDetailedErrors, false);
  const plainLogin = await request(app).get('/login').expect(426);
  assert.equal(plainLogin.text, 'HTTPS is required for this listener.');
  assert.equal(plainLogin.headers['set-cookie'], undefined);
  await request(app)
    .get('/login')
    .set('X-Forwarded-Proto', 'https')
    .expect(200);
});

test('keeps confidential runtime objects out of template locals', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-template-local-secrets-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(app.locals.db, undefined);
  assert.equal(app.locals.config, undefined);
  assert.equal(app.locals.runtimeControl, undefined);
  assert.equal(app.locals.networkSettings, undefined);
  assert.equal(app.recorddrive.db, db);
  assert.equal(app.recorddrive.config.sessionSecret, config.sessionSecret);
  assert.equal(config.exposeDetailedErrors, true);
  assert.equal(app.locals.administratorAccessDisabled, false);
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

test('rejects nested upload fields and cleans files that exceed storage or file-count quotas', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-upload-limits-'));
  const config = {
    ...testConfig(tempRoot),
    maxRepositoryStorageMb: 5,
    maxTotalStorageMb: 10,
    maxRepositoryFiles: 1,
    maxTotalFiles: 2
  };
  const app = createApplication({ config });
  const db = app.recorddrive.db;
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
    .attach('files', Buffer.from('a'), 'first.txt')
    .expect(302);

  const countLimitedPage = await agent.get(`/repositories/${repositoryId}`).expect(200);
  await agent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', csrfFrom(countLimitedPage.text))
    .attach('files', Buffer.from('b'), 'count-limited.txt')
    .expect(413);

  config.maxRepositoryFiles = 10;
  config.maxTotalFiles = 10;
  config.maxRepositoryStorageMb = 0.0001;
  config.maxTotalStorageMb = 0.0002;
  const storageLimitedPage = await agent.get(`/repositories/${repositoryId}`).expect(200);
  await agent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', csrfFrom(storageLimitedPage.text))
    .attach('files', Buffer.alloc(512, 0x61), 'storage-limited.txt')
    .expect(413);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM files WHERE repository_id = ?').get(repositoryId).count, 1);
  const repositoryRoot = path.join(config.uploadRoot, String(repositoryId));
  assert.equal(fs.readdirSync(repositoryRoot).length, 1);
});

test('fails closed when stored TLS settings cannot be parsed or decrypted', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-tls-fail-closed-'));
  const config = testConfig(tempRoot);
  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  saveTlsSettings(db, { httpsEnabled: true, passphrase: 'ProtectedTlsPassphrase!' }, config);
  const mismatchedConfig = {
    ...config,
    mfaEncryptionKey: 'different-hardening-test-key-with-more-than-thirty-two-characters'
  };
  assert.throws(
    () => loadTlsSettings(db, mismatchedConfig),
    /Stored TLS settings could not be parsed or decrypted/
  );
  assert.throws(
    () => createApplication({ config: mismatchedConfig, db }),
    /Stored TLS settings could not be parsed or decrypted/
  );

  db.prepare(`
    UPDATE app_settings SET setting_value = ? WHERE setting_key = 'network.tls'
  `).run('{"httpsEnabled":');
  assert.throws(
    () => loadTlsSettings(db, config),
    /Stored TLS settings could not be parsed or decrypted/
  );
});

test('requires upload CSRF validation before file data and supports quota-aware multi-file streaming', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-upload-stream-hardening-'));
  const config = {
    ...testConfig(tempRoot),
    maxRepositoryStorageMb: 0.001,
    maxTotalStorageMb: 0.002,
    maxRepositoryFiles: 10,
    maxTotalFiles: 20
  };
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  const passwordHash = bcrypt.hashSync('StreamingOwnerPassword123!', 12);
  const userId = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'USER')
  `).run('stream.owner', 'Streaming Owner', passwordHash).lastInsertRowid);
  const repositoryId = Number(db.prepare(`
    INSERT INTO repositories (name, description, created_by)
    VALUES (?, '', ?)
  `).run('Streaming Repository', userId).lastInsertRowid);
  const agent = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const loginPage = await agent.get('/login').expect(200);
  await agent.post('/login').type('form').send({
    _csrf: csrfFrom(loginPage.text),
    username: 'stream.owner',
    password: 'StreamingOwnerPassword123!'
  }).expect(302);

  const repositoryPage = await agent.get(`/repositories/${repositoryId}`).expect(200);
  const token = csrfFrom(repositoryPage.text);
  await agent
    .post(`/repositories/${repositoryId}/upload`)
    .attach('files', Buffer.alloc(64, 0x61), 'file-before-token.txt')
    .field('_csrf', token)
    .expect(403);

  const repositoryRoot = path.join(config.uploadRoot, String(repositoryId));
  assert.equal(fs.existsSync(repositoryRoot), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM files WHERE repository_id = ?').get(repositoryId).count, 0);

  const validPage = await agent.get(`/repositories/${repositoryId}`).expect(200);
  await agent
    .post(`/repositories/${repositoryId}/upload`)
    .field('_csrf', csrfFrom(validPage.text))
    .attach('files', Buffer.alloc(400, 0x62), 'first.bin')
    .attach('files', Buffer.alloc(400, 0x63), 'second.bin')
    .expect(302);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM files WHERE repository_id = ?').get(repositoryId).count, 2);
  assert.equal(fs.readdirSync(repositoryRoot).length, 2);
});

test('marks production authentication cookies as secure', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-secure-cookie-hardening-'));
  const config = {
    ...testConfig(tempRoot),
    nodeEnv: 'production',
    isProduction: true,
    trustProxy: 1
  };
  const app = createApplication({ config });
  const db = app.recorddrive.db;

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const plainLogin = await request(app).get('/login').expect(426);
  assert.equal(plainLogin.text, 'HTTPS is required for this listener.');
  assert.equal(plainLogin.headers['set-cookie'], undefined);
  await request(app).get('/styles.css').expect(426);
  await request(app)
    .post('/login')
    .type('form')
    .send({ username: 'admin', password: 'TestPassword123!' })
    .expect(426);

  const page = await request(app)
    .get('/login')
    .set('X-Forwarded-Proto', 'https')
    .expect(200);
  const cookieHeader = page.headers['set-cookie']
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  const response = await request(app)
    .post('/login')
    .set('X-Forwarded-Proto', 'https')
    .set('Cookie', cookieHeader)
    .type('form')
    .send({
      _csrf: csrfFrom(page.text),
      username: 'admin',
      password: 'TestPassword123!'
    })
    .expect(302);
  const sessionCookie = response.headers['set-cookie']
    .find((value) => value.startsWith('recorddrive.sid='));
  assert.ok(sessionCookie);
  assert.match(sessionCookie, /; Secure(?:;|$)/);
});

test('enforces a server-side absolute session lifetime', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-absolute-session-hardening-'));
  const config = {
    ...testConfig(tempRoot),
    sessionIdleHours: 12,
    sessionAbsoluteHours: 1
  };
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  const agent = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await passwordLogin(agent);
  const row = db.prepare('SELECT sid, sess FROM sessions').get();
  const storedSession = JSON.parse(row.sess);
  assert.ok(Number.isFinite(Number(storedSession.sessionCreatedAt)));
  storedSession.sessionCreatedAt = Date.now() - (2 * 60 * 60 * 1000);
  db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(storedSession), row.sid);

  await agent.get('/').expect(302).expect('Location', '/login?returnTo=%2F');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?').get(row.sid).count, 0);
});

test('rejects storage paths that could expose data or alter protected directories', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-storage-config-hardening-'));
  try {
    const base = testConfig(tempRoot);
    assert.throws(
      () => createApplication({
        config: { ...base, uploadRoot: path.resolve('public', 'uploads') }
      }),
      /UPLOAD_ROOT cannot be inside/
    );
    assert.throws(
      () => createApplication({
        config: { ...base, dbPath: path.resolve('public', 'recorddrive.db') }
      }),
      /DB_PATH cannot be inside/
    );
    assert.throws(
      () => createApplication({
        config: { ...base, uploadRoot: path.parse(tempRoot).root }
      }),
      /UPLOAD_ROOT cannot be a filesystem root/
    );

    const nestedUploadRoot = path.join(tempRoot, 'nested-uploads');
    const databaseInsideUploadRoot = path.join(nestedUploadRoot, '1', 'recorddrive.db');
    assert.throws(
      () => createApplication({
        config: {
          ...base,
          uploadRoot: nestedUploadRoot,
          dbPath: databaseInsideUploadRoot
        }
      }),
      /DB_PATH cannot be inside UPLOAD_ROOT/
    );
    assert.throws(
      () => createDatabase({
        ...base,
        uploadRoot: nestedUploadRoot,
        dbPath: databaseInsideUploadRoot
      }),
      /DB_PATH cannot be inside UPLOAD_ROOT/
    );

    const projectAlias = path.join(tempRoot, 'project-alias');
    try {
      fs.symlinkSync(path.resolve('.'), projectAlias, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(
        () => createApplication({
          config: {
            ...base,
            uploadRoot: path.join(projectAlias, 'public', 'linked-uploads')
          }
        }),
        /UPLOAD_ROOT cannot be inside/
      );
      assert.throws(
        () => createApplication({
          config: {
            ...base,
            dbPath: path.join(projectAlias, 'public', 'linked-recorddrive.db')
          }
        }),
        /DB_PATH cannot be inside/
      );
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
