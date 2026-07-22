import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApplication } from '../src/app.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-request-log-poc-'));
const marker = 'POC-CREDENTIAL-DO-NOT-USE-5f2b76c1';
const config = {
  port: 0,
  nodeEnv: 'test',
  isProduction: false,
  trustProxy: false,
  exposeDetailedErrors: false,
  sessionSecret: 'request-log-poc-session-secret-with-more-than-thirty-two-characters',
  mfaEncryptionKey: 'request-log-poc-mfa-key-with-more-than-thirty-two-characters',
  mfaIssuer: 'RecordDrive Request Log PoC',
  webAuthnRpName: 'RecordDrive Request Log PoC',
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

const app = createApplication({ config });
const captured = [];
const originalConsoleError = console.error;
console.error = (...args) => captured.push(args);

try {
  const response = await request(app)
    .post('/settings/security/verify-password')
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json')
    .send(`{"currentPassword": ${marker}}`);
  const logOutput = captured.flat().map(String).join('\n');
  const result = {
    requestStatus: response.status,
    parserErrorClassLogged: logOutput.includes('entity.parse.failed'),
    credentialMarkerPresentInLogs: logOutput.includes(marker),
    submittedFieldNamePresentInLogs: logOutput.includes('currentPassword'),
    rawBodyPropertyPresentInLogs: logOutput.includes('body:'),
    verdict: response.status === 400
      && !logOutput.includes(marker)
      && !logOutput.includes('currentPassword')
      && !logOutput.includes('body:')
      ? 'PASS'
      : 'FAIL'
  };
  originalConsoleError(JSON.stringify(result, null, 2));
  if (result.verdict !== 'PASS') process.exitCode = 1;
} finally {
  console.error = originalConsoleError;
  app.recorddrive.db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
