import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { generate } from 'otplib';
import { createApplication } from '../src/app.js';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  verifyAndConsumeTotp
} from '../src/security-service.js';

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should exist in rendered HTML');
  return match[1];
}

function metaCsrfFrom(html) {
  const match = html.match(/name="csrf-token" content="([^"]+)"/);
  assert.ok(match, 'CSRF meta token should exist in rendered HTML');
  return match[1];
}

function totpSecretFrom(html) {
  const match = html.match(/data-totp-secret>([^<]+)</);
  assert.ok(match, 'TOTP setup secret should be rendered during enrollment');
  return match[1].trim();
}

function recoveryCodesFrom(html) {
  return Array.from(html.matchAll(/class="recovery-code">([^<]+)</g), (match) => match[1].trim());
}

function testConfig(tempRoot) {
  return {
    port: 0,
    nodeEnv: 'test',
    isProduction: false,
    sessionSecret: 'test-session-secret-with-more-than-thirty-two-characters',
    mfaEncryptionKey: 'test-mfa-encryption-key-with-more-than-thirty-two-characters',
    mfaIssuer: 'RecordDrive Test',
    webAuthnRpName: 'RecordDrive Test',
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

async function passwordLogin(agent, password = 'TestPassword123!') {
  const page = await agent.get('/login').expect(200);
  return agent
    .post('/login')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), username: 'admin', password })
    .expect(302);
}

async function logout(agent) {
  const page = await agent.get('/settings').expect(200);
  await agent
    .post('/logout')
    .type('form')
    .send({ _csrf: csrfFrom(page.text) })
    .expect(302)
    .expect('Location', '/login');
}

test('encrypts TOTP secrets with authenticated encryption', () => {
  const config = { mfaEncryptionKey: 'unit-test-encryption-key', sessionSecret: 'unused' };
  const encrypted = encryptTotpSecret('ABCDEFGHIJKLMNOPQRSTUVWX', config);
  assert.notEqual(encrypted, 'ABCDEFGHIJKLMNOPQRSTUVWX');
  assert.equal(decryptTotpSecret(encrypted, config), 'ABCDEFGHIJKLMNOPQRSTUVWX');
  assert.throws(() => decryptTotpSecret(`${encrypted.slice(0, -1)}A`, config));
});

test('supports TOTP, one-time recovery keys, multiple recovery keys, and passkey options', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-security-test-'));
  const config = testConfig(tempRoot);
  const app = createApplication({ config });
  const db = app.locals.db;
  const agent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  let loginResponse = await passwordLogin(agent);
  assert.equal(loginResponse.headers.location, '/');

  let settings = await agent.get('/settings').expect(200);
  await agent
    .post('/settings/security/totp/start')
    .type('form')
    .send({ _csrf: csrfFrom(settings.text) })
    .expect(302)
    .expect('Location', '/settings#totp');

  settings = await agent.get('/settings').expect(200);
  const secret = totpSecretFrom(settings.text);
  const enrollmentToken = await generate({ secret });
  await agent
    .post('/settings/security/totp/confirm')
    .type('form')
    .send({ _csrf: csrfFrom(settings.text), token: enrollmentToken })
    .expect(302)
    .expect('Location', '/settings#security');

  const storedUser = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  assert.equal(storedUser.totp_enabled, 1);
  assert.ok(storedUser.totp_secret_encrypted);
  assert.doesNotMatch(storedUser.totp_secret_encrypted, new RegExp(secret));
  assert.equal(decryptTotpSecret(storedUser.totp_secret_encrypted, config), secret);

  settings = await agent.get('/settings').expect(200);
  const initialRecoveryCodes = recoveryCodesFrom(settings.text);
  assert.equal(initialRecoveryCodes.length, 8);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(storedUser.id).count,
    8
  );

  db.prepare('UPDATE users SET totp_last_used_step = NULL WHERE id = ?').run(storedUser.id);
  const loginToken = await generate({ secret });
  assert.equal(await verifyAndConsumeTotp(db, storedUser.id, loginToken, config), true);
  assert.equal(await verifyAndConsumeTotp(db, storedUser.id, loginToken, config), false);
  db.prepare('UPDATE users SET totp_last_used_step = NULL WHERE id = ?').run(storedUser.id);

  await logout(agent);
  loginResponse = await passwordLogin(agent);
  assert.equal(loginResponse.headers.location, '/login/mfa');
  let mfaPage = await agent.get('/login/mfa').expect(200);
  await agent
    .post('/login/mfa/totp')
    .type('form')
    .send({ _csrf: csrfFrom(mfaPage.text), token: await generate({ secret }) })
    .expect(302)
    .expect('Location', '/');

  await logout(agent);
  loginResponse = await passwordLogin(agent);
  assert.equal(loginResponse.headers.location, '/login/mfa');
  mfaPage = await agent.get('/login/mfa').expect(200);
  await agent
    .post('/login/mfa/recovery')
    .type('form')
    .send({ _csrf: csrfFrom(mfaPage.text), recoveryCode: initialRecoveryCodes[0] })
    .expect(302)
    .expect('Location', '/');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(storedUser.id).count,
    7
  );

  settings = await agent.get('/settings').expect(200);
  await agent
    .post('/settings/security/recovery-codes/add')
    .type('form')
    .send({ _csrf: csrfFrom(settings.text) })
    .expect(302)
    .expect('Location', '/settings#recovery-codes');
  settings = await agent.get('/settings').expect(200);
  assert.equal(recoveryCodesFrom(settings.text).length, 8);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(storedUser.id).count,
    15
  );

  const optionsResponse = await agent
    .post('/settings/security/passkeys/options')
    .set('X-CSRF-Token', metaCsrfFrom(settings.text))
    .send({ name: 'Test security key' })
    .expect(200);
  assert.equal(optionsResponse.body.rp.id, 'localhost');
  assert.equal(optionsResponse.body.user.name, 'admin');
  assert.equal(optionsResponse.body.authenticatorSelection.residentKey, 'required');
  assert.equal(optionsResponse.body.authenticatorSelection.userVerification, 'required');
  assert.ok(optionsResponse.body.challenge);
});
