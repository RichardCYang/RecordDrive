import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRuntimeConfidentialityPolicy, loadConfig } from '../src/config.js';

const strongBase = {
  NODE_ENV: 'test',
  ALLOWED_HOSTS: 'files.example.test',
  SESSION_SECRET: 'trust-proxy-regression-session-secret-with-at-least-thirty-two-bytes',
  ADMIN_ACCESS_DISABLED: 'true'
};

test('rejects hop-count proxy trust before request handling', () => {
  assert.throws(() => loadConfig({ ...strongBase, TRUST_PROXY: '1' }), /hop counts are not accepted/);
  assert.throws(() => applyRuntimeConfidentialityPolicy({
    isProduction: false,
    httpHost: '0.0.0.0',
    httpsHost: '0.0.0.0',
    trustProxy: 1,
    allowedHosts: ['files.example.test'],
    sessionSecret: strongBase.SESSION_SECRET,
    adminAccessDisabled: true,
    mfaEncryptionKey: strongBase.SESSION_SECRET
  }, { httpsEnabled: false }), /hop counts are not accepted/);
});

test('rejects universal proxy ranges and accepts explicit bounded proxy identities', () => {
  for (const value of ['0.0.0.0/0', '::/0', '*']) {
    assert.throws(() => loadConfig({ ...strongBase, TRUST_PROXY: value }), /wildcard or \/0 ranges/);
  }

  const config = loadConfig({
    ...strongBase,
    HTTP_HOST: '127.0.0.1',
    TRUST_PROXY: 'loopback,10.20.30.0/24'
  });
  applyRuntimeConfidentialityPolicy(config, { httpsEnabled: false, httpHost: '127.0.0.1' });
  assert.deepEqual(config.trustProxy, ['loopback', '10.20.30.0/24']);
  assert.equal(config.externallyReachable, true);
  assert.equal(config.requireHttps, true);
});
