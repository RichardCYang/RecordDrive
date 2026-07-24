import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIDENTIALITY_CANARIES,
  runDockerBuildContextPoC,
  verifyPatchedPolicy
} from '../security-poc/docker-build-context-confidentiality.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function currentPolicy() {
  return {
    dockerfile: fs.readFileSync(path.join(projectRoot, 'Dockerfile'), 'utf8'),
    dockerignore: fs.readFileSync(path.join(projectRoot, '.dockerignore'), 'utf8')
  };
}

test('baseline broad copy exposes deployment-secret canaries', () => {
  const result = runDockerBuildContextPoC(projectRoot);
  assert.equal(result.baseline.broadContextCopy, true);
  assert.equal(result.baseline.verdict, 'EXPOSED');
  assert.deepEqual(result.baseline.exposedCanaries, [
    '.env.production',
    '.env.local',
    'certificates/tls-private.key',
    'certificates/recorddrive.pfx',
    'data/recorddrive-backup.sqlite',
    'data/exports/tenant-a.zip',
    'logs/recorddrive.log'
  ]);
  assert.equal(result.baseline.exposedCanaries.includes('.git/config'), false);
});

test('patched image copies only the runtime allowlist and blocks all canaries', () => {
  const policy = verifyPatchedPolicy(currentPolicy());
  assert.equal(policy.malformedCopyInstruction, false);
  assert.equal(policy.broadContextCopy, false);
  assert.equal(policy.denyAllFirst, true);
  assert.deepEqual(policy.unexpectedCopySources, []);
  assert.deepEqual(policy.exposedCanaries, []);
  assert.equal(policy.blockedCanaryCount, CONFIDENTIALITY_CANARIES.length);
  assert.equal(policy.verdict, 'BLOCKED');
});

test('Docker policy does not copy Git metadata into the image', () => {
  const policy = verifyPatchedPolicy(currentPolicy());
  assert.equal(policy.copySources.some((source) => source === '.git' || source.startsWith('.git/')), false);
  assert.equal(policy.allowRules.some((rule) => rule === '!.git' || rule.startsWith('!.git/')), false);
});
