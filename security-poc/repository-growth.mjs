import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';

const attempts = Number.parseInt(process.env.ATTEMPTS || process.argv[2] || '250', 10);
const perUserLimit = Number.parseInt(process.env.MAX_REPOSITORIES_PER_USER || '50', 10);
const totalLimit = Number.parseInt(process.env.MAX_TOTAL_REPOSITORIES || '100', 10);
const expectBounded = process.env.EXPECT_BOUNDED !== 'false';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-repository-growth-poc-'));
const config = loadConfig({
  NODE_ENV: 'test',
  ADMIN_ACCESS_DISABLED: 'true',
  SESSION_SECRET: 'repository-growth-poc-session-secret-longer-than-thirty-two-bytes',
  MFA_ENCRYPTION_KEY: 'repository-growth-poc-mfa-secret-longer-than-thirty-two-bytes',
  DB_PATH: path.join(root, 'recorddrive.db'),
  UPLOAD_ROOT: path.join(root, 'uploads'),
  MAX_REPOSITORIES_PER_USER: String(perUserLimit),
  MAX_TOTAL_REPOSITORIES: String(totalLimit),
  MAX_ACTIVITY_LOG_ENTRIES: '100000'
});
const db = createDatabase(config);
const password = 'RepositoryPoCPassword123!';
const insertedUser = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES (?, ?, ?, 'USER')
`).run('repository.poc', 'Repository PoC', bcrypt.hashSync(password, 4));
const userId = Number(insertedUser.lastInsertRowid);
const app = createApplication({ config, db });
const agent = request.agent(app);

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token missing');
  return match[1];
}

try {
  const loginPage = await agent.get('/login').expect(200);
  await agent.post('/login').type('form').send({
    _csrf: csrfFrom(loginPage.text),
    username: 'repository.poc',
    password
  }).expect(302).expect('Location', '/');

  const dashboard = await agent.get('/').expect(200);
  const csrf = csrfFrom(dashboard.text);
  const startedAt = Date.now();
  let accepted = 0;
  for (let index = 0; index < attempts; index += 1) {
    const response = await agent.post('/repositories').type('form').send({
      _csrf: csrf,
      name: `PoC Repository ${String(index).padStart(6, '0')}`,
      description: 'Repository allocation growth proof of concept.'
    });
    if (response.status === 302 && /^\/repositories\/\d+$/.test(response.headers.location || '')) {
      accepted += 1;
    }
  }

  const rows = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM repositories WHERE created_by = ?
  `).get(userId).count);
  const limitPage = await agent.get('/').expect(200);
  const limitMessageVisible = /maximum number of repositories for this account has been reached/i.test(limitPage.text);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count);
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
  const expectedMaximum = Math.min(perUserLimit, totalLimit);
  const bounded = accepted <= expectedMaximum && rows <= expectedMaximum;
  const result = {
    mode: expectBounded ? 'patched' : 'baseline',
    attempts,
    configuredPerUserLimit: perUserLimit,
    configuredTotalLimit: totalLimit,
    accepted,
    rejected: attempts - accepted,
    repositoryRows: rows,
    limitMessageVisible,
    databaseAllocatedBytes: pageCount * pageSize,
    elapsedMs: Date.now() - startedAt,
    bounded
  };
  console.log(JSON.stringify(result, null, 2));

  if (expectBounded) {
    assert.equal(accepted, Math.min(attempts, expectedMaximum));
    assert.equal(rows, accepted);
    assert.equal(bounded, true);
    assert.equal(limitMessageVisible, attempts > expectedMaximum);
  } else {
    assert.equal(accepted, attempts);
    assert.equal(rows, attempts);
    assert.equal(bounded, false);
  }
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
