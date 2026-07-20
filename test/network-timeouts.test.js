import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createHttpServerOptions } from '../src/network-server.js';

test('large-upload request timeouts replace the Node.js five-minute default', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    HTTP_REQUEST_TIMEOUT_MS: '',
    HTTP_HEADERS_TIMEOUT_MS: ''
  });
  assert.equal(config.httpRequestTimeoutMs, 60 * 60 * 1000);
  assert.equal(config.httpHeadersTimeoutMs, 60 * 1000);

  const server = http.createServer(createHttpServerOptions(config));
  assert.equal(server.requestTimeout, 60 * 60 * 1000);
  assert.equal(server.headersTimeout, 60 * 1000);
  server.close();
});

test('HTTP timeout configuration supports a trusted-proxy unlimited mode and valid header bounds', () => {
  const unlimited = loadConfig({
    NODE_ENV: 'test',
    HTTP_REQUEST_TIMEOUT_MS: '0',
    HTTP_HEADERS_TIMEOUT_MS: '45000'
  });
  assert.equal(unlimited.httpRequestTimeoutMs, 0);
  assert.equal(unlimited.httpHeadersTimeoutMs, 45_000);
  assert.deepEqual(createHttpServerOptions(unlimited), {
    requestTimeout: 0,
    headersTimeout: 45_000
  });

  const clamped = loadConfig({
    NODE_ENV: 'test',
    HTTP_REQUEST_TIMEOUT_MS: '30000',
    HTTP_HEADERS_TIMEOUT_MS: '60000'
  });
  assert.equal(clamped.httpRequestTimeoutMs, 30_000);
  assert.equal(clamped.httpHeadersTimeoutMs, 30_000);
  assert.deepEqual(createHttpServerOptions(clamped), {
    requestTimeout: 30_000,
    headersTimeout: 30_000
  });
});
