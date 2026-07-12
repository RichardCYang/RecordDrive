import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createDatabase, logActivity } from '../src/database.js';
import { createZipPreview } from '../src/file-preview.js';

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
