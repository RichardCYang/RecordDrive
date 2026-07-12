import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { getRepositoryAccess } from '../src/repository-access.js';

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
    sessionSecret: 'admin-disabled-test-session-secret-over-thirty-two-characters',
    adminAccessDisabled: false,
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    mfaEncryptionKey: 'admin-disabled-test-mfa-key-over-thirty-two-characters',
    mfaIssuer: 'RecordDrive Test',
    webAuthnRpName: 'RecordDrive Test',
    webAuthnRpId: 'localhost',
    webAuthnOrigin: 'http://localhost',
    maxFileSizeMb: 5,
    maxFilesPerUpload: 3,
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads'),
    ...overrides
  };
}

async function login(agent, username, password) {
  const page = await agent.get('/login').expect(200);
  return agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), username, password });
}

test('parses ADMIN_ACCESS_DISABLED and permits disabled production startup without an administrator password', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'production-session-secret-with-more-than-thirty-two-characters',
    ADMIN_ACCESS_DISABLED: 'on',
    ADMIN_PASSWORD: 'ChangeMe123!'
  });

  assert.equal(config.adminAccessDisabled, true);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'production-session-secret-with-more-than-thirty-two-characters',
    ADMIN_ACCESS_DISABLED: 'false',
    ADMIN_PASSWORD: 'ChangeMe123!'
  }), /default ADMIN_PASSWORD/);
});

test('disabled mode does not bootstrap an administrator and keeps regular user login available', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-admin-disabled-fresh-'));
  const config = testConfig(tempRoot, { adminAccessDisabled: true });
  const app = createApplication({ config });
  const db = app.locals.db;
  const agent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN'").get().count, 0);
  db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'USER')
  `).run('member', 'Regular Member', bcrypt.hashSync('MemberPassword123!', 12));

  await agent.get('/admin').expect(404);
  const response = await login(agent, 'member', 'MemberPassword123!');
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/');
  await agent.get('/').expect(200);
});

test('disabled mode rejects administrator password and MFA entry points', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-admin-disabled-login-'));
  const enabledConfig = testConfig(tempRoot);
  const enabledApp = createApplication({ config: enabledConfig });
  const enabledDb = enabledApp.locals.db;
  enabledDb.prepare(`
    UPDATE users
    SET totp_enabled = 1, totp_secret_encrypted = ?
    WHERE username = ?
  `).run('unused-encrypted-value', 'admin');
  enabledDb.close();

  const disabledConfig = testConfig(tempRoot, { adminAccessDisabled: true });
  const app = createApplication({ config: disabledConfig });
  const db = app.locals.db;
  const agent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const response = await login(agent, 'admin', 'TestPassword123!');
  assert.equal(response.status, 401);
  assert.match(response.text, /username or password is incorrect/i);
  await agent.get('/login/mfa').expect(302).expect('Location', '/login');
  await agent.get('/admin').expect(404);
});

test('enabling the flag invalidates an active administrator session and removes implicit privileges', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-admin-disabled-session-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const agent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const loginResponse = await login(agent, 'admin', 'TestPassword123!');
  assert.equal(loginResponse.status, 302);
  await agent.get('/').expect(200);

  const administrator = db.prepare("SELECT * FROM users WHERE role = 'ADMIN'").get();
  const repositoryId = db.prepare(`
    INSERT INTO repositories (name, description, created_by)
    VALUES (?, ?, ?)
  `).run('Blocked Admin Repository', '', administrator.id).lastInsertRowid;
  const repository = db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId);

  config.adminAccessDisabled = true;
  const access = getRepositoryAccess(db, repository, administrator, config);
  assert.equal(access.view, false);
  assert.equal(access.upload, false);
  assert.equal(access.download, false);
  assert.equal(access.delete, false);
  assert.equal(access.canManage, false);

  await agent.get('/').expect(403);
  await agent.get('/').expect(302).expect('Location', '/login');

  const storedSessions = db.prepare('SELECT sess FROM sessions').all().map(({ sess }) => JSON.parse(sess));
  assert.equal(storedSessions.some((session) => Number(session.userId) === Number(administrator.id)), false);
});

test('disabled startup purges stored administrator sessions while retaining regular user sessions', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-admin-disabled-purge-'));
  const enabledConfig = testConfig(tempRoot);
  const enabledApp = createApplication({ config: enabledConfig });
  const enabledDb = enabledApp.locals.db;
  const admin = enabledDb.prepare("SELECT id FROM users WHERE role = 'ADMIN'").get();
  const memberId = enabledDb.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'USER')
  `).run('member', 'Regular Member', bcrypt.hashSync('MemberPassword123!', 12)).lastInsertRowid;
  const expires = Date.now() + 60_000;

  enabledDb.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run(
    'admin-session',
    JSON.stringify({ cookie: { maxAge: 60_000 }, userId: Number(admin.id) }),
    expires
  );
  enabledDb.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run(
    'admin-mfa-session',
    JSON.stringify({ cookie: { maxAge: 60_000 }, pendingMfa: { userId: Number(admin.id) } }),
    expires
  );
  enabledDb.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run(
    'member-session',
    JSON.stringify({ cookie: { maxAge: 60_000 }, userId: Number(memberId) }),
    expires
  );
  enabledDb.close();

  const disabledApp = createApplication({ config: testConfig(tempRoot, { adminAccessDisabled: true }) });
  const disabledDb = disabledApp.locals.db;

  t.after(() => {
    disabledDb.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(disabledDb.prepare("SELECT COUNT(*) AS count FROM sessions WHERE sid LIKE 'admin-%'").get().count, 0);
  assert.equal(disabledDb.prepare("SELECT COUNT(*) AS count FROM sessions WHERE sid = 'member-session'").get().count, 1);
});
