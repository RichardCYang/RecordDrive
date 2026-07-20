import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function availablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body }));
    });
    request.on('timeout', () => request.destroy(new Error('Health request timed out.')));
    request.on('error', reject);
  });
}

async function waitForHealth(child, port, output, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!childIsRunning(child)) {
      throw new Error(`Server entrypoint exited before listening.\n${output()}`);
    }
    try {
      const response = await requestHealth(port);
      if (response.statusCode === 200) return response;
    } catch {
      // The listener may not be ready yet.
    }
    await delay(100);
  }
  throw new Error(`Server entrypoint did not become healthy.\n${output()}`);
}

async function verifyImportedEntrypoint(t, { importPath, extraEnv = {}, gracefulShutdown = false }) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recorddrive-pm2-entry-'));
  const port = await availablePort();
  let stdout = '';
  let stderr = '';

  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(importPath)});`],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HTTP_PORT: String(port),
        HTTPS_ENABLED: 'false',
        ADMIN_ACCESS_DISABLED: 'true',
        SESSION_SECRET: 'recorddrive-test-session-secret-32-bytes-minimum',
        DB_PATH: path.join(temporaryRoot, 'recorddrive.db'),
        UPLOAD_ROOT: path.join(temporaryRoot, 'uploads'),
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  t.after(async () => {
    if (childIsRunning(child)) child.kill('SIGTERM');
    if (childIsRunning(child)) {
      await Promise.race([once(child, 'exit'), delay(5_000)]);
    }
    if (childIsRunning(child)) child.kill('SIGKILL');
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  const response = await waitForHealth(child, port, output);
  assert.equal(JSON.parse(response.body).status, 'ok');
  assert.match(stdout, /RecordDrive HTTP server is listening/);
  assert.doesNotMatch(stderr, /RecordDrive failed to start:/);

  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  if (gracefulShutdown) {
    assert.equal(signal, null);
    assert.equal(code, 0, output());
    assert.match(stdout, /RecordDrive shutdown completed\./);
  } else {
    assert.equal(signal, 'SIGTERM');
  }
}

test('the dedicated server entrypoint starts when imported by a PM2-style wrapper', { timeout: 20_000 }, async (t) => {
  await verifyImportedEntrypoint(t, {
    importPath: './src/server.js',
    gracefulShutdown: true
  });
});

test('the legacy app entrypoint recognizes PM2 pm_exec_path loading', { timeout: 20_000 }, async (t) => {
  await verifyImportedEntrypoint(t, {
    importPath: './src/app.js',
    extraEnv: {
      pm_exec_path: path.join(projectRoot, 'src', 'app.js')
    }
  });
});
