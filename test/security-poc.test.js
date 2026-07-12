import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase, logActivity } from '../src/database.js';
import { createZipPreview } from '../src/file-preview.js';
import { consumeRecoveryCode, createRecoveryCodes } from '../src/security-service.js';

function createTestConfig(root, maxActivityLogEntries) {
  return loadConfig({
    NODE_ENV: 'test',
    ADMIN_ACCESS_DISABLED: 'true',
    SESSION_SECRET: 'security-poc-session-secret-with-more-than-thirty-two-characters',
    DB_PATH: path.join(root, 'data', 'recorddrive.db'),
    UPLOAD_ROOT: path.join(root, 'uploads'),
    MAX_ACTIVITY_LOG_ENTRIES: String(maxActivityLogEntries)
  });
}

function appendActivityEntries(db, start, count) {
  for (let index = start; index < start + count; index += 1) {
    logActivity(db, {
      action: 'POC_ACTIVITY',
      targetType: 'security-test',
      targetLabel: `entry-${index}`
    });
  }
}

test('bounds activity-log growth at startup and during authenticated activity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-activity-log-poc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let db = createDatabase(createTestConfig(root, 5000));
  appendActivityEntries(db, 0, 600);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get().count, 600);
  db.close();

  db = createDatabase(createTestConfig(root, 100));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get().count, 100);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE target_label = 'entry-0'").get().count,
    0
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE target_label = 'entry-599'").get().count,
    1
  );

  appendActivityEntries(db, 600, 1000);
  const retained = db.prepare('SELECT COUNT(*) AS count FROM activity_logs').get().count;
  assert.ok(retained <= 100, `Expected at most 100 retained entries, found ${retained}`);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE target_label = 'entry-1599'").get().count,
    1
  );
  db.close();
});


test('handles the malformed NTFS extra field used by CVE-2026-31988 without a preview crash', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-yauzl-cve-poc-'));
  const archivePath = path.join(root, 'malformed-ntfs-extra.zip');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const craftedArchive = Buffer.from(
    'UEsDBBQAAAAAAAAAIQDI9m6dAwAAAAMAAAAHAAgAcG9jLnR4dAoABAAAAAAAcG9jUEsBAhQDFAAAAAAAAAAhAMj2bp0DAAAAAwAAAAcACAAAAAAAAAAAAIABAAAAAHBvYy50eHQKAAQAAAAAAFBLBQYAAAAAAQABAD0AAAAwAAAAAAA=',
    'base64'
  );
  fs.writeFileSync(archivePath, craftedArchive);

  const preview = await createZipPreview(archivePath, fs.statSync(archivePath));
  assert.equal(preview.kind, 'zip');
  assert.equal(preview.entries.length, 1);
  assert.equal(preview.entries[0].name, 'poc.txt');
  assert.equal(preview.entries[0].modifiedAt, '1980-01-01T00:00:00.000Z');
});


function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should exist in rendered HTML');
  return match[1];
}

async function loginUser(agent, username, password) {
  const page = await agent.get('/login').expect(200);
  await agent.post('/login').type('form').send({
    _csrf: csrfFrom(page.text),
    username,
    password
  }).expect(302).expect('Location', '/');
}

async function createRepositories(agent, prefix, attempts) {
  const dashboard = await agent.get('/').expect(200);
  const csrf = csrfFrom(dashboard.text);
  let accepted = 0;
  for (let index = 0; index < attempts; index += 1) {
    const response = await agent.post('/repositories').type('form').send({
      _csrf: csrf,
      name: `${prefix} ${String(index).padStart(3, '0')}`,
      description: 'Repository limit regression test.'
    }).expect(302);
    if (/^\/repositories\/\d+$/.test(response.headers.location || '')) accepted += 1;
  }
  return accepted;
}

test('bounds authenticated repository creation per user and across the service', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-repository-quota-poc-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    ADMIN_ACCESS_DISABLED: 'true',
    SESSION_SECRET: 'repository-quota-test-session-secret-longer-than-thirty-two-bytes',
    MFA_ENCRYPTION_KEY: 'repository-quota-test-mfa-secret-longer-than-thirty-two-bytes',
    DB_PATH: path.join(root, 'data', 'recorddrive.db'),
    UPLOAD_ROOT: path.join(root, 'uploads'),
    MAX_REPOSITORIES_PER_USER: '3',
    MAX_TOTAL_REPOSITORIES: '4',
    MAX_ACTIVITY_LOG_ENTRIES: '100'
  });
  const db = createDatabase(config);
  const password = 'RepositoryQuotaPassword123!';
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'USER')
  `);
  const firstUserId = Number(insertUser.run(
    'repository.limit.one',
    'Repository Limit One',
    bcrypt.hashSync(password, 4)
  ).lastInsertRowid);
  const secondUserId = Number(insertUser.run(
    'repository.limit.two',
    'Repository Limit Two',
    bcrypt.hashSync(password, 4)
  ).lastInsertRowid);
  const app = createApplication({ config, db });
  const firstAgent = request.agent(app);
  const secondAgent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await loginUser(firstAgent, 'repository.limit.one', password);
  assert.equal(await createRepositories(firstAgent, 'First Owner Repository', 5), 3);
  const firstLimitPage = await firstAgent.get('/').expect(200);
  assert.match(firstLimitPage.text, /maximum number of repositories for this account has been reached/i);

  await loginUser(secondAgent, 'repository.limit.two', password);
  assert.equal(await createRepositories(secondAgent, 'Second Owner Repository', 3), 1);
  const totalLimitPage = await secondAgent.get('/').expect(200);
  assert.match(totalLimitPage.text, /server repository limit has been reached/i);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 4);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM repositories WHERE created_by = ?').get(firstUserId).count,
    3
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM repositories WHERE created_by = ?').get(secondUserId).count,
    1
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE action = 'CREATE_REPOSITORY'").get().count,
    4
  );
});

test('deletes consumed recovery codes and purges legacy used rows at startup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-recovery-retention-poc-'));
  const config = createTestConfig(root, 100);
  let db = createDatabase(config);
  const insertedUser = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, ?, 'USER')
  `).run('recovery.retention', 'Recovery Retention', bcrypt.hashSync('RecoveryRetention123!', 4));
  const userId = Number(insertedUser.lastInsertRowid);
  createRecoveryCodes(db, userId, config, 1);
  db.prepare(`
    UPDATE recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = ?
  `).run(userId);
  db.close();

  db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ?').get(userId).count,
    0
  );

  let [currentCode] = createRecoveryCodes(db, userId, config, 1);
  for (let index = 0; index < 1000; index += 1) {
    const consumedCode = currentCode;
    assert.equal(consumeRecoveryCode(db, userId, consumedCode, config), true);
    assert.equal(consumeRecoveryCode(db, userId, consumedCode, config), false);
    [currentCode] = createRecoveryCodes(db, userId, config, 1);
  }

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ?').get(userId).count,
    1
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM recovery_codes
      WHERE user_id = ? AND used_at IS NOT NULL
    `).get(userId).count,
    0
  );
});
