import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  logRequestErrorSafely,
  requestBodyClientErrorStatus,
  safeRequestErrorLogRecord
} from '../src/request-error-security.js';
import { createTranslator } from '../src/i18n.js';

function testConfig(tempRoot) {
  return {
    port: 0,
    nodeEnv: 'test',
    isProduction: false,
    trustProxy: false,
    exposeDetailedErrors: false,
    sessionSecret: 'request-log-test-session-secret-with-more-than-thirty-two-characters',
    mfaEncryptionKey: 'request-log-test-mfa-key-with-more-than-thirty-two-characters',
    mfaIssuer: 'RecordDrive Request Log Test',
    webAuthnRpName: 'RecordDrive Request Log Test',
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

test('safe request error logging excludes body, message, and custom secret-bearing fields', (t) => {
  const marker = 'POC-SECRET-LOG-MARKER-3c860f52';
  const error = new SyntaxError(`Unexpected token near ${marker}`);
  error.status = 400;
  error.type = 'entity.parse.failed';
  error.body = `{"currentPassword":"${marker}",`;
  error.request = { headers: { authorization: `Bearer ${marker}` } };

  const captured = [];
  const originalConsoleError = console.error;
  console.error = (...args) => captured.push(args);
  t.after(() => { console.error = originalConsoleError; });

  assert.equal(requestBodyClientErrorStatus(error), 400);
  assert.deepEqual(safeRequestErrorLogRecord(error), {
    name: 'SyntaxError',
    type: 'entity.parse.failed',
    status: 400
  });

  assert.deepEqual(safeRequestErrorLogRecord({
    name: marker,
    code: marker,
    type: marker,
    status: 500
  }), { name: 'Error', status: 500 });

  logRequestErrorSafely(error, 'Request body rejected');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].length, 1, 'only one pre-sanitized string should be sent to console.error');
  const output = String(captured[0][0]);
  assert.match(output, /Request body rejected/);
  assert.match(output, /entity\.parse\.failed/);
  assert.doesNotMatch(output, new RegExp(marker));
  assert.doesNotMatch(output, /currentPassword|authorization|Bearer|\"body\"|Unexpected token/);
});

test('malformed JSON is rejected without writing the submitted secret to logs', async (t) => {
  const [{ default: request }, { createApplication }] = await Promise.all([
    import('supertest'),
    import('../src/app.js')
  ]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-request-log-'));
  const app = createApplication({ config: testConfig(tempRoot) });
  const marker = 'POC-CURRENT-PASSWORD-8a4521d9';
  const captured = [];
  const originalConsoleError = console.error;
  console.error = (...args) => captured.push(args);

  t.after(() => {
    console.error = originalConsoleError;
    app.recorddrive.db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const response = await request(app)
    .post('/settings/security/verify-password')
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json')
    .send(`{"currentPassword": ${marker}}`)
    .expect(400);

  assert.equal(response.body.error, 'The request body is invalid.');
  const output = captured.flat().map(String).join('\n');
  assert.match(output, /entity\.parse\.failed/);
  assert.doesNotMatch(output, new RegExp(marker));
  assert.doesNotMatch(output, /currentPassword|\"body\"|Unexpected token/);
});

test('request parsers run after translation setup and the raw error object is never logged', () => {
  const appSource = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const languageIndex = appSource.indexOf('app.use(languageMiddleware);');
  const urlencodedIndex = appSource.indexOf('app.use(express.urlencoded(');
  const jsonIndex = appSource.indexOf('app.use(express.json(');

  assert.ok(languageIndex >= 0 && urlencodedIndex >= 0 && jsonIndex >= 0);
  assert.ok(languageIndex < urlencodedIndex && languageIndex < jsonIndex);
  assert.match(appSource, /const t = typeof req\.t === 'function'/);
  assert.doesNotMatch(appSource, /console\.error\(error\)/);
  assert.match(appSource, /requestBodyClientErrorStatus\(error\)/);
});

test('request-body rejection messages are localized for every supported non-English language', () => {
  for (const language of ['ja', 'ko', 'fr', 'es', 'pt']) {
    const t = createTranslator(language);
    assert.notEqual(t('Invalid request'), 'Invalid request');
    assert.notEqual(t('The request body is too large.'), 'The request body is too large.');
    assert.notEqual(t('The request body format is not supported.'), 'The request body format is not supported.');
    assert.notEqual(t('The request body is invalid.'), 'The request body is invalid.');
  }
});
