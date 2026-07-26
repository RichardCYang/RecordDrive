import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('bundled SMB entrypoint uses executable Unix line endings', () => {
  const entrypoint = fs.readFileSync(path.join(projectRoot, 'smb', 'entrypoint.sh'));
  assert.equal(entrypoint.subarray(0, 10).toString('utf8'), '#!/bin/sh\n');
  assert.equal(entrypoint.includes(Buffer.from('\r\n')), false);
});

test('bundled SMB sidecar requires SMB3 transport encryption', () => {
  const entrypoint = fs.readFileSync(path.join(projectRoot, 'smb', 'entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /^\s*server min protocol = SMB3_00\s*$/m);
  assert.match(entrypoint, /^\s*server max protocol = SMB3\s*$/m);
  assert.match(entrypoint, /^\s*server signing = mandatory\s*$/m);
  assert.match(entrypoint, /^\s*server smb encrypt = required\s*$/m);
  assert.doesNotMatch(entrypoint, /^\s*smb encrypt = desired\s*$/m);
});

test('bundled SMB port is loopback-only unless explicitly configured', () => {
  const compose = fs.readFileSync(path.join(projectRoot, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /\$\{SMB_BIND_ADDRESS:-127\.0\.0\.1\}:445:445/);
  assert.doesNotMatch(compose, /\$\{SMB_BIND_ADDRESS:-0\.0\.0\.0\}:445:445/);
  const exampleEnv = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
  assert.match(exampleEnv, /^SMB_BIND_ADDRESS=127\.0\.0\.1$/m);
  assert.doesNotMatch(exampleEnv, /^SMB_BIND_ADDRESS=0\.0\.0\.0$/m);
});
