import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApplication } from '../src/app.js';
import { createDatabase } from '../src/database.js';
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
    trustProxy: false,
    sessionSecret: 'password-change-test-session-secret-with-more-than-thirty-two-characters',
    mfaEncryptionKey: 'password-change-test-mfa-key-with-more-than-thirty-two-characters',
    mfaIssuer: 'RecordDrive Password Test',
    webAuthnRpName: 'RecordDrive Password Test',
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

async function login(agent, username, password, expectedLocation) {
  const page = await agent.get('/login').expect(200);
  return agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), username, password })
    .expect(302)
    .expect('Location', expectedLocation);
}

test('upgrading a legacy database requires existing regular users to replace administrator-issued passwords', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-password-migration-'));
  const config = { ...testConfig(tempRoot), adminAccessDisabled: true };
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const legacy = new DatabaseSync(config.dbPath);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN', 'USER')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('legacy.admin', 'Legacy Admin', 'unused', 'ADMIN');
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('legacy.user', 'Legacy User', 'unused', 'USER');
  `);
  legacy.close();

  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const rows = db.prepare(`
    SELECT username, must_change_password
    FROM users
    ORDER BY username
  `).all();
  assert.deepEqual(rows, [
    { username: 'legacy.admin', must_change_password: 0 },
    { username: 'legacy.user', must_change_password: 1 }
  ]);
});

test('temporary administrator-issued passwords are replaced before file access and password changes revoke other sessions', async (t) => {
  resetAuthenticationRateLimits();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-password-confidentiality-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.recorddrive.db;
  const adminAgent = request.agent(app);
  const userAgent = request.agent(app);

  t.after(() => {
    resetAuthenticationRateLimits();
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await login(adminAgent, 'admin', 'TestPassword123!', '/');
  const accountsPage = await adminAgent.get('/admin/users').expect(200);
  await adminAgent
    .post('/admin/users')
    .type('form')
    .send({
      _csrf: csrfFrom(accountsPage.text),
      username: 'reader',
      displayName: 'Confidential Reader',
      password: 'TemporaryPass123!'
    })
    .expect(302)
    .expect('Location', '/admin/users');

  let user = db.prepare(`
    SELECT id, password_hash, must_change_password
    FROM users
    WHERE username = 'reader'
  `).get();
  assert.equal(user.must_change_password, 1);

  await login(userAgent, 'reader', 'TemporaryPass123!', '/settings/password');
  await userAgent.get('/').expect(302).expect('Location', '/settings/password');
  await userAgent.get('/repositories/1').expect(302).expect('Location', '/settings/password');

  let passwordPage = await userAgent.get('/settings/password').expect(200);
  await userAgent
    .post('/settings/password')
    .type('form')
    .send({
      _csrf: csrfFrom(passwordPage.text),
      currentPassword: 'incorrect-current-password',
      newPassword: 'UniqueReaderPass456!',
      confirmPassword: 'UniqueReaderPass456!'
    })
    .expect(401);

  passwordPage = await userAgent.get('/settings/password').expect(200);
  await userAgent
    .post('/settings/password')
    .type('form')
    .send({
      _csrf: csrfFrom(passwordPage.text),
      currentPassword: 'TemporaryPass123!',
      newPassword: 'too-short',
      confirmPassword: 'too-short'
    })
    .expect(400);

  passwordPage = await userAgent.get('/settings/password').expect(200);
  await userAgent
    .post('/settings/password')
    .type('form')
    .send({
      _csrf: csrfFrom(passwordPage.text),
      currentPassword: 'TemporaryPass123!',
      newPassword: 'UniqueReaderPass456!',
      confirmPassword: 'UniqueReaderPass456!'
    })
    .expect(302)
    .expect('Location', '/');

  user = db.prepare(`
    SELECT id, password_hash, must_change_password
    FROM users
    WHERE username = 'reader'
  `).get();
  assert.equal(user.must_change_password, 0);
  assert.equal(await bcrypt.compare('TemporaryPass123!', user.password_hash), false);
  assert.equal(await bcrypt.compare('UniqueReaderPass456!', user.password_hash), true);
  await userAgent.get('/').expect(200);

  const secondAgent = request.agent(app);
  await login(secondAgent, 'reader', 'UniqueReaderPass456!', '/');

  passwordPage = await userAgent.get('/settings/password').expect(200);
  await userAgent
    .post('/settings/password')
    .type('form')
    .send({
      _csrf: csrfFrom(passwordPage.text),
      currentPassword: 'UniqueReaderPass456!',
      newPassword: 'FinalReaderPass789!',
      confirmPassword: 'FinalReaderPass789!'
    })
    .expect(302)
    .expect('Location', '/settings#security');

  await secondAgent.get('/').expect(302).expect('Location', '/login?returnTo=%2F');
  const stalePasswordAgent = request.agent(app);
  const staleLoginPage = await stalePasswordAgent.get('/login').expect(200);
  await stalePasswordAgent
    .post('/login')
    .type('form')
    .send({
      _csrf: csrfFrom(staleLoginPage.text),
      username: 'reader',
      password: 'UniqueReaderPass456!'
    })
    .expect(401);

  const freshAgent = request.agent(app);
  await login(freshAgent, 'reader', 'FinalReaderPass789!', '/');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM activity_logs
    WHERE actor_id = ? AND action = 'PASSWORD_CHANGED'
  `).get(user.id).count, 2);
});
