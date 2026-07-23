import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInFlightDisclosureRevocationPoc } from '../security-poc/in-flight-disclosure-revocation.mjs';

test('in-flight permission and session revocation stop protected file disclosures', async () => {
  const result = await runInFlightDisclosureRevocationPoc();

  assert.equal(result.baseline.permissionRevocation.fullDisclosure, true);
  assert.equal(result.baseline.sessionRevocation.fullDisclosure, true);
  assert.equal(result.patched.permissionRevocation.fullDisclosure, false);
  assert.equal(result.patched.sessionRevocation.fullDisclosure, false);
  assert.equal(result.patched.permissionRevocation.revoked, true);
  assert.equal(result.patched.sessionRevocation.revoked, true);
  assert.equal(result.verdict, 'BLOCKED');
});

test('download and preview routes apply fresh disclosure authorization', () => {
  const routeSource = fs.readFileSync(
    new URL('../src/routes/repositories.js', import.meta.url),
    'utf8'
  );

  assert.equal(
    (routeSource.match(/streamAuthorizedFile\(opened, tracker, res, next, authorizeDisclosure\)/g) || []).length,
    2
  );
  assert.match(routeSource, /const preview = await withTrackedFileAccess[\s\S]*if \(!authorizeDisclosure\(\)\)[\s\S]*streamAuthorizedJson\(preview, res, next, authorizeDisclosure\);/u);
  assert.match(routeSource, /createFileDisclosureAuthorizer\(db, config, \{[\s\S]*sessionId: req\.sessionID[\s\S]*fileId: file\.id/u);
});
