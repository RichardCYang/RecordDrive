import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { consumeRecoveryCode, createRecoveryCodes } from '../src/security-service.js';

const cycles = Number.parseInt(process.env.CYCLES || process.argv[2] || '5000', 10);
const expectBounded = process.env.EXPECT_BOUNDED !== 'false';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-recovery-growth-poc-'));
const config = loadConfig({
  NODE_ENV: 'test',
  ADMIN_ACCESS_DISABLED: 'true',
  SESSION_SECRET: 'recovery-growth-poc-session-secret-longer-than-thirty-two-bytes',
  MFA_ENCRYPTION_KEY: 'recovery-growth-poc-mfa-secret-longer-than-thirty-two-bytes',
  DB_PATH: path.join(root, 'recorddrive.db'),
  UPLOAD_ROOT: path.join(root, 'uploads')
});
const db = createDatabase(config);
const insertedUser = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES (?, ?, ?, 'USER')
`).run('recovery.poc', 'Recovery PoC', bcrypt.hashSync('RecoveryPoCPassword123!', 4));
const userId = Number(insertedUser.lastInsertRowid);
let [currentCode] = createRecoveryCodes(db, userId, config, 1);
const startedAt = Date.now();

try {
  for (let index = 0; index < cycles; index += 1) {
    assert.equal(consumeRecoveryCode(db, userId, currentCode, config), true);
    [currentCode] = createRecoveryCodes(db, userId, config, 1);
  }
  const totalRows = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ?
  `).get(userId).count);
  const activeRows = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM recovery_codes
    WHERE user_id = ? AND used_at IS NULL
  `).get(userId).count);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count);
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
  const result = {
    mode: expectBounded ? 'patched' : 'baseline',
    cycles,
    totalRows,
    activeRows,
    retainedUsedRows: totalRows - activeRows,
    databaseAllocatedBytes: pageCount * pageSize,
    elapsedMs: Date.now() - startedAt,
    bounded: totalRows === activeRows
  };
  console.log(JSON.stringify(result, null, 2));

  if (expectBounded) {
    assert.equal(totalRows, 1);
    assert.equal(activeRows, 1);
    assert.equal(result.retainedUsedRows, 0);
  } else {
    assert.equal(totalRows, cycles + 1);
    assert.equal(activeRows, 1);
    assert.equal(result.retainedUsedRows, cycles);
  }
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
